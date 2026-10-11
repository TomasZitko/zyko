/**
 * Script injected into the sandboxed editor canvas iframe (sandbox="allow-scripts", no same-origin).
 * It knows nothing about specific components: it only uses the data-zyko-node / data-zyko-prop
 * attributes the renderer emits, so any registered design system works in the editor unchanged.
 * Protocol (postMessage):
 *   parent -> canvas: {type:"zyko:render", body, css, selectedId}
 *   canvas -> parent: {type:"zyko:ready"} | {type:"zyko:select", nodeId} | {type:"zyko:inline-edit", nodeId, prop, value}
 */
export const EDITOR_BRIDGE_SCRIPT = `(() => {
  const post = (m) => parent.postMessage(m, "*");
  let selected = null;
  const style = document.createElement("style");
  style.textContent = '[data-zyko-node]>*{cursor:default}[data-zyko-node].zy-hover>*:first-child{outline:1px dashed #64748b;outline-offset:2px}[data-zyko-node].zy-selected>*:first-child{outline:2px solid #2563eb;outline-offset:2px}[data-zyko-prop][contenteditable]{outline:2px solid #f59e0b!important;cursor:text}.zy-missing{padding:12px;border:1px dashed #dc2626;color:#dc2626;font:13px system-ui}';
  document.head.appendChild(style);
  const nodeOf = (el) => el && el.closest ? el.closest("[data-zyko-node]") : null;
  function applySelection() {
    document.querySelectorAll(".zy-selected").forEach((e) => e.classList.remove("zy-selected"));
    if (!selected) return;
    const el = document.querySelector('[data-zyko-node="' + CSS.escape(selected) + '"]');
    if (el) el.classList.add("zy-selected");
  }
  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type !== "zyko:render") return;
    const sy = window.scrollY;
    document.getElementById("zyko-css").textContent = m.css;
    if (!document.querySelector("[contenteditable]")) document.getElementById("zyko-root").innerHTML = m.body;
    selected = m.selectedId || null;
    applySelection();
    window.scrollTo(0, sy);
  });
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a,button,form");
    if (a) e.preventDefault();
    if (e.target.closest && e.target.closest("[contenteditable]")) return;
    const n = nodeOf(e.target);
    selected = n ? n.getAttribute("data-zyko-node") : null;
    applySelection();
    post({ type: "zyko:select", nodeId: selected });
  }, true);
  document.addEventListener("submit", (e) => e.preventDefault(), true);
  document.addEventListener("mouseover", (e) => {
    document.querySelectorAll(".zy-hover").forEach((x) => x.classList.remove("zy-hover"));
    const n = nodeOf(e.target);
    if (n) n.classList.add("zy-hover");
  });
  document.addEventListener("dblclick", (e) => {
    const p = e.target.closest && e.target.closest("[data-zyko-prop]");
    if (!p) return;
    const n = nodeOf(p);
    if (!n) return;
    e.preventDefault();
    p.setAttribute("contenteditable", "plaintext-only");
    p.focus();
    const done = () => {
      p.removeEventListener("blur", done);
      p.removeAttribute("contenteditable");
      post({ type: "zyko:inline-edit", nodeId: n.getAttribute("data-zyko-node"), prop: p.getAttribute("data-zyko-prop"), value: p.textContent || "" });
    };
    p.addEventListener("blur", done);
    p.addEventListener("keydown", (k) => { if (k.key === "Escape" || (k.key === "Enter" && !k.shiftKey)) { k.preventDefault(); p.blur(); } });
  });
  post({ type: "zyko:ready" });
})();`;

/** Builds the canvas iframe document. CSP blocks network access except images. */
export function editorCanvasDocument(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src * data:">
<style id="zyko-css"></style></head><body><div id="zyko-root"></div><script>${EDITOR_BRIDGE_SCRIPT}</script></body></html>`;
}
