FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
COPY contracts /contracts
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
  HUB_HOST=0.0.0.0 \
  HUB_PORT=20878 \
  HUB_DB_PATH=/data/hub.sqlite \
  HUB_ASSET_DIR=/data/assets \
  HUB_PUBLIC_DIR=/app/dist/public \
  HUB_PACKAGE_SCHEMA=/contracts/wuxianpi-package.schema.json
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /contracts /contracts
VOLUME ["/data"]
EXPOSE 20878
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
