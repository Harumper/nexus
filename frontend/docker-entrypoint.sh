#!/bin/sh
set -e

CERT_DIR="/etc/nginx/certs"
CERT_FILE="$CERT_DIR/nexus.crt"
KEY_FILE="$CERT_DIR/nexus.key"

if [ "${TLS_ENABLED:-false}" = "true" ]; then
  echo "[Nexus] TLS enabled"

  # Générer un certificat auto-signé si aucun n'existe
  if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
    echo "[Nexus] No certificates found, generating self-signed certificate..."
    mkdir -p "$CERT_DIR"
    openssl req -x509 -nodes -days 3650 \
      -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
      -keyout "$KEY_FILE" \
      -out "$CERT_FILE" \
      -subj "/CN=nexus/O=Nexus Self-Signed" \
      2>/dev/null
    echo "[Nexus] Self-signed certificate generated (valid 10 years)"
  else
    echo "[Nexus] Using existing certificates"
  fi

  # Utiliser la config HTTPS (envsubst : uniquement ${CSP_AUTH_ORIGIN}, pour ne PAS
  # écraser les variables runtime de nginx comme $host / $uri / $remote_addr).
  envsubst '${CSP_AUTH_ORIGIN}' < /etc/nginx/templates/nginx-https.conf > /etc/nginx/conf.d/default.conf
else
  echo "[Nexus] TLS disabled, using HTTP"
  envsubst '${CSP_AUTH_ORIGIN}' < /etc/nginx/templates/nginx-http.conf > /etc/nginx/conf.d/default.conf
fi

exec nginx -g "daemon off;"
