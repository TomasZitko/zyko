# One image, three roles: api (default), worker, sites.  docker run IMAGE [api|worker|sites|migrate]
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/renderer/package.json packages/renderer/
COPY packages/design-fixtures/package.json packages/design-fixtures/
COPY packages/module-fixtures/package.json packages/module-fixtures/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN NODE_ENV=production pnpm --filter @zyko/web build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production SERVE_WEB_DIST=apps/web/dist WORKER_INLINE=false
COPY --from=build /app /app
RUN useradd -r -u 10001 zyko && mkdir -p /data && chown zyko /data
USER zyko
EXPOSE 4000 4100
COPY deploy/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["api"]
