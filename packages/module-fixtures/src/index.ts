/**
 * TEST FIXTURES for the module integration framework. These are NOT business modules.
 * They exercise every extension point (config, records, admin pages, events, webhooks,
 * provider adapters, widgets, migrations, lifecycle hooks) so the framework is verifiable.
 */
import { z } from "zod";
import { defineComponent, defineModule, defineProvider, html } from "@zyko/contracts";

export interface EchoAdapter {
  echo(message: string): Promise<string>;
}

/** Fixture provider: proves the credential + adapter path without contacting a real service. */
export const echoProvider = defineProvider({
  kind: "echo",
  id: "fixture-echo",
  name: "Echo (test fixture)",
  credentialsSchema: z.object({ apiKey: z.string().min(4) }),
  create: (creds): EchoAdapter => ({ echo: async (m) => `echo(${creds.apiKey.slice(0, 2)}…): ${m}` }),
  test: async (a) => ({ ok: (await a.echo("ping")).includes("ping") }),
});

const notesBadge = defineComponent({
  type: "fixture-notes.badge", version: "1.0.0", displayName: "Notes badge (module fixture)", category: "module",
  fields: { label: { type: "text", label: "Label", maxLength: 60, inline: true } },
  defaultProps: { label: "Notes" },
  placement: "nested",
  render: (p, ctx) => html`<span class="fxn-badge"${ctx.editable("label")}>${p.label}</span>`,
  css: ".fxn-badge{display:inline-block;padding:2px 8px;border:1px solid #94a3b8;font-size:12px}",
});

export const notesFixtureModule = defineModule({
  id: "fixture.notes",
  version: "1.1.0",
  name: "Notes (test fixture)",
  description: "Stores simple notes per project. Exists only to test the module framework.",
  platformApi: 1,
  capabilities: ["records", "webhooks.inbound", "events.subscribe", "events.emit", "admin.pages", "site.widgets", "providers"],
  configSchema: z.object({ label: z.string().min(1).max(60).default("Notes"), maxEntries: z.number().int().min(1).max(1000).default(100) }),
  collections: {
    entries: z.object({ title: z.string().min(1).max(200), body: z.string().max(5000).default(""), source: z.enum(["admin", "webhook", "event", "migration"]).default("admin") }).strict(),
    stats: z.object({ publishes: z.number().int().min(0) }).strict(),
  },
  adminPages: [
    { id: "entries", title: "Entries", view: { kind: "records", collection: "entries", columns: [{ key: "title", label: "Title" }, { key: "source", label: "Source" }], allowCreate: true, allowDelete: true } },
    { id: "settings", title: "Settings", view: { kind: "settings" } },
  ],
  widgets: [notesBadge],
  migrations: [
    {
      to: "1.1.0",
      async up(ctx) {
        const existing = await ctx.records.list("stats");
        if (!existing.length) await ctx.records.create("stats", { publishes: 0 });
      },
    },
  ],
  hooks: {
    async onInstall(ctx) {
      await ctx.records.create("stats", { publishes: 0 });
      ctx.log.info("fixture.notes installed");
    },
    async onUninstall(ctx) {
      ctx.log.info("fixture.notes uninstalled");
    },
  },
  events: {
    async "page.published"(ctx) {
      const [s] = await ctx.records.list("stats");
      if (s) await ctx.records.update("stats", s.id, { publishes: Number((s.data as any).publishes ?? 0) + 1 });
    },
  },
  async webhook(ctx, req) {
    const body = z.object({ title: z.string().min(1).max(200), body: z.string().max(5000).optional() }).safeParse(req.body);
    if (!body.success) return { status: 422, body: { error: "invalid payload" } };
    const count = await ctx.records.count("entries");
    if (count >= ctx.installation.config.maxEntries) return { status: 409, body: { error: "limit reached" } };
    const rec = await ctx.records.create("entries", { title: body.data.title, body: body.data.body ?? "", source: "webhook" });
    await ctx.emit("fixture.notes.created", { id: rec.id });
    return { status: 201, body: { id: rec.id } };
  },
});

export const fixtureModules = [notesFixtureModule];
export const fixtureProviders = [echoProvider];
