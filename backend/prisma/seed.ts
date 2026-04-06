import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Capabilities builtin
  const capabilities = [
    {
      name: "monitoring",
      description: "Lecture seule : métriques CPU/RAM/disk, infos système, processus",
      actions: [
        "system.metrics",
        "system.info",
        "system.disk_usage",
        "system.process_list",
      ],
      isBuiltin: true,
    },
    {
      name: "updates",
      description: "Gestion des mises à jour système (apt/yum/dnf)",
      actions: ["system.package_list", "system.update", "system.update_security"],
      isBuiltin: true,
    },
    {
      name: "terminal",
      description: "Accès terminal web interactif (PTY)",
      actions: ["terminal.open", "terminal.resize", "terminal.close"],
      isBuiltin: true,
    },
  ];

  for (const cap of capabilities) {
    await prisma.capability.upsert({
      where: { name: cap.name },
      update: { actions: cap.actions, description: cap.description },
      create: cap,
    });
    console.log(`  Capability: ${cap.name}`);
  }

  // Admin par défaut
  const adminPassword = await bcrypt.hash("admin", 12);
  await prisma.user.upsert({
    where: { username: "admin" },
    update: {},
    create: {
      email: "admin@nexus.local",
      username: "admin",
      password: adminPassword,
      role: "ADMIN",
    },
  });
  console.log("  User: admin (password: admin) — CHANGER EN PRODUCTION");

  console.log("Seed completed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
