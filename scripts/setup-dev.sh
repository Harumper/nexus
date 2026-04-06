#!/usr/bin/env bash
set -euo pipefail

echo "=== Nexus - Setup environnement de développement ==="

cd "$(dirname "$0")/.."

# Créer .env si absent
if [ ! -f .env ]; then
    cp .env.example .env
    # Générer des secrets aléatoires
    JWT_SECRET=$(openssl rand -hex 32)
    ECDSA_SECRET=$(openssl rand -hex 32)
    PG_PASSWORD=$(openssl rand -hex 16)

    sed -i "s/change_me_to_random_64_chars_minimum/$JWT_SECRET/" .env
    sed -i "s/change_me_in_production/$PG_PASSWORD/g" .env
    sed -i "0,/change_me_to_random_64_chars_minimum/s//$ECDSA_SECRET/" .env

    echo "  .env créé avec des secrets générés"
else
    echo "  .env existe déjà"
fi

# Installer les dépendances backend
echo ""
echo "--- Installation des dépendances backend ---"
cd backend
npm install
npx prisma generate
cd ..

echo ""
echo "--- Génération des certificats CA ---"
chmod +x scripts/generate-ca.sh
./scripts/generate-ca.sh

echo ""
echo "=== Setup terminé ==="
echo ""
echo "Prochaines étapes :"
echo "  1. docker compose up postgres -d     # Démarrer PostgreSQL"
echo "  2. cd backend && npm run db:migrate  # Appliquer les migrations"
echo "  3. cd backend && npm run dev         # Démarrer le backend"
echo ""
