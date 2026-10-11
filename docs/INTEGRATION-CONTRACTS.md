# Integration contracts

How to plug the reserved, owner-directed systems into the platform **without changing the platform core**.
Every contract here is implemented and exercised by tests today. Only temporary fixtures are registered.

| # | You are adding | Contract (code) | Registered in | Proven by |
|---|---|---|---|---|
| 1 | Custom website component | `ComponentDefinition` — `packages/contracts/src/components.ts` | a design-system manifest | `packages/contracts/test`, e2e editor flow |
| 2 | Page template | `PageTemplate` — same file | `DesignSystemManifest.templates` | `test/platform.test.ts` (template page creation) |
| 3 | Design-token collection | `DesignTokensSchema` — `packages/contracts/src/tokens.ts` | `DesignSystemManifest.tokens` (+ per-site `tokenOverrides`) | contracts tests (CSS-injection rejection) |
| 4 | Design reference library | `design_references` table + `/api/projects/:id/design-references` | data, not code | — (CRUD + tenant checks) |
| 5 | AI design-generation engine | `DesignEngine` — `packages/contracts/src/ai.ts` | `registerDesignEngine()` — `apps/api/src/registry.ts` | `test/integration-points.test.ts` |
| 6 | Booking module | `ModuleDefinition` — `packages/contracts/src/modules.ts` | `registerModule()` | `test/platform.test.ts` › module framework |
| 7 | Calendar integration | `ProviderDefinition` (kind `calendar`) | `registerProvider()` | integrations test (fixture `echo` provider) |
| 8 | Business administration module | `ModuleDefinition.adminPages` | `registerModule()` | module framework test + Modules UI |
| 9 | Custom widget | `ModuleDefinition.widgets` (`ComponentDefinition`) | module registration | widget gating test |
| 10 | External service provider | `ProviderDefinition` | `registerProvider()` | integrations test |

**Golden rules (all integrations)**

1. **Code is registered at build time, never uploaded at runtime.** Design systems, modules and providers are reviewed packages imported in `apps/api/src/registry.ts` (server) and `apps/web/src/lib/registry.ts` (editor canvas). This is what keeps arbitrary code out of the SaaS backend.
2. **Everything that writes project data goes through validated operations.** Page content changes only via `EditOp`s through `applyPageOps()` (registry validation + revision + optimistic concurrency). Module data only via the installation-scoped `ModuleContext`.
3. **Customer sites are static output.** Components render to HTML strings at publish time; the sites edge only serves files.
4. **Breaking contract changes bump `PLATFORM_API_VERSION`** (`components.ts`); registration rejects mismatched manifests/modules.

---

## 1. Custom website component

**Required files** — inside a design-system package (e.g. `packages/design-<name>/src/components/<type>.ts`), exported through its manifest.

**Interface** — `ComponentDefinition<P>`:

| Field | Purpose |
|---|---|
| `type` | Stable id within the design system, `^[a-z][a-z0-9.-]*$`. Never rename; add a new type instead. |
| `version` | Semver. A **major** bump requires `migrations[major]`. |
| `fields` | `Record<string, PropField>` — drives the editor property panel **and** server validation (strict: unknown props rejected). Types: `text`, `textarea`, `number`, `boolean`, `select`, `color` (hex or `token:<name>`), `asset`, `url` (blocks `javascript:`), `list`. Set `inline: true` on text fields to enable double-click editing on the canvas. |
| `slots` | Named child areas, optional `allow` list and `max`. |
| `defaultProps` | Must satisfy `fields` (checked at registration). |
| `render(props, ctx)` | Pure; returns `SafeHtml` built with the `html` tagged template (auto-escapes). Use `ctx.slot()`, `ctx.asset(id)`, `ctx.link(href)`, `ctx.color(v)`, `ctx.token(group,name)`, and spread `ctx.editable("prop")` on the element holding an inline-editable prop. |
| `css` | Static CSS; reference tokens only through `var(--zy-…)`; no `@import` / external `url()` (rejected). |
| `placement` | `root` / `nested` / `any`. |
| `responsive.hideable` | Enables per-breakpoint visibility (`layout.hideOn`). |
| `ai` | Purpose/constraints surfaced to the assistant and design engine via `list_components`. |

**Registration** — add it to `components: [...]` of a `defineDesignSystem({...})` manifest. Registration (`DesignRegistry.register`) runs `checkCompatibility()`: platform API, semver, migration coverage, defaults validity, CSS restrictions.

