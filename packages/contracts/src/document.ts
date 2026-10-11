import { z } from "zod";

/**
 * Page composition schema (v1).
 * A page is a tree of component nodes. Nodes reference components by `type` within the
 * website's active design system; `v` pins the component's major version used to author the props.
 */
export const BREAKPOINTS = ["mobile", "tablet", "desktop"] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

export interface PageNode {
  id: string;
  type: string;
  v: number;
  props: Record<string, unknown>;
  slots?: Record<string, PageNode[]>;
  layout?: { hideOn?: Breakpoint[] };
}

export const NodeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/);

export const PageNodeSchema: z.ZodType<PageNode> = z.lazy(() =>
  z.object({
    id: NodeIdSchema,
    type: z.string().regex(/^[a-z][a-z0-9.-]{0,80}$/),
    v: z.number().int().min(1),
    props: z.record(z.string(), z.unknown()),
    slots: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,40}$/), z.array(PageNodeSchema)).optional(),
    layout: z.object({ hideOn: z.array(z.enum(BREAKPOINTS)).optional() }).strict().optional(),
  }).strict(),
);

export const PageDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  root: z.array(PageNodeSchema).max(500),
});
export type PageDocument = z.infer<typeof PageDocumentSchema>;

export const emptyDocument = (): PageDocument => ({ schemaVersion: 1, root: [] });

/** Structured edit operations. Shared by the visual editor, AI tools and the API. */
const Parent = { parentId: NodeIdSchema.nullable(), slot: z.string().optional() };
export const EditOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert"), ...Parent, index: z.number().int().min(0), node: PageNodeSchema }),
  z.object({ op: z.literal("remove"), nodeId: NodeIdSchema }),
  z.object({ op: z.literal("move"), nodeId: NodeIdSchema, ...Parent, index: z.number().int().min(0) }),
  z.object({ op: z.literal("update_props"), nodeId: NodeIdSchema, props: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal("set_layout"), nodeId: NodeIdSchema, layout: z.object({ hideOn: z.array(z.enum(BREAKPOINTS)).optional() }).strict() }),
]);
export type EditOp = z.infer<typeof EditOpSchema>;
export const EditOpsSchema = z.array(EditOpSchema).min(1).max(200);

export class DocumentOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentOpError";
  }
}

type Loc = { list: PageNode[]; index: number; parent: PageNode | null; slot?: string };

export function walk(nodes: PageNode[], fn: (n: PageNode, parent: PageNode | null) => void, parent: PageNode | null = null) {
  for (const n of nodes) {
    fn(n, parent);
    for (const children of Object.values(n.slots ?? {})) walk(children, fn, n);
  }
}

export function findNode(doc: PageDocument, id: string): PageNode | null {
  let found: PageNode | null = null;
  walk(doc.root, (n) => {
    if (n.id === id) found = n;
  });
  return found;
}

function locate(nodes: PageNode[], id: string, parent: PageNode | null = null, slot?: string): Loc | null {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return { list: nodes, index: i, parent, slot };
    for (const [s, children] of Object.entries(nodes[i].slots ?? {})) {
      const r = locate(children, id, nodes[i], s);
      if (r) return r;
    }
  }
  return null;
}

function targetList(doc: PageDocument, parentId: string | null, slot?: string): PageNode[] {
  if (parentId === null) return doc.root;
  const parent = findNode(doc, parentId);
  if (!parent) throw new DocumentOpError(`Parent node ${parentId} not found`);
  const s = slot ?? "default";
  parent.slots ??= {};
  parent.slots[s] ??= [];
  return parent.slots[s];
}

function isDescendant(node: PageNode, id: string): boolean {
  let hit = false;
  walk(Object.values(node.slots ?? {}).flat(), (n) => {
    if (n.id === id) hit = true;
  });
  return hit;
}

const clone = <T>(v: T): T => structuredClone(v);

