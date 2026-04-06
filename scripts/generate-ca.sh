#!/usr/bin/env bash
set -euo pipefail

# Génère une CA interne pour Nexus (mTLS)
# Usage: ./scripts/generate-ca.sh [output_dir]

CERTS_DIR="${1:-$(dirname "$0")/../certs}"
mkdir -p "$CERTS_DIR"

echo "=== Nexus - Génération CA interne ==="

# CA private key
openssl ecparam -genkey -name prime256v1 -noout -out "$CERTS_DIR/ca.key"
chmod 600 "$CERTS_DIR/ca.key"

# CA certificate (10 ans)
openssl req -new -x509 -sha256 -key "$CERTS_DIR/ca.key" \
    -out "$CERTS_DIR/ca.crt" \
    -days 3650 \
    -subj "/CN=Nexus Internal CA/O=Nexus/OU=Infrastructure"

# Server certificate
openssl ecparam -genkey -name prime256v1 -noout -out "$CERTS_DIR/server.key"
chmod 600 "$CERTS_DIR/server.key"

openssl req -new -sha256 -key "$CERTS_DIR/server.key" \
    -out "$CERTS_DIR/server.csr" \
    -subj "/CN=nexus-backend/O=Nexus/OU=Backend"

openssl x509 -req -sha256 -in "$CERTS_DIR/server.csr" \
    -CA "$CERTS_DIR/ca.crt" -CAkey "$CERTS_DIR/ca.key" \
    -CAcreateserial \
    -out "$CERTS_DIR/server.crt" \
    -days 365

rm "$CERTS_DIR/server.csr"

echo ""
echo "Certificats générés dans $CERTS_DIR :"
echo "  ca.key      - Clé privée CA (NE PAS DISTRIBUER)"
echo "  ca.crt      - Certificat CA (à distribuer aux agents)"
echo "  server.key  - Clé privée serveur"
echo "  server.crt  - Certificat serveur"
echo ""
echo "Pour vérifier : openssl verify -CAfile $CERTS_DIR/ca.crt $CERTS_DIR/server.crt"