**Data dependencies** — reads only props, child slots, assets (via `ctx.asset`, which resolves only assets owned by the same project — enforced at write time in `validateDocumentFor`) and `ctx.site` (name, locale, page list).

**Versioning** — nodes store `v` (the major used when authored). Rendering and restore call `registry.migrateDocument()`, applying `migrations[n]` stepwise. Minor/patch changes must be backwards compatible with stored props.

**Security** — never use `unsafeRaw()` with user data; all URLs via `ctx.link`; no inline event handlers; no `<script>`. Published pages are served with `script-src 'self'`.

**Testing** — unit: render with fixture props, assert escaping; `registry.validateDocument()` for valid and invalid props; a migration test if you bumped a major. E2E: insert via the editor's Insert menu and edit a property.

**Example**

```ts
import { defineComponent, html } from "@zyko/contracts";

export const quote = defineComponent({
  type: "quote", version: "1.0.0", displayName: "Quote", category: "content",
  fields: {
    text: { type: "textarea", label: "Quote", required: true, maxLength: 600, inline: true },
    author: { type: "text", label: "Author", maxLength: 120 },
    photo: { type: "asset", label: "Photo", accept: ["image"] },
  },
  defaultProps: { text: "…", author: "", photo: null },
  placement: "nested",
  render: (p, ctx) => {
    const img = ctx.asset(p.photo);
    return html`<figure class="ds-quote"><blockquote${ctx.editable("text")}>${p.text}</blockquote>
      ${img ? html`<img src="${img.url}" alt="${img.alt}">` : ""}<figcaption>${p.author}</figcaption></figure>`;
  },
  css: ".ds-quote{margin:0;padding:var(--zy-space-lg)}",
  ai: { purpose: "Customer testimonial or pull quote." },
});
```

## 2. Page template

**Required files** — `packages/design-<name>/src/templates/<id>.ts`.
**Interface** — `PageTemplate { id, version, name, description?, build(): { title, path?, root: PageNode[] } }`. `build()` must create **fresh node ids** (`newNodeId()`) every call.
**Registration** — `templates: [...]` on the design-system manifest. Surfaced at `GET /api/projects/:id/design-system` and in the editor's "+ Page → Start from" menu; `POST /api/projects/:id/pages {templateId}` instantiates it. New projects use the first template of the default design system.
**Data dependencies / versioning** — the built document is validated like any other write. Templates are copied on use (no live link), so updating a template never mutates existing pages.
**Testing** — `registry.validateDocument(id, version, { schemaVersion: 1, root: tpl.build().root })` returns `[]`; two `build()` calls produce disjoint ids.

## 3. Design-token collection

**Interface** — `DesignTokens` groups: `color`, `font`, `fontSize`, `space`, `radius`, `shadow`, `duration`, `easing`. Names `^[a-z][a-z0-9-]*$`. Values are restricted by regex to safe CSS literals, so tokens and per-site overrides cannot inject CSS.
**Registration** — `tokens` on the manifest; emitted as `--zy-<group>-<name>` custom properties (`tokensToCss`). Per-website overrides live in `websites.settings.tokenOverrides` (validated by `DesignTokenOverridesSchema`, merged by `mergeTokens`).
**Versioning** — removing/renaming a token is a breaking change for the design system (bump its major). Components should reference tokens, never raw values, so brand changes are data-only.
**Testing** — `DesignTokensSchema.parse(tokens)`; snapshot `tokensToCss`.

## 4. Design reference library

**Storage** — `design_references` (`kind: url | asset | note`, `url`, `asset_id`, `notes`, `tags[]`, `metadata jsonb`, `project_id` nullable for an org-wide library). Assets carry `tags[]` and `metadata jsonb` for indexing (`PATCH /api/assets/:id`).
**API** — `GET/POST/DELETE /api/projects/:id/design-references`. Referenced assets must belong to the same project.
**Consumption** — passed to the design engine as `DesignEngineInput.references` and `assets`.
**Extending** — to add a curated, platform-wide reference library (owner-managed), add a table without `org_id` managed by platform-admin routes, and include it in `DesignEngineInput`. Keep tenant-uploaded references tenant-scoped.

## 5. AI design-generation engine

**Interface** — `DesignEngine` (`packages/contracts/src/ai.ts`):

