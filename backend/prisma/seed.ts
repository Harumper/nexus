import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

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
