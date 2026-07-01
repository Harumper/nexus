# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

# openssl for generating self-signed certificates
RUN apk add --no-cache openssl

# Copy the nginx config templates
RUN mkdir -p /etc/nginx/templates /etc/nginx/certs
COPY nginx-http.conf /etc/nginx/templates/nginx-http.conf
COPY nginx-https.conf /etc/nginx/templates/nginx-https.conf

# Default HTTP config (will be replaced by the entrypoint)
COPY nginx-http.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

# Entrypoint to handle TLS
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80 443

ENTRYPOINT ["/docker-entrypoint.sh"]
