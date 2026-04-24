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
import { register, httpRequestsTotal, httpRequestDuration, refreshFleetMetrics } from "./services/prometheus.js";
import { runMetricsCleanup } from "./services/metrics-cleanup.js";
import { agentDownloadRoutes } from "./routes/agent-download.js";
import { cleanupExpiredTokens } from "./services/bootstrap.js";
import { ensureBuiltinSeed } from "./services/bootstrap-seed.js";
import { firewallRoutes } from "./routes/firewall.js";
import { packagesRoutes } from "./routes/packages.js";
import { refreshAptCatalog, initAptCatalogIfEmpty } from "./services/apt-catalog.js";

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

  // CSP : autoriser Keycloak dans frame-src si SSO actif
  const keycloakUrl = process.env.KEYCLOAK_URL || "";
  const cspFrameSrc = keycloakUrl
    ? ["'self'", keycloakUrl]
    : ["'self'"];

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", ...(keycloakUrl ? [keycloakUrl] : [])],
        frameSrc: cspFrameSrc,
      },
    },
  });

  await app.register(cors, {
    origin: process.env.FRONTEND_URL || "http://localhost:26032",
    credentials: true,
  });

  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable is required. Set it before starting the server.");
  }
  await app.register(jwt, {
    secret: process.env.JWT_SECRET,
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

  // ===================== Prometheus /metrics =====================

  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });

  // Hook HTTP pour mesurer les requetes
  app.addHook("onResponse", (request, reply, done) => {
    const route = request.routeOptions?.url || request.url;
    // Exclure /metrics et /health du comptage
    if (route !== "/metrics" && route !== "/health") {
      httpRequestsTotal.inc({
        method: request.method,
        route,
        status: reply.statusCode.toString(),
      });
      const duration = reply.elapsedTime / 1000; // ms -> seconds
      httpRequestDuration.observe({ method: request.method, route }, duration);
    }
    done();
  });

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
  await app.register(agentDownloadRoutes);
  await app.register(firewallRoutes);
  await app.register(packagesRoutes);

  // ===================== Database =====================

  await connectDatabase();

  // Seeder les capabilities/settings builtin (idempotent)
  try {
    await ensureBuiltinSeed();
  } catch (err) {
    console.error("[Seed] Failed to seed builtin data:", err);
  }

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

  // Rafraichir les metriques fleet pour Prometheus toutes les 30s
  const fleetMetricsInterval = setInterval(refreshFleetMetrics, 30_000);
  refreshFleetMetrics();

  // Cleanup des metriques en DB toutes les 6h
  const cleanupInterval = setInterval(runMetricsCleanup, 6 * 60 * 60 * 1000);

  // Cleanup des bootstrap tokens expires toutes les 24h
  const bootstrapCleanupInterval = setInterval(
    () => cleanupExpiredTokens().catch((err) => console.error("[Bootstrap] Cleanup error:", err)),
    24 * 60 * 60 * 1000
  );

  // Apt catalog : ingestion initiale si vide, puis refresh quotidien
  initAptCatalogIfEmpty().catch((err) => console.error("[AptCatalog] Init error:", err));
  const aptRefreshInterval = setInterval(
    () => refreshAptCatalog().catch((err) => console.error("[AptCatalog] Refresh error:", err)),
    24 * 60 * 60 * 1000
  );

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
    clearInterval(fleetMetricsInterval);
    clearInterval(cleanupInterval);
    clearInterval(bootstrapCleanupInterval);
    clearInterval(aptRefreshInterval);
    await app.close();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
