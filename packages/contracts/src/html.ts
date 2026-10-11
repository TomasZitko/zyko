/**
 * Safe HTML construction for component renderers.
 * Every interpolated value is escaped unless it is already SafeHtml.
 * Component authors must never build markup by string concatenation.
 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(input: unknown): string {
  return String(input ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

function toHtml(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(toHtml).join("");
  return escapeHtml(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += toHtml(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Mark trusted platform-generated markup as safe. Never pass user input. */
export function unsafeRaw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

const SAFE_URL = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#|\.\/)/i;
/** Returns the URL if it uses an allowed scheme, otherwise "#". Blocks javascript:, data:, protocol-relative. */
export function safeUrl(url: unknown): string {
  const s = String(url ?? "").trim();
  if (s === "") return "#";
  return SAFE_URL.test(s) ? s : "#";
}
