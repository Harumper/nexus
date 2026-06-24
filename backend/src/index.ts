import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import { connectDatabase, disconnectDatabase } from "./services/database.js";
import { setupWebSocketServer } from "./websocket/server.js";
import { checkOfflineMachines } from "./services/machine-manager.js";
import { authRoutes } from "./routes/auth.js";
import { machineRoutes } from "./routes/machines.js";
import { metricsRoutes } from "./routes/metrics.js";
import { actionRoutes } from "./routes/actions.js";
import { alertRoutes } from "./routes/alerts.js";
import { auditRoutes } from "./routes/audit.js";
import { tagRoutes } from "./routes/tags.js";
import { groupRoutes } from "./routes/groups.js";
import { settingsRoutes } from "./routes/settings.js";
import { fleetRoutes } from "./routes/fleet.js";
import { initKeycloak } from "./services/keycloak.js";
import { evaluateOfflineAlerts, evaluateHealthAlerts, evaluateCertAlerts, initAlertState } from "./services/alert-engine.js";
import { checkMachineLifecycle } from "./services/machine-lifecycle.js";
import { register, httpRequestsTotal, httpRequestDuration, refreshFleetMetrics } from "./services/prometheus.js";
import { runMetricsCleanup } from "./services/metrics-cleanup.js";
import { agentDownloadRoutes } from "./routes/agent-download.js";
import { cleanupExpiredTokens } from "./services/bootstrap.js";
import { ensureBuiltinSeed } from "./services/bootstrap-seed.js";
import { firewallRoutes } from "./routes/firewall.js";
import { networkRoutes } from "./routes/network.js";
import { bulkRoutes } from "./routes/bulk.js";
import { integrationsRoutes } from "./routes/integrations.js";
import { packagesRoutes } from "./routes/packages.js";
import { refreshAptCatalog, initAptCatalogIfEmpty } from "./services/apt-catalog.js";
import { initSudoersVersion } from "./services/sudoers-version.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

// Validation des env vars critiques au boot — fail-fast plutôt que crash
// silencieux à la première utilisation.
function requireEnv(key: string): void {
  if (!process.env[key]) {
    throw new Error(`${key} environment variable is required. Set it before starting the server.`);
  }
}

// Démarre un setInterval avec un offset aléatoire initial (jitter) pour
// éviter le thundering herd : sans jitter, tous les intervals fixes démarrent
// au même tick et créent des spikes CPU/DB synchronisés.
function jitteredInterval(fn: () => void, baseMs: number, jitterPct = 0.3): () => void {
  const offset = Math.floor(Math.random() * baseMs * jitterPct);
  let intervalId: NodeJS.Timeout | null = null;
  const timeoutId = setTimeout(() => {
    intervalId = setInterval(fn, baseMs);
  }, offset);
  return () => {
    clearTimeout(timeoutId);
    if (intervalId) clearInterval(intervalId);
  };
}

