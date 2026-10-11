# Operations: deployment, monitoring, backups

## Environments

| Env | How | Notes |
|---|---|---|
| Local dev | `pnpm dev` (API :4000 with in-process sites edge :4100 + worker; Vite :5173 proxying `/api`) | Sites at `http://<subdomain>.sites.localhost:4100` (Chrome resolves `*.localhost`). `AI_PROVIDER=mock`, `BILLING_PROVIDER=test`, `EMAIL_PROVIDER=log`. |
| Test | `pnpm test` (vitest, real Postgres `zyko_test`, wiped per run) | Jobs drained explicitly; fake DNS. |
| E2E | `pnpm test:e2e` (Playwright; `e2e/server.sh` builds the SPA and runs a single-origin production-like stack on `zyko_e2e`) | |
| Staging / production | `deploy/docker-compose.yml` (postgres, migrate, api, worker, sites, caddy) | One image, role chosen by command. |

## Deploying the staging stack

Requires (owner-provided, **not available in this repository**): a host with Docker, a domain for the app (`APP_HOST`), a wildcard DNS record `*.SITES_DOMAIN` → host, and real credentials for whichever providers are enabled.

```bash
cp .env.example deploy/.env    # then edit:
#   NODE_ENV=production  DATABASE_URL=postgres://zyko:<pw>@postgres:5432/zyko
#   APP_ORIGIN=https://<APP_HOST>  SITES_DOMAIN=<sites domain>  SITES_PUBLIC_SCHEME=https  SITES_PUBLIC_PORT=
#   APP_ENCRYPTION_KEY=<32 random bytes base64>  STORAGE_DIR=/data  WORKER_INLINE=false
#   BILLING_PROVIDER=stripe + STRIPE_* (test billing is refused in production)
#   AI_PROVIDER=anthropic + ANTHROPIC_API_KEY   (or mock)
#   EMAIL_PROVIDER=resend + RESEND_API_KEY
export POSTGRES_PASSWORD=… APP_HOST=app.example.com SITES_DOMAIN=example-sites.com ACME_EMAIL=ops@example.com
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Verified in this environment: the image builds; `migrate`, `api`, `worker`, `sites` containers start in production mode against Postgres, `/readyz` is OK, the SPA is served, the sites edge answers. **Not verified here**: Caddy certificate issuance, real DNS, Stripe, Resend, Anthropic (no credentials/public DNS available).

Wildcard certificates for `*.SITES_DOMAIN` are best issued with a DNS-01 challenge (Caddy DNS provider plugin); on-demand TLS also works but issues one certificate per subdomain.

### Scaling notes
- API and sites edge are stateless → run N replicas behind the proxy. Switch `RateLimitStore` to Redis first.
- Workers: run N replicas; the queue uses `SKIP LOCKED`.
- Storage: replace `LocalStorage` with an S3-compatible adapter (same 5 methods) before running more than one host; put a CDN in front of the sites edge (`_assets/*` are immutable, HTML revalidates via ETag).
- Run migrations as a release step (`docker compose run migrate`); the API also applies pending migrations at boot (safe with a single API instance).

## Monitoring

- **Health**: `GET /healthz` (process), `GET /readyz` (DB), sites `GET /__zyko/health`.
- **Metrics**: `GET /metrics` (Prometheus text): `zyko_http_requests_total{method,status}`, `zyko_http_request_ms` p50/p95, `zyko_jobs_total{type,result}`, `zyko_job_duration_ms`, `zyko_ai_turn_ms`, `zyko_sites_requests_total`. Restrict `/metrics` to the internal network at the proxy.
- **Logs**: JSON lines to stdout/stderr with `requestId` (also returned as `X-Request-Id`); slow requests (>1 s) logged as warnings.
- **Errors**: `reportError()` in `lib/logger.ts` is the single hook — wire Sentry/OpenTelemetry there.
- **Jobs**: failed jobs visible and retryable in Platform admin; deployment build logs stored per deployment.
- **Alerts to configure**: readyz failing, 5xx rate, p95 latency, failed jobs > 0, deployment failures, certificate errors in Caddy logs.

## Backups and recovery

| Data | Where | Backup | Recovery |
|---|---|---|---|
| Postgres | `pgdata` volume | Nightly `pg_dump -Fc` + WAL archiving (or managed Postgres PITR); keep 30 days; copy off-host | `pg_restore` into a fresh DB, run `migrate`, point `DATABASE_URL` |
| Assets + deployments | `STORAGE_DIR` / bucket | Bucket versioning or nightly `rsync`/`rclone` snapshot | Restore files; deployments can also be **rebuilt** from page data by publishing again |
| Secrets | env / secret manager | Store `APP_ENCRYPTION_KEY` in a secret manager — losing it makes integration credentials and module webhook secrets unrecoverable | Rotate: decrypt with old key, re-encrypt with new (script to be written alongside the first rotation) |

Restore drill (do quarterly): restore latest dump to staging, run `pnpm test:e2e` against it, check a published site and a custom domain.

Retention jobs (scheduler, every 10 minutes): expired sessions, succeeded jobs > 7 days, expired auth tokens. `pruneDeployments()` exists for storage cleanup of old preview/production builds (keep last 10) — schedule it once storage costs matter.

## Performance budgets

`pnpm perf` (needs a disposable DB, default `zyko_perf`) measures in-process latency and bundle sizes and fails on regressions. Latest run in development container (124-node page):

| Metric | Budget | Measured |
|---|---|---|
| GET project p95 | 50 ms | 3.8 ms |
| GET page p95 | 50 ms | 5.3 ms |
| Save ops (autosave) p95 | 80 ms | 14 ms |
| Sites edge GET p95 | 20 ms | 0.7 ms |
| Publish build (1 page) | 2000 ms | 48 ms |
| Web initial JS+CSS (gzip) | 120 KB | 88 KB |
| Editor chunk (gzip) | 80 KB | 40 KB |
