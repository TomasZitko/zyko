#!/bin/sh
set -e
cd /app
case "$1" in
  api) exec node_modules/.bin/tsx apps/api/src/main.ts ;;
  worker) exec node_modules/.bin/tsx apps/api/src/worker-main.ts ;;
  sites) exec node_modules/.bin/tsx apps/api/src/sites-main.ts ;;
  migrate) exec node_modules/.bin/tsx apps/api/src/db/migrate.ts ;;
  *) exec "$@" ;;
esac