async function main() {
  // Fail-fast sur les secrets manquants — sinon crash plus tard sur le 1er use
  requireEnv("JWT_SECRET");
  requireEnv("ECDSA_MASTER_SECRET");
  requireEnv("DATABASE_URL");

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
        // data: pour la preview d'image du FilesTab (servies inline en
        // data:image/...;base64 après fs.read). blob: au cas où une lib
        // utilise URL.createObjectURL. Pas d'origine externe whitelistée :
        // l'attaquant qui injecterait une img ne peut servir que ses
        // propres bytes encodés en data, déjà passés par notre auth.
        imgSrc: ["'self'", "data:", "blob:"],
      },
    },
  });

  await app.register(cors, {
    origin: process.env.FRONTEND_URL || "http://localhost:26032",
    credentials: true,
  });

  // Compression HTTP (gzip/br) — gain ~10x sur les payloads JSON volumineux
  // (machines list, metrics, audit logs). threshold 1KB pour éviter la
  // surcharge sur petits payloads.
  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ["br", "gzip", "deflate"],
  });

  // Cookie parsing — doit être enregistré AVANT @fastify/jwt pour que la
  // config cookie de jwt puisse lire les cookies parsés.
  await app.register(cookie, {
    secret: process.env.JWT_SECRET!, // pour les cookies signés (non utilisé ici, mais requis)
  });

  await app.register(jwt, {
    secret: process.env.JWT_SECRET!,
    // Lire le JWT depuis le cookie httpOnly en plus du header Authorization.
    // Le cookie est défini par /api/auth/login après auth locale réussie.
    cookie: {
      cookieName: "nexus_token",
      signed: false,
    },
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
  await app.register(alertRoutes);
  await app.register(auditRoutes);
  await app.register(tagRoutes);
  await app.register(groupRoutes);
  await app.register(settingsRoutes);
  await app.register(fleetRoutes);
  await app.register(agentDownloadRoutes);
  await app.register(firewallRoutes);
  await app.register(networkRoutes);
  await app.register(bulkRoutes);
  await app.register(integrationsRoutes);
  await app.register(packagesRoutes);

  // ===================== Database =====================

  await connectDatabase();

  // Seeder les capabilities/settings builtin (idempotent)
  try {
    await ensureBuiltinSeed();
  } catch (err) {
    console.error("[Seed] Failed to seed builtin data:", err);
  }

  // Calculer le hash sudoers de reference pour la detection drift
  initSudoersVersion();

  // ===================== Keycloak =====================

  await initKeycloak();

  // ===================== WebSocket =====================

  setupWebSocketServer(app);


  // ===================== Background Tasks =====================
  // Tous les intervals utilisent jitteredInterval pour décaler leur démarrage
  // de 0-30 % de leur période et éviter le thundering herd (tous les setInterval
  // se déclenchaient au même tick avant, créant des spikes CPU/DB synchronisés).

  // Charge l'état des alertes actives en cache mémoire (évite les findFirst N+1
  // dans evaluateMetrics/resolveAlert sur le chemin chaud).
  await initAlertState().catch((err) => console.error("[AlertEngine] initAlertState failed:", err));

  const stopOfflineCheck = jitteredInterval(checkOfflineMachines, 30_000);

  const stopOfflineAlert = jitteredInterval(evaluateOfflineAlerts, 60_000);

  const stopHealthAlert = jitteredInterval(
    () => evaluateHealthAlerts().catch((err) => console.error("[AlertEngine] Health check error:", err)),
    5 * 60_000
  );

  const stopCertAlert = jitteredInterval(
    () => evaluateCertAlerts().catch((err) => console.error("[AlertEngine] Cert scan error:", err)),
    6 * 60 * 60_000
  );
  // Premier scan 30s apres demarrage
  setTimeout(() => evaluateCertAlerts().catch((err) => console.error("[AlertEngine] initial cert scan failed:", err)), 30_000);

  const stopLifecycle = jitteredInterval(checkMachineLifecycle, 60 * 60 * 1000);

  // Rafraichir les metriques fleet pour Prometheus toutes les 30s
  const stopFleetMetrics = jitteredInterval(refreshFleetMetrics, 30_000);
  refreshFleetMetrics();

  const stopMetricsCleanup = jitteredInterval(runMetricsCleanup, 6 * 60 * 60 * 1000);

  const stopBootstrapCleanup = jitteredInterval(
    () => cleanupExpiredTokens().catch((err) => console.error("[Bootstrap] Cleanup error:", err)),
    24 * 60 * 60 * 1000
  );

  // Apt catalog : ingestion initiale si vide, puis refresh quotidien
  initAptCatalogIfEmpty().catch((err) => console.error("[AptCatalog] Init error:", err));
  const stopAptRefresh = jitteredInterval(
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
    stopOfflineCheck();
    stopOfflineAlert();
    stopHealthAlert();
    stopCertAlert();
    stopLifecycle();
    stopFleetMetrics();
    stopMetricsCleanup();
    stopBootstrapCleanup();
    stopAptRefresh();
    await app.close();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
