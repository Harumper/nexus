# Nexus backend Dockerfile
# IMPORTANT: build context is the repo root (not ./backend)
# docker-compose.yml: context: . / dockerfile: backend/Dockerfile

# Stage 1: Build backend TypeScript
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./
RUN npm ci

COPY backend/prisma ./prisma/
RUN npx prisma generate

COPY backend/tsconfig.json ./
COPY backend/src ./src/
RUN npx tsc

# Stage 2: Production
FROM node:22-alpine

RUN apk add --no-cache wget

WORKDIR /app

# NB (mechanism A): the agent is NO LONGER compiled or embedded in this image.
# The binary served by /api/agents/download (install AND self-upgrade), its
# minisign signature and the VERSION file come from the /release VOLUME,
# populated ONLY by a signed release (CI job release-publish-signed).
# Invariant "signed == served": a single build (release-build) produces this binary;
# AGENT_VERSION is release content (NEXUS_AGENT_VERSION_PATH), not a baked-in ENV.
# Accepted consequence (fail-closed): as long as no release is published, the
# backend serves NO binary (neither install nor upgrade). The enrolled fleet is
# not affected (each agent runs its own local binary).

COPY backend/package.json backend/package-lock.json* ./
RUN apk add --no-cache python3 make g++ && npm ci --omit=dev && apk del python3 make g++

COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma/
COPY backend/prisma ./prisma/

# Install script served by /api/agents/install-script (the binary comes from the /release volume)
COPY scripts/install-agent.sh /app/scripts/install-agent.sh
RUN chmod +x /app/scripts/install-agent.sh

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
