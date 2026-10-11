import { buildPropsSchema } from "./fields.js";
import { PLATFORM_API_VERSION, majorOf, type ComponentDefinition, type DesignSystemManifest } from "./components.js";
import { PageDocumentSchema, walk, type PageDocument, type PageNode } from "./document.js";

export interface ValidationIssue {
  nodeId?: string;
  path: string;
  message: string;
}

export class RegistryError extends Error {}

interface Entry {
  manifest: DesignSystemManifest;
  components: Map<string, { def: ComponentDefinition; schema: ReturnType<typeof buildPropsSchema> }>;
}

/**
 * Design-system registry: loads manifests, checks compatibility, validates and migrates documents.
 * Shared by the API (validation, publishing) and the web editor (rendering, property panels).
 */
export class DesignRegistry {
  private systems = new Map<string, Entry>();

  register(manifest: DesignSystemManifest, extraComponents: ComponentDefinition[] = []): void {
    const problems = checkCompatibility(manifest);
    if (problems.length) throw new RegistryError(`Design system ${manifest.id}@${manifest.version} rejected: ${problems.join("; ")}`);
    const key = `${manifest.id}@${majorOf(manifest.version)}`;
    const components = new Map<string, Entry["components"] extends Map<string, infer V> ? V : never>();
    for (const def of [...manifest.components, ...extraComponents]) {
      if (components.has(def.type)) throw new RegistryError(`Duplicate component type ${def.type} in ${manifest.id}`);
      components.set(def.type, { def, schema: buildPropsSchema(def.fields) });
    }
    this.systems.set(key, { manifest, components });
  }

  list(): DesignSystemManifest[] {
    return [...this.systems.values()].map((e) => e.manifest);
  }

  /** Resolves by id and version; minor/patch upgrades are transparent within a major. */
  get(id: string, version: string): DesignSystemManifest {
    return this.entry(id, version).manifest;
  }

  private entry(id: string, version: string): Entry {
    const e = this.systems.get(`${id}@${majorOf(version)}`);
    if (!e) throw new RegistryError(`Design system ${id}@${version} is not registered`);
    return e;
  }

  component(dsId: string, dsVersion: string, type: string): ComponentDefinition | null {
    return this.entry(dsId, dsVersion).components.get(type)?.def ?? null;
  }

  /** Brings node props up to the component's current major using its migrations. */
  migrateNode(dsId: string, dsVersion: string, node: PageNode): PageNode {
    const c = this.entry(dsId, dsVersion).components.get(node.type);
    if (!c) return node;
    const target = majorOf(c.def.version);
    let props = node.props;
    for (let v = node.v + 1; v <= target; v++) {
      const m = c.def.migrations?.[v];
      if (!m) throw new RegistryError(`${node.type}: missing migration to v${v}`);
      props = m(props);
    }
    return { ...node, v: target, props };
  }

  migrateDocument(dsId: string, dsVersion: string, doc: PageDocument): PageDocument {
    const fix = (nodes: PageNode[]): PageNode[] =>
      nodes.map((n) => {
        const m = this.migrateNode(dsId, dsVersion, n);
        return m.slots ? { ...m, slots: Object.fromEntries(Object.entries(m.slots).map(([k, v]) => [k, fix(v)])) } : m;
      });
    return { ...doc, root: fix(doc.root) };
  }