```ts
analyzeRequirements(input) → RequirementsAnalysis   // what pages/content are needed, what's missing
createPlan(input, analysis) → GenerationPlan        // pages → sections → component types
generate(input, plan) → DesignEngineOutput           // { pages: [{ path, title, document }], settingsPatch?, explanation? }
```

`DesignEngineInput` gives: project + brief, site settings and pages, the active `DesignSystemManifest`, the `DesignRegistry` (use `createNode`, `catalogue`, `validateDocument`), design references and asset metadata.

**Registration** — `registerDesignEngine(engine)` in `apps/api/src/registry.ts` (default: `notConfiguredDesignEngine`, which raises `DesignEngineUnavailableError`).

**Flow** — the assistant calls tool `request_design_generation {stage}` → **sensitive → requires user approval** → engine runs → every output page is validated with `validateDocumentFor` (component existence, props, placement, asset ownership, module widgets) → applied as **draft revisions with `source: "ai"`** (existing pages replaced via ops, new pages created). Nothing is published automatically; the user can undo or restore any revision. An invalid page fails the whole task before any write.

**Security** — the engine runs in the API/worker process: it must be reviewed code. If it calls external models, use the provider abstraction (`apps/api/src/ai/provider.ts`) so usage accounting/rate limiting apply. Never let model output reach the database except as a `DesignEngineOutput` that passes validation.

**Testing** — copy `test/integration-points.test.ts`: register the engine, drive `request_design_generation` through a conversation, approve, assert pages + revisions; assert invalid output is rejected without writes.

**Long-running generation** — if generation exceeds a request's lifetime, move the approved task to a job (`enqueue("ai.generate", { taskId })`) and stream progress via notifications; the task status model (`ai_tasks.status`) already supports it.

## 6. Booking module (and any functional module)

**Required files** — `packages/module-<vendor>-<name>/src/index.ts` exporting `defineModule({...})`.

**Interface** — `ModuleDefinition`:

| Field | Notes |
|---|---|
| `id` | `vendor.name` (e.g. `acme.booking`). |
| `version`, `platformApi` | Semver; platform API must match. |
| `capabilities` | Declared up front: `records`, `webhooks.inbound`, `events.subscribe`, `events.emit`, `admin.pages`, `site.widgets`, `providers`. Undeclared capabilities throw at runtime. |
| `configSchema` | Zod schema; validated on install, settings change and upgrade. Exposed to the UI as JSON Schema. |
| `collections` | Zod schema per record collection; every write validated. |
| `featureFlag`, `requires`, `providers` | Availability gates, module dependencies, required provider kinds. |
| `hooks` | `onInstall` (failure rolls back the install), `onUninstall`, `onUpgrade`, `onConfigChange`. |
| `migrations` | `{ to, up(ctx) }[]` — run in order by `upgradeModule`; failure leaves the installation on its old version, status `failed`. |
| `events` | Handlers for platform events (`page.published`, `deployment.ready`, `domain.verified`, …), executed asynchronously as jobs with retries. |
| `webhook(ctx, req)` | Inbound HTTP at `POST /hooks/modules/:installationId`, authenticated by `X-Zyko-Signature: sha256=HMAC(rawBody, installationSecret)`. |
| `adminPages`, `widgets` | See §8 and §9. |

**Database ownership convention** — modules **do not get a DB handle**. Default storage is `module_records` (jsonb, per installation, per collection, schema-validated, quota-limited, cascaded on uninstall). If a module truly needs relational tables (e.g. a booking engine with availability queries):
- add a Drizzle schema file `apps/api/src/db/modules/<vendor>_<name>.ts` with tables prefixed `mod_<vendor>_<name>_`,
- every table has `org_id` and `installation_id` FKs with `on delete cascade`,
- expose access only through a typed repository that takes `ModuleContext` and filters by `installation.id` **and** `installation.orgId`,
- generate the migration with `pnpm db:generate` (platform migration, code-reviewed).

**Availability by subscription** — plan entitlements `modules: ["*" | "id" | "prefix.*"]` (`packages/contracts/src/plans.ts`), plus optional feature flag; enforced on install.

**Isolation** — every `ModuleContext` is bound to one installation; record queries always filter by installation id and org id; webhook secrets are per installation and encrypted at rest; one module cannot read another installation's records (tested).

