/**
 * TEMPORARY TEST FIXTURE — NOT A PRODUCT DESIGN SYSTEM.
 * Exists only to prove registration, editing, rendering and publishing end to end.
 * Visuals are intentionally plain. Replace with the owner-directed design system(s); see
 * docs/INTEGRATION-CONTRACTS.md §1-§3.
 */
import { defineComponent, defineDesignSystem, html, newNodeId } from "@zyko/contracts";

const section = defineComponent({
  type: "section", version: "1.0.0", displayName: "Section (fixture)", category: "layout",
  description: "Generic container with a content slot.",
  fields: { background: { type: "color", label: "Background" }, padding: { type: "select", label: "Padding", options: [{ value: "sm", label: "Small" }, { value: "md", label: "Medium" }, { value: "lg", label: "Large" }] } },
  slots: { default: { label: "Content" } },
  defaultProps: { background: "token:surface", padding: "md" },
  placement: "root",
  responsive: { hideable: true },
  ai: { purpose: "Groups content blocks into a page section." },
  render: (p, ctx) => html`<section class="fx-section fx-pad-${p.padding}" style="background:${ctx.color(p.background)}"><div class="fx-wrap">${ctx.slot()}</div></section>`,
  css: ".fx-section{width:100%}.fx-wrap{max-width:960px;margin:0 auto;padding:0 var(--zy-space-md)}.fx-pad-sm{padding:var(--zy-space-sm) 0}.fx-pad-md{padding:var(--zy-space-lg) 0}.fx-pad-lg{padding:var(--zy-space-xl) 0}",
});

const heading = defineComponent({
  type: "heading", version: "1.0.0", displayName: "Heading (fixture)", category: "content",
  fields: { text: { type: "text", label: "Text", required: true, maxLength: 200, inline: true }, level: { type: "select", label: "Level", options: [{ value: "h1", label: "H1" }, { value: "h2", label: "H2" }, { value: "h3", label: "H3" }] } },
  defaultProps: { text: "Heading", level: "h2" },
  placement: "nested",
  responsive: { hideable: true },
  ai: { purpose: "A section or page heading.", constraints: ["Use exactly one h1 per page."] },
  render: (p, ctx) => {
    const attrs = ctx.editable("text");
    if (p.level === "h1") return html`<h1 class="fx-h"${attrs}>${p.text}</h1>`;
    if (p.level === "h3") return html`<h3 class="fx-h"${attrs}>${p.text}</h3>`;
    return html`<h2 class="fx-h"${attrs}>${p.text}</h2>`;
  },
  css: ".fx-h{font-family:var(--zy-font-heading);margin:0 0 var(--zy-space-sm)}",
});

const text = defineComponent({
  type: "text", version: "1.0.0", displayName: "Text (fixture)", category: "content",
  fields: { body: { type: "textarea", label: "Body", maxLength: 5000, inline: true } },
  defaultProps: { body: "Text" },
  placement: "nested",
  responsive: { hideable: true },
  ai: { purpose: "A paragraph of plain text." },
  render: (p, ctx) => html`<p class="fx-p"${ctx.editable("body")}>${p.body}</p>`,
  css: ".fx-p{margin:0 0 var(--zy-space-sm);white-space:pre-line}",
});

const image = defineComponent({
  type: "image", version: "1.0.0", displayName: "Image (fixture)", category: "media",
  fields: { asset: { type: "asset", label: "Image", accept: ["image"] }, alt: { type: "text", label: "Alt text", maxLength: 300 } },
  defaultProps: { asset: null, alt: "" },
  placement: "nested",
  responsive: { hideable: true },
  ai: { purpose: "An image from the project's asset library." },
  render: (p, ctx) => {
    const a = ctx.asset(p.asset);
    if (!a) return ctx.target === "editor" ? html`<div class="fx-img-empty">No image selected</div>` : html``;
    return html`<img class="fx-img" src="${a.url}" alt="${p.alt || a.alt}" ${a.width ? html`width="${a.width}" height="${a.height}"` : ""} loading="lazy" decoding="async">`;
  },
  css: ".fx-img{max-width:100%;height:auto;display:block}.fx-img-empty{padding:24px;border:1px dashed #94a3b8;color:#64748b;text-align:center}",
});

const button = defineComponent({
  type: "button", version: "1.0.0", displayName: "Button (fixture)", category: "content",
  fields: { label: { type: "text", label: "Label", required: true, maxLength: 80, inline: true }, href: { type: "url", label: "Link" } },
  defaultProps: { label: "Button", href: "#" },
  placement: "nested",
  ai: { purpose: "A link styled as a button." },
  render: (p, ctx) => html`<a class="fx-btn" href="${ctx.link(p.href)}"${ctx.editable("label")}>${p.label}</a>`,
  css: ".fx-btn{display:inline-block;padding:8px 16px;border:1px solid currentColor;text-decoration:none;color:var(--zy-color-text)}",
});

const nav = defineComponent({
  type: "site-nav", version: "1.0.0", displayName: "Site navigation (fixture)", category: "navigation",
  fields: {},
  defaultProps: {},
  placement: "root",
  ai: { purpose: "Lists the site's pages as links." },
  render: (_p, ctx) => html`<nav class="fx-nav"><strong>${ctx.site.name}</strong> ${ctx.site.pages.map((pg) => html`<a href="${ctx.link(pg.path)}">${pg.title}</a> `)}</nav>`,
  css: ".fx-nav{display:flex;gap:16px;padding:12px var(--zy-space-md);border-bottom:1px solid #e2e8f0}.fx-nav a{color:inherit}",
});

export const fixtureDesignSystem = defineDesignSystem({
  id: "fixture-neutral",
  version: "0.1.0",
  name: "Neutral test fixture",
  description: "Temporary, intentionally unstyled components used to verify the platform. Not for production sites.",
  platformApi: 1,
  status: "temporary-fixture",
  breakpoints: { tablet: 768, desktop: 1024 },
  tokens: {
    color: { text: "#111827", surface: "#ffffff", muted: "#f3f4f6" },
    font: { body: "system-ui, sans-serif", heading: "system-ui, sans-serif" },
    fontSize: {}, space: { sm: "8px", md: "16px", lg: "32px", xl: "64px" }, radius: {}, shadow: {}, duration: {}, easing: {},
  },
  baseCss: "*,*::before,*::after{box-sizing:border-box}body{margin:0;font-family:var(--zy-font-body);color:var(--zy-color-text);line-height:1.5}",
  components: [section, heading, text, image, button, nav],
  templates: [
    {
      id: "blank-with-heading", version: "1.0.0", name: "Single section (fixture)",
      build: () => ({
        title: "Home",
        root: [
          { id: newNodeId(), type: "site-nav", v: 1, props: {} },
          { id: newNodeId(), type: "section", v: 1, props: { background: "token:surface", padding: "md" }, slots: { default: [
            { id: newNodeId(), type: "heading", v: 1, props: { text: "Welcome", level: "h1" } },
            { id: newNodeId(), type: "text", v: 1, props: { body: "This page uses temporary fixture components." } },
          ] } },
        ],
      }),
    },
  ],
});
