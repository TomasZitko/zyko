# Architecture

## Shape

```
                       ┌──────────────────────── SaaS origin (APP_HOST) ───────────────────────┐
 Browser ──HTTPS──▶ Caddy ──▶ api (Hono, Node 22)  ── serves apps/web/dist + /api + /hooks     │
   │                  │          │  auth · orgs · projects · editor ops · assets · AI (SSE)     │
   │                  │          │  modules · billing · domains · admin · metrics               │
   │                  │          └──▶ Postgres 16  ◀── worker (jobs: builds, email, DNS, events)│
   │                  │          └──▶ Object storage (assets/, deployments/)                    │
   │                  └──────────────────────────────────────────────────────────────────────┘
   │                  ┌──────────── Customer origin(s): *.SITES_DOMAIN + custom domains ───────┐
   └──HTTPS──▶ Caddy (on-demand TLS, asks sites edge) ──▶ sites edge (static file server)      │
                                                         reads deployments/<id>/… only        │
                      └──────────────────────────────────────────────────────────────────────┘
```

One TypeScript monorepo (pnpm workspaces):

| Package | Role |
|---|---|
| `packages/contracts` | **The integration surface.** Page document schema + edit operations, component/design-system contracts, registry, field schemas, tokens, module/provider contracts, design-engine contract, plans/entitlements, safe-HTML helpers. Pure TS + zod; runs in browser and server. |
| `packages/renderer` | Pure renderer: page document → HTML/CSS for `editor` / `preview` / `production`; sitemap/robots/SEO checks; editor canvas bridge script. |
| `packages/design-fixtures` | **Temporary** neutral design system used only to prove the platform. |
| `packages/module-fixtures` | **Test fixtures** for the module framework (notes module, echo provider). |
| `apps/api` | HTTP API, job worker, sites edge (three entry points, one codebase). |
| `apps/web` | React SPA: public pages, auth, dashboards, editor, assistant, publishing, modules, settings, admin. |

## Key decisions

1. **Static publishing on a separate origin.** A deployment renders every page with registered (reviewed) component code into immutable files under `deployments/<id>/`. The sites edge only maps `Host → live deployment → file`. Publishing = pointer swap (`websites.live_deployment_id`), so rollback is instant and atomic. Customer pages never share cookies or origin with the app. Future formats (e.g. dynamic module endpoints) are added as module-declared public routes, not by executing site code in the API.
2. **One write path for page content.** Editor autosave, the AI assistant, the design engine and modules all submit `EditOp[]` to `applyPageOps()`: row lock + optimistic concurrency (`baseVersion`), structural apply, full registry validation, asset-ownership and module-widget checks, revision row with the op list (change tracking) and actor (`user`/`ai`/`module`/`restore`).
3. **Undo/redo is op-based.** `applyOps()` returns inverse ops; the editor keeps history client-side and persists inverses as normal ops. Version history/restore is server-side (`page_revisions`). Restore migrates old documents to current component majors.
4. **Editor canvas is component-agnostic.** The editor renders with the same `renderDocument()` used for publishing, inside a `sandbox="allow-scripts"` iframe (opaque origin, CSP `default-src 'none'`). A small bridge maps clicks/double-clicks to `data-zyko-node` / `data-zyko-prop` attributes emitted by the renderer. The property panel is generated from `fields`. Plugging in a new design system requires no editor changes.
5. **Registration is code, not uploads.** Design systems, modules, providers and the design engine are imported in `apps/api/src/registry.ts` (+ `apps/web/src/lib/registry.ts` for render code). Compatibility is checked at boot.
6. **Tenant isolation in the application layer, made uniform.** Every tenant row carries `org_id`; every route resolves access with `requireOrg/requireProject/requirePage` (membership join). Non-members get 404. Modules see only an installation-scoped context. Tests cover cross-tenant access for every resource type. (Postgres RLS is a planned defence-in-depth layer; see ROADMAP.)
7. **Postgres for everything stateful** (jobs via `FOR UPDATE SKIP LOCKED`, sessions, rate-limit-free audit/usage). Fewer moving parts; Redis only when scaling the rate limiter horizontally.
8. **AI through a provider abstraction with validated tools.** Conversations are stored provider-neutral (`text`, `tool_use`, `tool_result`, plus opaque `raw` provider blocks for exact replay). Tools are zod-validated, role-checked and audited as `ai_tasks`; sensitive tools (publish, design generation) become `awaiting_approval` tasks the user must approve.

## Data model (abridged)

Identity: `users`, `sessions` (hashed tokens), `auth_tokens`.
Tenancy: `organizations(kind personal|agency)`, `memberships(role owner|admin|editor|viewer)`, `invitations`, `clients`.
Billing: `subscriptions`, `entitlement_overrides`, `usage_records`, `billing_events` (idempotency).
Projects: `projects(brief jsonb)`, `websites(settings, design_system_id/version, subdomain, live_deployment_id)`, `pages(document jsonb, version)`, `page_revisions(document, ops, source, ai_task_id)`.
Assets: `assets(storage_key, sha256, mime, kind, dims, tags, metadata)`, `design_references`.
AI: `conversations`, `messages(content jsonb blocks, usage)`, `ai_tasks(status, input, output)`.
Modules: `module_installations(config, webhook_secret_enc, version, status)`, `module_records`, `integration_connections(credentials_enc)`, `feature_flags`.
Hosting: `deployments(kind, status, manifest, log, preview_token)`, `domains(status, verification_token)`, `analytics_events`.
Platform: `notifications`, `email_outbox`, `jobs`, `platform_events`, `audit_events`.

Schema: `apps/api/src/db/schema.ts`; migrations: `apps/api/drizzle/` (generate with `pnpm db:generate`, applied at boot or `pnpm db:migrate`).

## Request flows

- **Edit**: canvas/panel → local `applyOps` + local validation → queue → debounced `POST /api/pages/:id/ops {baseVersion, ops, meta}` → 409 on conflict (editor offers reload).
- **AI turn**: `POST /api/conversations/:id/messages` → SSE stream (`text`, `tool_call`, `tool_result`, `approval_required`, `error`, `done`); up to `AI_MAX_TOOL_ROUNDS` model↔tool rounds; usage recorded per turn.
- **Publish**: `POST /api/projects/:id/deployments {kind}` → `deployment.build` job → render, copy referenced assets (content-addressed `_assets/<sha>.<ext>`), sitemap/robots/404/analytics beacon → `ready` → pointer swap (production) → notifications + `page.published` event → module event jobs.
- **Custom domain**: add → TXT `_zyko-challenge.<host>` → verify job with backoff → `verified` → Caddy `ask` endpoint approves → certificate issued on first request.

## API surface

All JSON under `/api` (cookie session, Origin-checked for writes). Main groups: `/auth`, `/orgs/:orgId/{members,invitations,clients,projects,integrations,audit}`, `/projects/:id/{pages,assets,design-system,design-references,conversations,ai-tasks,deployments,domains,seo,analytics,modules,website}`, `/pages/:id/{ops,revisions}`, `/conversations/:id/messages` (SSE), `/ai-tasks/:id/{approve,reject}`, `/module-installations/:id/...`, `/billing/{plans,webhook,orgs/:id/checkout,portal}`, `/notifications`, `/admin/*`. Public: `/hooks/modules/:installationId`, `/healthz`, `/readyz`, `/metrics`. Sites edge: `/__zyko/{health,collect,tls-ask,a.js}`.