**Testing** — follow `test/platform.test.ts` › module framework: install with invalid/valid config, signed/unsigned webhooks, event delivery after publish, upgrade, uninstall cascade, cross-tenant access → 404.

**Booking-specific guidance (for the future module, not implemented)** — collections `services`, `availability_rules`, `bookings`; webhook for external calendar sync; event `page.published` to refresh public availability; a widget `booking.form` whose public submission endpoint should be added as a module-declared public route (next platform extension: `publicRoutes` with rate limiting + captcha hook).

## 7. Calendar integration

Implement a `ProviderDefinition` with `kind: "calendar"`:

```ts
export interface CalendarAdapter {
  listBusy(range: { from: Date; to: Date }): Promise<{ start: Date; end: Date }[]>;
  createEvent(e: { start: Date; end: Date; title: string; attendees?: string[] }): Promise<{ id: string }>;
  cancelEvent(id: string): Promise<void>;
}
export const googleCalendar = defineProvider({
  kind: "calendar", id: "google-calendar", name: "Google Calendar",
  credentialsSchema: z.object({ refreshToken: z.string(), calendarId: z.string() }),
  create: (creds): CalendarAdapter => ({ /* … */ }),
  test: async (a) => ({ ok: true }),
});
```

Register with `registerProvider()`. Org admins connect it at `POST /api/orgs/:orgId/integrations` (credentials validated, `test()` executed, stored AES-256-GCM encrypted, never returned). Modules obtain it with `await ctx.provider<CalendarAdapter>("calendar")` (requires `providers` capability). OAuth providers need an OAuth callback route (`/api/integrations/:provider/callback`) that stores the refresh token through the same path — add it alongside the provider.

## 8. Business administration module

Use `adminPages` with declarative views — **no module UI code runs in the app shell**:

- `{ kind: "records", collection, columns, allowCreate?, allowDelete? }` → table + create form, backed by `/api/module-installations/:id/records/:collection` (role-checked; create/delete only if the view allows it).
- `{ kind: "settings" }` → config editor validated by `configSchema`.

To add richer views (charts, forms with field types, detail pages), extend the `ModuleAdminPage['view']` union in `contracts/modules.ts` and add a renderer in `apps/web/src/pages/modules.tsx`. Keep views declarative so they inherit the app's accessibility, theming and authorization.

## 9. Custom widget

A widget is a `ComponentDefinition` contributed by a module (`widgets: [...]`, capability `site.widgets`). Type must be namespaced (`<name>.<widget>` or `<vendor>-<name>.<widget>`). Widgets are registered into every design system's registry (server + editor). Pages can only contain a widget while its module is installed (validated on every write; tested). Widgets render statically at publish time; dynamic behaviour (forms, live availability) must go through module-declared public endpoints, not inline scripts.

## 10. New external service provider

Same contract as §7 with any `kind` (`email`, `payments`, `storage`, `dns`, `sms`, `crm`, …). Platform-level infrastructure providers (email delivery, billing, object storage, DNS resolution, AI chat) have dedicated interfaces instead because they are not per-tenant:

| Platform concern | Interface | Current adapters |
|---|---|---|
| Email | `EmailProvider` (`lib/platform.ts`) | `log`, `resend` |
| Billing | `BillingProvider` (`services/billing.ts`) | `test`, `stripe` |
| Object storage | `Storage` (`lib/storage.ts`) | local filesystem (S3 adapter: implement the 5 methods) |
| DNS verification | `DnsResolver` (`services/domains.ts`) | system resolver, in-memory fake |
| AI chat | `ChatProvider` (`ai/provider.ts`) | `anthropic` (official SDK), deterministic `mock` |
| Rate-limit store | `RateLimitStore` (`lib/rate-limit.ts`) | in-memory (Redis for multi-instance) |

**Security for all providers** — credentials only via env (platform) or `integration_connections` (tenant, encrypted); never log credentials; timeouts on outbound calls; treat responses as untrusted input (validate with zod).

---

## Checklist for any integration PR

- [ ] Registered in `apps/api/src/registry.ts` (and `apps/web/src/lib/registry.ts` for components/widgets)
- [ ] `pnpm typecheck && pnpm test` pass; new tests cover valid + invalid input and cross-tenant access
- [ ] Versioning/migrations provided for breaking changes
- [ ] No `unsafeRaw` with user data, no runtime code loading, no direct DB access from modules
- [ ] Docs: add a row to the table at the top of this file
