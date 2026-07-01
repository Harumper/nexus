#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Nexus Agent - Uninstall
# ============================================

if [ "$EUID" -ne 0 ]; then
    echo "This script must be run as root (sudo)."
    exit 1
fi

SERVICE_NAME="nexus-agent"

echo "=== Nexus Agent - Uninstall ==="
echo ""
read -p "Remove the Nexus agent and all its data? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
fi

echo "Stopping the service..."
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl disable "$SERVICE_NAME" 2>/dev/null || true
rm -f /etc/systemd/system/${SERVICE_NAME}.service
systemctl daemon-reload

echo "Removing sudoers..."
rm -f /etc/sudoers.d/nexus-agent

echo "Removing files..."
rm -f /usr/local/bin/nexus-agent
rm -rf /etc/nexus
rm -rf /var/lib/nexus
rm -rf /var/log/nexus

echo "Removing the user..."
userdel nexus-agent 2>/dev/null || true

echo ""
echo "Nexus Agent uninstalled."
