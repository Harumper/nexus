#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Nexus Agent - Désinstallation
# ============================================

if [ "$EUID" -ne 0 ]; then
    echo "Ce script doit être lancé en root (sudo)."
    exit 1
fi

SERVICE_NAME="nexus-agent"

echo "=== Nexus Agent - Désinstallation ==="
echo ""
read -p "Supprimer l'agent Nexus et toutes ses données ? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Annulé."
    exit 0
fi

echo "Arrêt du service..."
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl disable "$SERVICE_NAME" 2>/dev/null || true
rm -f /etc/systemd/system/${SERVICE_NAME}.service
systemctl daemon-reload

echo "Suppression du sudoers..."
rm -f /etc/sudoers.d/nexus-agent

echo "Suppression des fichiers..."
rm -f /usr/local/bin/nexus-agent
rm -rf /etc/nexus
rm -rf /var/lib/nexus
rm -rf /var/log/nexus

echo "Suppression de l'utilisateur..."
userdel nexus-agent 2>/dev/null || true

echo ""
echo "Nexus Agent désinstallé."
