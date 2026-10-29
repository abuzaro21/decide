# Two stages: build the static UI, then a small runtime with only what the server needs.
FROM node:24.13.0-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY ui ./ui
RUN npm run build

FROM node:24.13.0-slim
ENV NODE_ENV=production PORT=3000 DECIDE_DB=/tmp/decide/decide.db
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY fixtures ./fixtures
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
# Ephemeral by design: each container start is a new demo run (new runId); nothing persists across restarts.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
