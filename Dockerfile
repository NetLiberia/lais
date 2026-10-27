# LAIS-Liberia containers: `api` (Express) and `web` (static build behind nginx).
# UNVERIFIED: written for docker compose but not yet built or run (no Docker on the development machine).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

# --- API --------------------------------------------------------------------------------------
FROM deps AS api
# pg_dump for administrator backups. Debian bookworm ships client 15, matching the postgis:15 image
# in docker-compose.yml; pg_dump refuses to dump a newer server major version.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-15 \
 && rm -rf /var/lib/apt/lists/*
COPY server server
WORKDIR /app/server
RUN mkdir -p storage/documents storage/backups && chown -R node:node storage
USER node
EXPOSE 4000
# Apply pending migrations, then start. Seeding is a separate, explicit step (see docs/install-docker.md).
CMD ["sh", "-c", "npx tsx src/migrate.ts && npx tsx src/index.ts"]

# --- Web --------------------------------------------------------------------------------------
FROM deps AS web-build
COPY web web
RUN npm run build -w web

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/web/dist /usr/share/nginx/html
EXPOSE 80
