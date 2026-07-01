#!/usr/bin/env bash
set -euo pipefail

echo "=== Nexus - Development environment setup ==="

cd "$(dirname "$0")/.."

# Create .env if missing
if [ ! -f .env ]; then
    cp .env.example .env
    # Generate random secrets
    JWT_SECRET=$(openssl rand -hex 32)
    ECDSA_SECRET=$(openssl rand -hex 32)
    PG_PASSWORD=$(openssl rand -hex 16)

    # Fill the (blank) secret assignments in .env — .env.example ships them empty.
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" .env
    sed -i "s|^ECDSA_MASTER_SECRET=.*|ECDSA_MASTER_SECRET=$ECDSA_SECRET|" .env
    sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PG_PASSWORD|" .env

    echo "  .env created with generated secrets"
else
    echo "  .env already exists"
fi

# Install backend dependencies
echo ""
echo "--- Installing backend dependencies ---"
cd backend
npm install
npx prisma generate
cd ..

echo ""
echo "--- Generating CA certificates ---"
chmod +x scripts/generate-ca.sh
./scripts/generate-ca.sh

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. docker compose up postgres -d     # Start PostgreSQL"
echo "  2. cd backend && npm run db:migrate  # Apply migrations"
echo "  3. cd backend && npm run dev         # Start the backend"
echo ""
