# Status and roadmap

Status values: **Verified** = implemented and covered by automated tests run in this repository. **Implemented** = code complete, exercised manually or partially, not end-to-end tested. **Adapter only** = interface + adapter written, needs external credentials to verify. **Not started**.

## Milestone 1 — connected foundation: **complete (verified)**

All 17 acceptance steps pass in `apps/api/test/foundation.test.ts` (API level) and `e2e/foundation.spec.ts` (Chromium, through the UI).

## Capability status

| Area | Status | Notes |
|---|---|---|
| Registration, login, logout, sessions, password reset, email verification | Verified | |
| Organizations (personal/agency), roles, invitations, member management, clients | Verified | Project-level ACLs (per-client restrictions inside an org) not started |
| Plans, entitlements, usage accounting, limits | Verified | Prices placeholder (owner decision) |
| Billing: test provider | Verified | Dev only; refused in production |
| Billing: Stripe checkout/portal/webhooks | Adapter only | Signature verification unit-tested; needs Stripe account + price ids |
| Projects, brief, website settings | Verified | |
| Page documents, edit ops, validation, optimistic concurrency, revisions, restore | Verified | |
| Visual editor engine (selection, tree, property panel, inline text, insert/move/duplicate/delete, undo/redo, autosave, responsive preview, visibility per breakpoint, version history, page settings) | Verified (E2E covers core paths) | Drag-and-drop reordering not implemented (up/down buttons instead) |
| Assets: upload, sniffing, metadata, signed URLs, soft delete | Verified | Image derivatives (resize/WebP) and malware scanning not started |
| AI: conversations, persistence, SSE streaming, project context, tool calling, validation, approvals, usage, rate limits, retries | Verified with deterministic mock provider | Claude adapter (official SDK) **not verified live** — set `AI_PROVIDER=anthropic` + key. Consider enabling server-side refusal fallbacks (`fallbacks: "default"`, beta header) once verified. Context management is a sliding window (60 messages); compaction not started |
| Design-engine plug-in point | Verified with test-only engine | Production engine reserved for owner |
| Design-system registry, tokens, component contracts, migrations, templates, compatibility checks | Verified | Only the temporary fixture system is registered |
| Module framework (registration, config, records, lifecycle, migrations/upgrade, events, signed webhooks, admin pages, widgets, plan/flag gating, provider adapters) | Verified with fixtures | Module-declared public routes (needed for booking forms) not started |
| Publishing: preview, production, build logs, rollback, unpublish, sitemap/robots/SEO meta, caching headers | Verified | |
| Sites edge: subdomains, previews, custom domains, TLS ask endpoint | Verified | Real certificate issuance not verified (needs public DNS) |
| Custom domains: TXT verification with retries | Verified (fake DNS) | Routing-record (CNAME/A) health check not started |
| Analytics: cookie-less beacon, reporting API + UI | Verified | Rollup tables for large volumes not started |
| Notifications (in-app), email outbox + jobs | Verified (log provider) | Resend adapter not verified live; email preferences not started |
| Background jobs (retry/backoff/dedupe/recovery), scheduler | Verified | |
| Platform admin (overview, users, orgs, flags, entitlement overrides, job retry, audit) | Implemented | UI smoke-tested manually only |
| Monitoring (health, readiness, metrics, structured logs, error hook) | Implemented | No external APM wired |
| Security controls | See SECURITY.md | RLS, 2FA, upload scanning pending |
| Docker image, compose staging stack, Caddy config | Implemented; image + roles verified locally | Full staging deploy needs a host, DNS and credentials |
| CI (typecheck, tests, perf budgets, E2E) | Implemented | Runs on GitHub Actions; first run will confirm |
| Performance budgets | Verified | |

## Next milestones (proposed)

1. **Production hardening**: S3 storage adapter; Redis rate limiter; Postgres RLS policies mirroring app checks; CSP for the SPA; Sentry wiring; `pnpm audit` + CodeQL in CI; required email verification for publishing/custom domains.
2. **Live provider verification**: Stripe test-mode end-to-end, Resend, Anthropic (with refusal fallback), real DNS + Caddy on a staging host.
3. **Editor ergonomics** (no design decisions): drag-and-drop in the layer tree and canvas, multi-select, copy/paste between pages, keyboard navigation in the tree, real-time collaboration (presence + op rebase on 409).
4. **Module platform v2**: module-declared public routes with rate limiting/captcha, scheduled module jobs, richer declarative admin views, OAuth connection flow for providers.
5. **Asset pipeline**: image derivatives (responsive `srcset`), video poster frames, upload scanning.
6. **AI**: conversation compaction/summaries, cost dashboards per org, long-running generation as jobs with progress.

## Reserved for owner-directed work (intentionally not built)

Final design system and visual language · component library · website templates · design intelligence / generation algorithm · booking, calendar, restaurant, hotel, chatbot and other business modules · marketing copy and brand for the public site and app shell.

## External dependencies needing paid credentials or access

Stripe account (+ price ids, webhook endpoint) · Anthropic API key · Resend (or other email) account + verified sending domain · a public host, app domain, wildcard DNS for the sites domain (DNS-01 provider credentials for wildcard TLS) · object storage bucket · error tracking (Sentry) · managed Postgres with PITR (recommended).
