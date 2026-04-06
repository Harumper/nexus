# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

# openssl pour la génération de certificats auto-signés
RUN apk add --no-cache openssl

# Copier les templates de config nginx
RUN mkdir -p /etc/nginx/templates /etc/nginx/certs
COPY nginx-http.conf /etc/nginx/templates/nginx-http.conf
COPY nginx-https.conf /etc/nginx/templates/nginx-https.conf

# Config HTTP par défaut (sera remplacée par l'entrypoint)
COPY nginx-http.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

# Entrypoint pour gérer TLS
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80 443

ENTRYPOINT ["/docker-entrypoint.sh"]
