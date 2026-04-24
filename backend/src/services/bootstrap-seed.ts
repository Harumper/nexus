import bcrypt from "bcrypt";
import { prisma } from "./database.js";

// Ensure les capabilities builtin et l'admin par defaut existent en DB.
// Idempotent (upsert) — peut etre appele a chaque demarrage sans risque.
export async function ensureBuiltinSeed(): Promise<void> {
  const capabilities = [
    {
      name: "monitoring",
      description: "Lecture seule : metriques CPU/RAM/disk, infos systeme, processus, logs",
      actions: [
        "system.metrics",
        "system.info",
        "system.disk_usage",
        "system.process_list",
        "system.processes",
        "system.heartbeat",
        "system.logs",
        "agent.upgrade",
      ],
      isBuiltin: true,
    },
    {
      name: "updates",
      description: "Gestion des mises a jour systeme (apt/yum/dnf)",
      actions: ["system.package_list", "system.update", "system.update_security"],
      isBuiltin: true,
    },
    {
      name: "packages",
      description: "Installation et suppression de paquets",
      actions: ["package.install", "package.remove", "package.list"],
      isBuiltin: true,
    },
    {
      name: "scripts",
      description: "Execution de scripts et kill de processus",
      actions: ["script.execute", "process.kill"],
      isBuiltin: true,
    },
    {
      name: "terminal",
      description: "Acces terminal web interactif (PTY)",
      actions: ["terminal.open", "terminal.resize", "terminal.close"],
      isBuiltin: true,
    },
    {
      name: "system_control",
      description: "Controle systeme : redemarrage, gestion des services systemd",
      actions: [
        "system.reboot",
        "system.services_list",
        "system.service_status",
        "system.service_start",
        "system.service_stop",
        "system.service_restart",
      ],
      isBuiltin: true,
    },
    {
      name: "firewall",
      description: "Gestion du pare-feu (ufw) avec watchdog-revert 60s",
      actions: [
        "firewall.status",
        "firewall.allow",
        "firewall.deny",
        "firewall.rule_remove",
        "firewall.enable",
        "firewall.disable",
      ],
      isBuiltin: true,
    },
  ];

  let created = 0;
  for (const cap of capabilities) {
    const existing = await prisma.capability.findUnique({ where: { name: cap.name } });
    if (!existing) {
      await prisma.capability.create({ data: cap });
      created++;
    } else {
      // Rafraichir les actions et la description au cas ou elles aient evolue
      await prisma.capability.update({
        where: { name: cap.name },
        data: { actions: cap.actions, description: cap.description },
      });
    }
  }
  if (created > 0) {
    console.log(`[Seed] Created ${created} builtin capabilities`);
  }

  // Admin par defaut (seulement s'il n'existe pas du tout — ne jamais ecraser un mot de passe)
  const adminExists = await prisma.user.findUnique({ where: { username: "admin" } });
  if (!adminExists) {
    const password = await bcrypt.hash("admin", 12);
    await prisma.user.create({
      data: {
        email: "admin@nexus.local",
        username: "admin",
        password,
        role: "ADMIN",
      },
    });
    console.log("[Seed] Created default admin user (username=admin, password=admin — CHANGE IT!)");
  }

  // Settings par defaut (rétention, seuils de sante)
  const defaultSettings = [
    { key: "metrics_retention_days", value: 30 },
    { key: "health_threshold_cpu", value: 90 },
    { key: "health_threshold_memory", value: 85 },
    { key: "health_threshold_disk", value: 80 },
    { key: "stale_after_days", value: 7 },
    { key: "archive_after_days", value: 30 },
    { key: "delete_after_days", value: 90 },
  ];
  for (const s of defaultSettings) {
    const existing = await prisma.setting.findUnique({ where: { key: s.key } });
    if (!existing) {
      await prisma.setting.create({ data: s });
    }
  }
}
