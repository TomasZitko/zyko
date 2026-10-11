import { describe, expect, it } from "vitest";
import { applyOps, DesignRegistry, html, safeUrl, tokensToCss, DesignTokensSchema, checkCompatibility, type PageDocument } from "../src/index.js";
import { fixtureDesignSystem } from "../../design-fixtures/src/index.js";

const doc: PageDocument = {
  schemaVersion: 1,
  root: [{ id: "sec00001", type: "section", v: 1, props: {}, slots: { default: [{ id: "h0000001", type: "heading", v: 1, props: { text: "A" } }] } }],
};

describe("document ops", () => {
  it("round-trips every op through its inverse", () => {
    const ops = [
      { op: "insert", parentId: "sec00001", slot: "default", index: 1, node: { id: "t0000001", type: "text", v: 1, props: { body: "x" } } },
      { op: "move", nodeId: "t0000001", parentId: "sec00001", slot: "default", index: 0 },
      { op: "update_props", nodeId: "h0000001", props: { text: "B", level: "h1" } },
      { op: "set_layout", nodeId: "h0000001", layout: { hideOn: ["mobile"] } },
      { op: "remove", nodeId: "h0000001" },
    ] as const;
    const { doc: after, inverse } = applyOps(doc, ops as any);
    expect(after.root[0].slots!.default.map((n) => n.id)).toEqual(["t0000001"]);
    expect(applyOps(after, inverse).doc).toEqual(doc);
  });
  it("rejects structural errors", () => {
    expect(() => applyOps(doc, [{ op: "move", nodeId: "sec00001", parentId: "h0000001", index: 0 } as any])).toThrow(/into itself/);
    expect(() => applyOps(doc, [{ op: "insert", parentId: null, index: 0, node: { id: "h0000001", type: "x", v: 1, props: {} } } as any])).toThrow(/Duplicate/);
    expect(() => applyOps(doc, [{ op: "remove", nodeId: "missing1" }])).toThrow(/not found/);
  });
});

describe("registry", () => {
  const reg = new DesignRegistry();
  reg.register(fixtureDesignSystem);
  it("validates props, types and placement", () => {
    expect(reg.validateDocument("fixture-neutral", "0.1.0", doc)).toEqual([]);
    const bad = structuredClone(doc);
    bad.root[0].slots!.default[0].props = { text: "x", extra: 1 };
    bad.root.push({ id: "unk00001", type: "nope", v: 1, props: {} });
    const issues = reg.validateDocument("fixture-neutral", "0.1.0", bad).map((i) => i.message).join("|");
    expect(issues).toMatch(/Unrecognized key/);
    expect(issues).toMatch(/Unknown component type "nope"/);
  });
  it("rejects incompatible manifests", () => {
    expect(checkCompatibility({ ...fixtureDesignSystem, platformApi: 99 })).not.toEqual([]);
    const broken = { ...fixtureDesignSystem, components: [{ ...fixtureDesignSystem.components[0], version: "2.0.0" }] };
    expect(checkCompatibility(broken).join()).toMatch(/missing migration/);
  });
  it("migrates nodes across majors", () => {
    const r = new DesignRegistry();
    const heading = fixtureDesignSystem.components.find((c) => c.type === "heading")!;
    r.register({ ...fixtureDesignSystem, components: [{ ...heading, version: "2.0.0", migrations: { 2: (p) => ({ ...p, text: String(p.title ?? p.text) }) } }] });
    expect(r.migrateNode("fixture-neutral", "0.1.0", { id: "h0000001", type: "heading", v: 1, props: { title: "Old" } }).props.text).toBe("Old");
  });
});

describe("safety helpers", () => {
  it("escapes interpolations and blocks dangerous URLs", () => {
    expect(html`<p>${"<script>"}</p>`.value).toBe("<p>&lt;script&gt;</p>");
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("//evil.com")).toBe("#");
    expect(safeUrl("/about")).toBe("/about");
  });
  it("rejects CSS injection in tokens", () => {
    expect(DesignTokensSchema.safeParse({ color: { a: "red;}body{display:none" } }).success).toBe(false);
    expect(tokensToCss(DesignTokensSchema.parse({ color: { primary: "#fff" } }))).toContain("--zy-color-primary:#fff;");
  });
});
