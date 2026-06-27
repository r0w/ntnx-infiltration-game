FROM oven/bun:1.3 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock* ./
COPY packages/engine/package.json packages/engine/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/nutanix/package.json packages/nutanix/package.json
COPY packages/frontend/package.json packages/frontend/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile

FROM deps AS build-frontend
COPY packages/frontend packages/frontend
COPY packages/shared packages/shared
COPY tsconfig.base.json .
RUN cd packages/frontend && bun run build

FROM deps AS build-server
COPY packages packages
COPY tsconfig.base.json .
RUN bun build packages/server/src/index.ts --target=bun --outdir=dist/server --minify

FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
# The /ssh sandbox shells out to the real `ping` binary, absent from the slim image.
# setuid so it keeps working if the container is ever run as non-root (file caps alone wouldn't).
RUN apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping \
    && chmod u+s /usr/bin/ping \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build-server /app/dist/server ./dist/server
# database.ts resolves schema.sql relative to its own import.meta.url, which
# after bundling points at /app/dist/server/. Ship the schema there.
COPY packages/server/src/db/schema.sql ./dist/server/schema.sql
COPY --from=build-frontend /app/packages/frontend/dist ./public
COPY packs ./packs
RUN mkdir -p /data
ENV DATA_DIR=/data
ENV NODE_ENV=production
ENV PORT=3000
ENV PUBLIC_DIR=/app/public
# Build-stamped version, surfaced at /api/version (admin footer). Passed
# as --build-arg by the release workflow; defaults keep local builds sane.
ARG APP_VERSION=dev
ARG GIT_SHA=
ARG GIT_BRANCH=
ARG BUILD_TIME=
ENV APP_VERSION=$APP_VERSION
ENV GIT_SHA=$GIT_SHA
ENV GIT_BRANCH=$GIT_BRANCH
ENV BUILD_TIME=$BUILD_TIME
EXPOSE 3000
VOLUME /data
CMD ["bun", "run", "dist/server/index.js"]
