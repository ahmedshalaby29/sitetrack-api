# ── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app

# Copy manifests first for layer-cache efficiency
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: build ───────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
# Copy compiled JS from build stage
COPY --from=build /app/dist ./dist
# Copy source files so CLI scripts and seeders work seamlessly
COPY src ./src
# Copy package.json (needed for "type": "module" resolution)
COPY package.json ./
# Copy migrations so the runner can find them at runtime
# (relative path: dist/lib/migrate.js → ../../migrations)
COPY migrations ./migrations
# Copy documentation and schemas
COPY docs ./docs

EXPOSE 3000

# Healthcheck: poll /health every 10 s, give 30 s to start
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
