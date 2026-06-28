# Nexus backend Dockerfile
# IMPORTANT: build context is the repo root (pas ./backend)
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

# NB (mécanisme A) : l'agent n'est PLUS compilé ni embarqué dans cette image.
# Le binaire servi par /api/agents/download (install ET self-upgrade), sa
# signature minisign et le fichier VERSION proviennent du VOLUME /release,
# peuplé UNIQUEMENT par une release signée (job CI release-publish-signed).
# Invariant "signé == servi" : un seul build (release-build) produit ce binaire ;
# AGENT_VERSION est un contenu de release (NEXUS_AGENT_VERSION_PATH), pas un ENV gravé.
# Conséquence assumée (fail-closed) : tant qu'aucune release n'est publiée, le
# backend ne sert AUCUN binaire (ni install, ni upgrade). Le parc enrôlé n'est
# pas affecté (chaque agent exécute son propre binaire local).

COPY backend/package.json backend/package-lock.json* ./
RUN apk add --no-cache python3 make g++ && npm ci --omit=dev && apk del python3 make g++

COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma/
COPY backend/prisma ./prisma/

# Script d'install servi par /api/agents/install-script (le binaire vient du volume /release)
COPY scripts/install-agent.sh /app/scripts/install-agent.sh
RUN chmod +x /app/scripts/install-agent.sh

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
