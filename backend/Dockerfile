# Stage 1: Build
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma ./prisma/
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src/
RUN npx tsc

# Stage 2: Production
FROM node:22-alpine

RUN apk add --no-cache wget

WORKDIR /app

COPY package.json package-lock.json* ./
RUN apk add --no-cache python3 make g++ && npm ci --omit=dev && apk del python3 make g++

COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma/
COPY prisma ./prisma/

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
