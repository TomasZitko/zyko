import { z } from "zod";
import type { FieldMap } from "./fields.js";
import type { SafeHtml } from "./html.js";
import { DesignTokensSchema, type DesignTokens } from "./tokens.js";

/** Version of the platform's component/design-system contract. Bump on breaking changes. */
export const PLATFORM_API_VERSION = 1;

export interface ResolvedAsset {
  id: string;
  url: string;
  alt: string;
  width?: number | null;
  height?: number | null;
  mime: string;
}

/** What a component's render function receives besides its props. */
export interface RenderContext {
  /** Rendered HTML of the children in a named slot. */
  slot(name?: string): SafeHtml;
  /** Resolve an asset id to a URL appropriate for the current target (editor, preview, production). */
  asset(id: string | null | undefined): ResolvedAsset | null;
  /** Sanitized link href (blocks javascript: etc.). */
  link(href: unknown): string;
  /** CSS var() reference for a token, e.g. token("color","primary") -> var(--zy-color-primary). */
  token(group: keyof DesignTokens, name: string): string;
  /** Resolves a color field value (hex or token:<name>) to CSS. */
  color(value: unknown): string;
  /** Attributes the editor needs to target a prop for inline editing (empty string outside the editor). */
  editable(prop: string): SafeHtml;
  /** "editor" | "preview" | "production" */
  target: RenderTarget;
  /** Site-level settings available to components (name, locale, nav, ...). */
  site: { name: string; locale: string; pages: { path: string; title: string }[] };
  /** The node's own id (stable; useful for anchors / aria ids). */
  nodeId: string;
}
export type RenderTarget = "editor" | "preview" | "production";

export interface SlotDefinition {
  label: string;
  /** Allowed component types. Omit to allow any. */
  allow?: string[];
  max?: number;
}

/**
 * Component contract. Implementations live in design-system packages that are code-reviewed and
 * bundled at build time (never uploaded at runtime). `render` must be a pure function of its inputs.
 */
export interface ComponentDefinition<P extends Record<string, any> = Record<string, any>> {
  type: string;
  /** Semver. Major bumps require a migration in `migrations`. */
  version: string;
  displayName: string;
  category: string;
  description?: string;
  fields: FieldMap;
  slots?: Record<string, SlotDefinition>;
  defaultProps: P;
  render(props: P, ctx: RenderContext): SafeHtml;
  /** Static CSS for this component. Use class names prefixed with the design system id. */
  css?: string;
  /** migrations[n] upgrades props authored for major n-1 to major n. */
  migrations?: Record<number, (props: Record<string, unknown>) => Record<string, unknown>>;
  /** Guidance consumed by AI tooling and the design engine. */
  ai?: { purpose: string; constraints?: string[] };
  /** Whether the editor offers the hide-on-breakpoint control. */
  responsive?: { hideable?: boolean };
  /** Restrict where it can be placed: root only, nested only, or anywhere (default). */
  placement?: "root" | "nested" | "any";
}

export const DesignSystemMetaSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string().min(1),
  description: z.string().optional(),
  platformApi: z.number().int(),
  status: z.enum(["temporary-fixture", "experimental", "stable", "deprecated"]),
  breakpoints: z.object({ tablet: z.number().int(), desktop: z.number().int() }),
  tokens: DesignTokensSchema,
});

export interface DesignSystemManifest extends z.infer<typeof DesignSystemMetaSchema> {
  /** Global CSS (reset, typography). Must only reference tokens via var(--zy-*). */
  baseCss: string;
  components: ComponentDefinition<any>[];
  /** Optional page templates (structured documents) offered when creating pages. */
  templates?: PageTemplate[];
}

export interface PageTemplate {
  id: string;
  version: string;
  name: string;
  description?: string;
  /** Factory so every use produces fresh node ids. */
  build(): { title: string; path?: string; root: import("./document.js").PageNode[] };
}

export function defineComponent<P extends Record<string, any>>(def: ComponentDefinition<P>): ComponentDefinition<P> {
  return def;
}
export function defineDesignSystem(m: DesignSystemManifest): DesignSystemManifest {
  DesignSystemMetaSchema.parse(m);
  return m;
}

export const majorOf = (semver: string) => Number(semver.split(".")[0]);
