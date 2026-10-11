# Zyko platform

Engineering foundation for an AI-assisted website platform: accounts and agencies, projects, a structured website model, a component-agnostic visual editor, an AI assistant with validated tools, publishing and hosting, custom domains, analytics, modules and billing.

> **Scope note.** The visual design system, website templates, design-generation engine and business modules are **reserved for owner-directed work**. This repository provides the contracts and infrastructure they plug into, plus clearly-marked temporary fixtures that prove the platform works. See [`docs/INTEGRATION-CONTRACTS.md`](docs/INTEGRATION-CONTRACTS.md).

## Quick start

Requirements: Node 22, pnpm 10, PostgreSQL 16.

```bash
pnpm install
createdb zyko_dev            # role/password default: zyko/zyko (see .env.example)
cp .env.example .env         # optional: defaults work for local dev
pnpm dev                     # API :4000 (+ sites edge :4100, worker), web :5173
```

Open http://localhost:5173, sign up, create an organization and a project, edit in **Editor**, chat in **Assistant** (deterministic mock AI unless `AI_PROVIDER=anthropic`), and publish in **Publish**. Published sites are served at `http://<subdomain>.sites.localhost:4100`.

Make yourself a platform admin: `pnpm --filter @zyko/api cli grant-admin you@example.com`.

## Commands

| Command | What |
|---|---|
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm test` | Contract unit tests + API integration tests (needs Postgres; DB `zyko_test` is wiped) |
| `pnpm test:e2e` | Playwright end-to-end (builds the SPA, starts a production-like stack on `zyko_e2e`) |
| `pnpm perf` | Latency and bundle-size budgets (DB `zyko_perf` is wiped) |
| `pnpm db:generate` / `pnpm db:migrate` | Create / apply Drizzle migrations |
| `pnpm build` | Build the web app |

## Layout

```
packages/contracts        integration contracts (page schema, ops, components, tokens, modules, AI engine, plans)
packages/renderer         document → HTML renderer, SEO helpers, editor canvas bridge
packages/design-fixtures  TEMPORARY neutral components (test fixture, not a design system)
packages/module-fixtures  TEST fixtures for the module framework
apps/api                  API, worker and sites edge (Hono + Drizzle + Postgres)
apps/web                  React SPA (public pages, auth, dashboards, editor, assistant, admin)
e2e                       Playwright tests
deploy                    Docker entrypoint, compose stack, Caddy config
docs                      architecture, integration contracts, security, operations, roadmap
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components, decisions, data model, flows
- [Integration contracts](docs/INTEGRATION-CONTRACTS.md) — adding components, templates, tokens, references, the design engine, modules, widgets, providers
- [Security](docs/SECURITY.md) — controls, gaps, review checklist
- [Operations](docs/OPERATIONS.md) — deployment, monitoring, backups, performance budgets
- [Roadmap & status](docs/ROADMAP.md) — what is verified, what needs credentials, what is next
