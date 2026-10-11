#!/usr/bin/env bash
# Starts a production-like single-origin stack for E2E: built web app served by the API, sites edge, inline worker.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_ENV=test LOG_LEVEL=warn PORT=4000 SITES_PORT=4100 APP_ORIGIN=http://localhost:4000 \
  DATABASE_URL=${E2E_DATABASE_URL:-postgres://zyko:zyko@localhost:5432/zyko_e2e} STORAGE_DIR=.data/e2e-storage \
  SITES_DOMAIN=sites.localhost SITES_PUBLIC_PORT=:4100 DNS_MODE=fake WORKER_INLINE=true SERVE_WEB_DIST=apps/web/dist
psql "$DATABASE_URL" -qc "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;"
rm -rf .data/e2e-storage
NODE_ENV=production pnpm --filter @zyko/web build >/dev/null
# NODE_ENV=test keeps the dev-only in-process sites edge enabled.
exec npx tsx apps/api/src/main.ts