  /** Full document validation: shape, unique ids, known components, versions, props, slots, placement. */
  validateDocument(dsId: string, dsVersion: string, doc: unknown): ValidationIssue[] {
    const shape = PageDocumentSchema.safeParse(doc);
    if (!shape.success) return shape.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const entry = this.entry(dsId, dsVersion);
    const issues: ValidationIssue[] = [];
    const ids = new Set<string>();
    let count = 0;
    const visit = (nodes: PageNode[], path: string, parent: { def: ComponentDefinition; slot: string } | null) => {
      nodes.forEach((n, i) => {
        const p = `${path}[${i}]`;
        count++;
        if (ids.has(n.id)) issues.push({ nodeId: n.id, path: p, message: "Duplicate node id" });
        ids.add(n.id);
        const c = entry.components.get(n.type);
        if (!c) {
          issues.push({ nodeId: n.id, path: p, message: `Unknown component type "${n.type}"` });
          return;
        }
        const major = majorOf(c.def.version);
        if (n.v > major) issues.push({ nodeId: n.id, path: p, message: `Component version v${n.v} is newer than registered v${major}` });
        const res = c.schema.safeParse(n.props);
        if (!res.success) for (const iss of res.error.issues) issues.push({ nodeId: n.id, path: `${p}.props.${iss.path.join(".")}`, message: iss.message });
        if (parent === null && c.def.placement === "nested") issues.push({ nodeId: n.id, path: p, message: `${n.type} cannot be placed at the page root` });
        if (parent !== null && c.def.placement === "root") issues.push({ nodeId: n.id, path: p, message: `${n.type} can only be placed at the page root` });
        if (parent) {
          const slotDef = parent.def.slots?.[parent.slot];
          if (slotDef?.allow && !slotDef.allow.includes(n.type)) issues.push({ nodeId: n.id, path: p, message: `${n.type} not allowed in slot ${parent.slot}` });
        }
        for (const [slot, children] of Object.entries(n.slots ?? {})) {
          const sd = c.def.slots?.[slot];
          if (!sd) {
            issues.push({ nodeId: n.id, path: `${p}.slots.${slot}`, message: `${n.type} has no slot "${slot}"` });
            continue;
          }
          if (sd.max !== undefined && children.length > sd.max) issues.push({ nodeId: n.id, path: `${p}.slots.${slot}`, message: `Slot ${slot} allows at most ${sd.max} children` });
          visit(children, `${p}.slots.${slot}`, { def: c.def, slot });
        }
      });
    };
    visit((shape.data as PageDocument).root, "root", null);
    if (count > 2000) issues.push({ path: "root", message: "Document exceeds 2000 nodes" });
    return issues;
  }

  /** Builds a node with default props for a component type. */
  createNode(dsId: string, dsVersion: string, type: string, id: string, props?: Record<string, unknown>): PageNode {
    const c = this.component(dsId, dsVersion, type);
    if (!c) throw new RegistryError(`Unknown component type ${type}`);
    const node: PageNode = { id, type, v: majorOf(c.version), props: { ...structuredClone(c.defaultProps), ...(props ?? {}) } };
    if (c.slots) node.slots = Object.fromEntries(Object.keys(c.slots).map((s) => [s, []]));
    return node;
  }

  /** Compact machine-readable catalogue (used by AI tools and the editor's insert menu). */
  catalogue(dsId: string, dsVersion: string) {
    const e = this.entry(dsId, dsVersion);
    return [...e.components.values()].map(({ def }) => ({
      type: def.type,
      version: def.version,
      displayName: def.displayName,
      category: def.category,
      description: def.description,
      fields: def.fields,
      slots: def.slots,
      placement: def.placement ?? "any",
      ai: def.ai,
    }));
  }
}

/** Compatibility checks performed at registration time. */
export function checkCompatibility(m: DesignSystemManifest): string[] {
  const problems: string[] = [];
  if (m.platformApi !== PLATFORM_API_VERSION) problems.push(`platformApi ${m.platformApi} unsupported (platform is ${PLATFORM_API_VERSION})`);
  for (const c of m.components) {
    if (!/^[a-z][a-z0-9.-]{0,80}$/.test(c.type)) problems.push(`invalid component type "${c.type}"`);
    if (!/^\d+\.\d+\.\d+$/.test(c.version)) problems.push(`${c.type}: invalid version`);
    const major = majorOf(c.version);
    for (let v = 2; v <= major; v++) if (!c.migrations?.[v]) problems.push(`${c.type}: missing migration for major ${v}`);
    const res = buildPropsSchema(c.fields).safeParse(c.defaultProps);
    if (!res.success) problems.push(`${c.type}: defaultProps do not satisfy fields (${res.error.issues[0]?.message})`);
    if (c.css && /@import|url\(\s*['"]?(?!data:)/i.test(c.css)) problems.push(`${c.type}: css may not import external resources`);
  }
  if (/@import/i.test(m.baseCss)) problems.push("baseCss may not use @import");
  return problems;
}
