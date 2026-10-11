import { z } from "zod";

/**
 * Design-token collection schema. Values are restricted to safe CSS literal forms
 * so tokens (including per-site overrides) can never inject arbitrary CSS.
 */
const name = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/);
const color = z.string().regex(/^#[0-9a-fA-F]{3,8}$|^rgba?\([\d\s.,%]+\)$|^hsla?\([\d\s.,%deg]+\)$/);
const length = z.string().regex(/^(0|-?\d*\.?\d+(px|rem|em|%|vw|vh|ch))(\s+(0|-?\d*\.?\d+(px|rem|em|%|vw|vh|ch))){0,3}$|^clamp\([\d\s.,a-z%+\-*/()]+\)$/);
const fontStack = z.string().regex(/^[A-Za-z0-9 ,"'\-]{1,200}$/);
const shadow = z.string().regex(/^[\w\s.,#()%\-]{1,200}$/).refine((s) => !/url|expression|;|\{|\}/i.test(s));
const duration = z.string().regex(/^\d+(ms|s)$/);
const easing = z.string().regex(/^(linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\([\d\s.,-]+\))$/);

export const DesignTokensSchema = z.object({
  color: z.record(name, color).default({}),
  font: z.record(name, fontStack).default({}),
  fontSize: z.record(name, length).default({}),
  space: z.record(name, length).default({}),
  radius: z.record(name, length).default({}),
  shadow: z.record(name, shadow).default({}),
  duration: z.record(name, duration).default({}),
  easing: z.record(name, easing).default({}),
});
export type DesignTokens = z.infer<typeof DesignTokensSchema>;
export const DesignTokenOverridesSchema = DesignTokensSchema.partial();
export type DesignTokenOverrides = z.infer<typeof DesignTokenOverridesSchema>;

export function mergeTokens(base: DesignTokens, overrides?: Partial<DesignTokens> | null): DesignTokens {
  if (!overrides) return base;
  const out: any = { ...base };
  for (const k of Object.keys(base) as (keyof DesignTokens)[]) out[k] = { ...base[k], ...(overrides[k] ?? {}) };
  return out;
}

/** Emits tokens as CSS custom properties: --zy-color-primary, --zy-space-md, ... */
export function tokensToCss(tokens: DesignTokens, selector = ":root"): string {
  const prefix: Record<keyof DesignTokens, string> = {
    color: "color", font: "font", fontSize: "font-size", space: "space", radius: "radius", shadow: "shadow", duration: "duration", easing: "easing",
  };
  const lines: string[] = [];
  for (const group of Object.keys(prefix) as (keyof DesignTokens)[]) {
    for (const [k, v] of Object.entries(tokens[group] ?? {})) lines.push(`--zy-${prefix[group]}-${k}:${v};`);
  }
  return `${selector}{${lines.join("")}}`;
}
