import { timingSafeEqual } from "node:crypto";
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
import { evaluateOfflineAlerts, evaluateHealthAlerts, evaluateCertAlerts, evaluateHardeningAlerts, initAlertState } from "./services/alert-engine.js";
import { checkMachineLifecycle } from "./services/machine-lifecycle.js";
import { register, httpRequestsTotal, httpRequestDuration, refreshFleetMetrics } from "./services/prometheus.js";
import { runMetricsCleanup } from "./services/metrics-cleanup.js";
import { agentDownloadRoutes } from "./routes/agent-download.js";
import { cleanupExpiredTokens } from "./services/bootstrap.js";
import { ensureBuiltinSeed } from "./services/bootstrap-seed.js";
import { firewallRoutes } from "./routes/firewall.js";
import { networkRoutes } from "./routes/network.js";
import { sshRoutes } from "./routes/ssh.js";
import { securityRoutes } from "./routes/security.js";
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

// CONTROL-PLANE-005 — presence is not enough for signing secrets: a short/weak
// JWT_SECRET or ECDSA_MASTER_SECRET is brute-forceable offline, letting an
// attacker forge arbitrary tokens (incl. role:"ADMIN"). Enforce a minimum length
// at boot. 32 chars ≈ 256 bits if hex/base64 — the floor for HS256/ECDSA secrets.
function requireStrongSecret(key: string): void {
  const val = process.env[key];
  if (!val) {
    throw new Error(`${key} environment variable is required. Set it before starting the server.`);
  }
  if (val.length < 32) {
    throw new Error(
      `${key} is too weak: ${val.length} chars, minimum 32 required. Generate one with e.g. \`openssl rand -hex 32\`.`,
    );
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

// CONTROL-PLANE-001 — footgun de déploiement : FRONTEND_URL gouverne l'allowlist
// d'Origin du WS dashboard (CSWSH). Si elle reste sur un fallback localhost, le
// dashboard rejette SILENCIEUSEMENT le vrai domaine ("forbidden origin" en boucle,
// sans indice au boot). On AVERTIT bruyamment au démarrage — un défaut qui casse en
// silence est pire qu'un échec bruyant.
function warnIfFrontendUrlLooksLocal(): void {
  const v = process.env.FRONTEND_URL;
  const origins = (v || "").split(",").map((s) => s.trim()).filter(Boolean);
  const hasRealOrigin = origins.some((o) => {
    try {
      const h = new URL(o).hostname;
      return h !== "localhost" && h !== "127.0.0.1" && h !== "::1";
    } catch {
      return false; // origine non parsable → ne compte pas comme « vrai domaine »
    }
  });
  if (!hasRealOrigin) {
    console.warn(
      [
        "",
        `⚠️  [Nexus] FRONTEND_URL absent ou local (${v || "non défini"}).`,
        "    → Le WebSocket du dashboard REJETTERA toute origine réelle (CSWSH / CONTROL-PLANE-001) :",
        "      erreurs 'forbidden origin' en boucle dès l'ouverture de l'UI sur un vrai domaine.",
        "    → Déploiement derrière un domaine : définis",
        "          FRONTEND_URL=https://ton-domaine",
        "      (origine COMPLÈTE, sans slash final, sans :443, byte-identique à l'Origin du navigateur).",
        "",
      ].join("\n"),
    );
  }
}

async function main() {
  // Fail-fast sur les secrets manquants — sinon crash plus tard sur le 1er use
  requireStrongSecret("JWT_SECRET");
  requireStrongSecret("ECDSA_MASTER_SECRET");
  requireEnv("DATABASE_URL");
  // Non fatal (localhost est valide en dev local), mais visible au boot.
  warnIfFrontendUrlLooksLocal();

  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "development" ? "debug" : "info",
    },
    // CONTROL-PLANE-006: trust an explicit number of reverse-proxy hops rather
    // than the entire X-Forwarded-For chain (`true`), which would let a client
    // forge request.ip. Keep this in sync with extractClientIp's hop count.
    trustProxy: Math.max(0, parseInt(process.env.TRUSTED_PROXY_HOPS || "1", 10) || 0),
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
    // CONTROL-PLANE-008 — defense-in-depth: pin the local verifier to HS256 so a
    // token can't be accepted under a different algorithm (alg confusion / none).
    // The local path only ever issues HS256; refuse anything else outright.
    verify: { algorithms: ["HS256"] },
    sign: { algorithm: "HS256" },
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

  // NEXUS-WEB-AUTHZ-005 — /metrics exposes per-machine telemetry (machine_id,
  // hostname, live CPU/mem/disk) for the whole fleet — a credential-free recon
  // feed if reachable unauthenticated. Two valid controls, pick per deployment:
  //  (A) set METRICS_TOKEN → this handler enforces a constant-time bearer check
  //      and Prometheus scrapes with `authorization.credentials`.
  //  (B) leave METRICS_TOKEN unset and NETWORK-SCOPE the exposure: do NOT route
  //      /metrics through the public Traefik entrypoint — scrape it over the
  //      internal network / localhost only (Prometheus-idiomatic). This is a
  //      deliberate, internal-only exposure, not an oversight.
  const METRICS_TOKEN = process.env.METRICS_TOKEN || "";
  app.get("/metrics", async (request, reply) => {
    if (METRICS_TOKEN) {
      const header = request.headers.authorization || "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      const expected = Buffer.from(METRICS_TOKEN);
      const got = Buffer.from(presented);
      const ok =
        got.length === expected.length && timingSafeEqual(got, expected);
      if (!ok) {
        return reply.code(401).send("Unauthorized");
      }
    }
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
  await app.register(sshRoutes);
  await app.register(securityRoutes);
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

  // Posture de durcissement : lecture DB du dernier SecurityScan (peu couteux),
  // toutes les 15 min. Aussi declenche apres chaque audit (route /security/audit).
  const stopHardeningAlert = jitteredInterval(
    () => evaluateHardeningAlerts().catch((err) => console.error("[AlertEngine] Hardening eval error:", err)),
    15 * 60_000
  );

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
    stopHardeningAlert();
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