/** Computes the inverse of `op` against `doc` (the state BEFORE the op is applied). Used for undo. */
export function invertOp(doc: PageDocument, op: EditOp): EditOp {
  switch (op.op) {
    case "insert":
      return { op: "remove", nodeId: op.node.id };
    case "remove": {
      const loc = locate(doc.root, op.nodeId);
      if (!loc) throw new DocumentOpError(`Node ${op.nodeId} not found`);
      return { op: "insert", parentId: loc.parent?.id ?? null, slot: loc.slot, index: loc.index, node: clone(loc.list[loc.index]) };
    }
    case "move": {
      const loc = locate(doc.root, op.nodeId);
      if (!loc) throw new DocumentOpError(`Node ${op.nodeId} not found`);
      return { op: "move", nodeId: op.nodeId, parentId: loc.parent?.id ?? null, slot: loc.slot, index: loc.index };
    }
    case "update_props": {
      const n = findNode(doc, op.nodeId);
      if (!n) throw new DocumentOpError(`Node ${op.nodeId} not found`);
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(op.props)) prev[k] = k in n.props ? clone(n.props[k]) : null;
      return { op: "update_props", nodeId: op.nodeId, props: prev };
    }
    case "set_layout": {
      const n = findNode(doc, op.nodeId);
      if (!n) throw new DocumentOpError(`Node ${op.nodeId} not found`);
      return { op: "set_layout", nodeId: op.nodeId, layout: clone(n.layout ?? {}) };
    }
  }
}

/** Applies one op immutably. Structural validity only; component/prop validation is the registry's job. */
export function applyOp(input: PageDocument, op: EditOp): PageDocument {
  const doc = clone(input);
  switch (op.op) {
    case "insert": {
      const ids = new Set<string>();
      walk(doc.root, (n) => ids.add(n.id));
      walk([op.node], (n) => {
        if (ids.has(n.id)) throw new DocumentOpError(`Duplicate node id ${n.id}`);
        ids.add(n.id);
      });
      const list = targetList(doc, op.parentId, op.slot);
      if (op.index > list.length) throw new DocumentOpError("Insert index out of range");
      list.splice(op.index, 0, clone(op.node));
      break;
    }
    case "remove": {
      const loc = locate(doc.root, op.nodeId);
      if (!loc) throw new DocumentOpError(`Node ${op.nodeId} not found`);
      loc.list.splice(loc.index, 1);
      break;
    }
    case "move": {
      const loc = locate(doc.root, op.nodeId);
      if (!loc) throw new DocumentOpError(`Node ${op.nodeId} not found`);
      const node = loc.list[loc.index];
      if (op.parentId && (op.parentId === node.id || isDescendant(node, op.parentId))) throw new DocumentOpError("Cannot move a node into itself");
      loc.list.splice(loc.index, 1);
      const list = targetList(doc, op.parentId, op.slot);
      if (op.index > list.length) throw new DocumentOpError("Move index out of range");
      list.splice(op.index, 0, node);
      break;
    }
    case "update_props": {
      const n = findNode(doc, op.nodeId);
      if (!n) throw new DocumentOpError(`Node ${op.nodeId} not found`);
      for (const [k, v] of Object.entries(op.props)) {
        if (v === null) delete n.props[k];
        else n.props[k] = clone(v);
      }
      break;
    }
    case "set_layout": {
      const n = findNode(doc, op.nodeId);
      if (!n) throw new DocumentOpError(`Node ${op.nodeId} not found`);
      n.layout = clone(op.layout);
      if (!n.layout.hideOn?.length) delete n.layout;
      break;
    }
  }
  return doc;
}

/** Applies ops in order, returning the new document and the inverse ops (in undo order). */
export function applyOps(doc: PageDocument, ops: EditOp[]): { doc: PageDocument; inverse: EditOp[] } {
  let cur = doc;
  const inverse: EditOp[] = [];
  for (const op of ops) {
    inverse.unshift(invertOp(cur, op));
    cur = applyOp(cur, op);
  }
  return { doc: cur, inverse };
}

export function newNodeId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return "n" + Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14);
}
