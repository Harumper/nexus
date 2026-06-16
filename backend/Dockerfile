# Nexus backend Dockerfile
# IMPORTANT: build context is the repo root (pas ./backend)
# docker-compose.yml: context: . / dockerfile: backend/Dockerfile

# Stage 0: Compile agent Go binary (linux/amd64, static)
FROM golang:1.23-alpine AS agent-builder

RUN apk add --no-cache git ca-certificates
WORKDIR /build
# Version injectée au build (sinon main.Version reste à son défaut "0.1.0").
# La CI passe 0.1.0+<short-sha> ; en local, valeur "dev" explicite.
ARG AGENT_VERSION=0.1.0+dev
COPY agent/go.mod agent/go.sum* ./
RUN go mod download
COPY agent/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s -X main.Version=${AGENT_VERSION}" \
    -o /out/nexus-agent \
    ./cmd/nexus-agent/

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

COPY backend/package.json backend/package-lock.json* ./
RUN apk add --no-cache python3 make g++ && npm ci --omit=dev && apk del python3 make g++

COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma/
COPY backend/prisma ./prisma/

# Agent binary + script d'install servis par /api/agents/download
COPY --from=agent-builder /out/nexus-agent /app/agent/nexus-agent
COPY scripts/install-agent.sh /app/scripts/install-agent.sh
RUN chmod +x /app/agent/nexus-agent /app/scripts/install-agent.sh

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
