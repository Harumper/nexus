import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { connectDatabase, disconnectDatabase } from "./services/database.js";
import { setupWebSocketServer } from "./websocket/server.js";
import { checkOfflineMachines } from "./services/machine-manager.js";
import { authRoutes } from "./routes/auth.js";
import { machineRoutes } from "./routes/machines.js";
import { metricsRoutes } from "./routes/metrics.js";
import { actionRoutes } from "./routes/actions.js";
import { capabilityRoutes } from "./routes/capabilities.js";
import { alertRoutes } from "./routes/alerts.js";
import { auditRoutes } from "./routes/audit.js";
import { moduleRoutes } from "./routes/modules.js";
import { tagRoutes } from "./routes/tags.js";
import { groupRoutes } from "./routes/groups.js";
import { settingsRoutes } from "./routes/settings.js";
import { fleetRoutes } from "./routes/fleet.js";
import { profileRoutes } from "./routes/profiles.js";
import { initKeycloak } from "./services/keycloak.js";
import { evaluateOfflineAlerts } from "./services/alert-engine.js";
import { initProfileScheduler } from "./services/profile-engine.js";
import { checkMachineLifecycle } from "./services/machine-lifecycle.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "development" ? "debug" : "info",
    },
    trustProxy: true,
  });

  // ===================== Plugins =====================

  await app.register(helmet, {
    contentSecurityPolicy: false, // Désactivé pour l'API
  });

  await app.register(cors, {
    origin: true, // Accepter toute origine (le proxy Vite/nginx gère la sécurité)
    credentials: true,
  });

  await app.register(jwt, {
    secret: process.env.JWT_SECRET || "dev-secret-change-me",
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
  });

  // ===================== Health Check =====================

  app.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  // ===================== Routes =====================

  await app.register(authRoutes);
  await app.register(machineRoutes);
  await app.register(metricsRoutes);
  await app.register(actionRoutes);
  await app.register(capabilityRoutes);
  await app.register(alertRoutes);
  await app.register(auditRoutes);
  await app.register(moduleRoutes);
  await app.register(tagRoutes);
  await app.register(groupRoutes);
  await app.register(settingsRoutes);
  await app.register(fleetRoutes);
  await app.register(profileRoutes);

  // ===================== Database =====================

  await connectDatabase();

  // ===================== Keycloak =====================

  await initKeycloak();

  // ===================== WebSocket =====================

  setupWebSocketServer(app);

  // ===================== Profile Scheduler =====================

  initProfileScheduler();

  // ===================== Background Tasks =====================

  // Vérifier les machines offline toutes les 30s
  const offlineCheckInterval = setInterval(checkOfflineMachines, 30_000);

  // Évaluer les alertes offline toutes les 60s
  const offlineAlertInterval = setInterval(evaluateOfflineAlerts, 60_000);

  // Vérifier le cycle de vie des machines toutes les heures
  const lifecycleInterval = setInterval(checkMachineLifecycle, 60 * 60 * 1000);

  // ===================== Start =====================

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`[Nexus] Backend running on http://${HOST}:${PORT}`);
    console.log(`[Nexus] WebSocket agent endpoint: ws://${HOST}:${PORT}/ws/agent`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // ===================== Graceful Shutdown =====================

  const shutdown = async () => {
    console.log("\n[Nexus] Shutting down...");
    clearInterval(offlineCheckInterval);
    clearInterval(offlineAlertInterval);
    clearInterval(lifecycleInterval);
    await app.close();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
