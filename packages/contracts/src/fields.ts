import { z } from "zod";

/**
 * Property field descriptors. A component declares its editable props with these.
 * The editor builds its property panel from them; the platform derives validation from them.
 * Adding a new field type = add it here, in buildFieldSchema, and in the editor's FieldInput.
 */
export type PropField =
  | { type: "text"; label: string; required?: boolean; maxLength?: number; inline?: boolean; description?: string }
  | { type: "textarea"; label: string; required?: boolean; maxLength?: number; inline?: boolean; description?: string }
  | { type: "number"; label: string; required?: boolean; min?: number; max?: number; step?: number; description?: string }
  | { type: "boolean"; label: string; description?: string }
  | { type: "select"; label: string; options: { value: string; label: string }[]; required?: boolean; description?: string }
  | { type: "color"; label: string; required?: boolean; description?: string }
  | { type: "asset"; label: string; required?: boolean; accept?: ("image" | "video" | "document")[]; description?: string }
  | { type: "url"; label: string; required?: boolean; description?: string }
  | { type: "list"; label: string; item: Record<string, PropField>; maxItems?: number; description?: string };

export type FieldMap = Record<string, PropField>;

const URL_RE = /^(https?:\/\/[^\s]+|mailto:[^\s]+|tel:[+\d\s()-]+|\/(?!\/)[^\s]*|#[\w-]*)$/i;
/** Hex color or a design-token reference like "token:primary". */
const COLOR_RE = /^(#[0-9a-f]{3,8}|token:[a-z][a-z0-9-]{0,40})$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function buildFieldSchema(f: PropField): z.ZodType {
  switch (f.type) {
    case "text":
    case "textarea": {
      let s = z.string().max(f.maxLength ?? (f.type === "text" ? 500 : 10000));
      return f.required ? s.min(1) : s;
    }
    case "number": {
      let s = z.number().finite();
      if (f.min !== undefined) s = s.min(f.min);
      if (f.max !== undefined) s = s.max(f.max);
      return s;
    }
    case "boolean":
      return z.boolean();
    case "select":
      return z.enum(f.options.map((o) => o.value) as [string, ...string[]]);
    case "color":
      return z.string().regex(COLOR_RE, "Must be a hex color or token:<name>");
    case "asset":
      return f.required ? z.string().regex(ID_RE) : z.string().regex(ID_RE).nullable();
    case "url":
      return f.required ? z.string().regex(URL_RE, "Unsupported URL") : z.union([z.literal(""), z.string().regex(URL_RE, "Unsupported URL")]);
    case "list":
      return z.array(buildPropsSchema(f.item)).max(f.maxItems ?? 50);
  }
}

/** Strict schema for a component's props: unknown keys are rejected. Non-required fields are optional. */
export function buildPropsSchema(fields: FieldMap): z.ZodObject<any> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, f] of Object.entries(fields)) {
    const s = buildFieldSchema(f);
    shape[key] = "required" in f && f.required ? s : s.optional();
  }
  return z.object(shape).strict();
}
