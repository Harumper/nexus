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
import { httpRequestsTotal, httpRequestDuration, refreshFleetMetrics, registerPrometheusEndpoint } from "./services/prometheus.js";
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
import { requireStrongSecret, requireStrongSecretIfSet } from "./services/boot-secrets.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

// Validate critical env vars at boot — fail-fast rather than a silent crash
// on first use.
function requireEnv(key: string): void {
  if (!process.env[key]) {
    throw new Error(`${key} environment variable is required. Set it before starting the server.`);
  }
}

// Start a setInterval with an initial random offset (jitter) to avoid the
// thundering herd: without jitter, all fixed intervals start on the same tick
// and create synchronized CPU/DB spikes.
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

// CONTROL-PLANE-001 — deployment footgun: FRONTEND_URL governs the dashboard WS
// Origin allowlist (CSWSH). If it stays on a localhost fallback, the dashboard
// SILENTLY rejects the real domain ("forbidden origin" in a loop, with no hint
// at boot). We WARN loudly at startup — a defect that fails silently is worse
// than a noisy failure.
function warnIfFrontendUrlLooksLocal(): void {
  const v = process.env.FRONTEND_URL;
  const origins = (v || "").split(",").map((s) => s.trim()).filter(Boolean);
  const hasRealOrigin = origins.some((o) => {
    try {
      const h = new URL(o).hostname;
      return h !== "localhost" && h !== "127.0.0.1" && h !== "::1";
    } catch {
      return false; // unparsable origin → does not count as a "real domain"
    }
  });
  if (!hasRealOrigin) {
    console.warn(
      [
        "",
        `⚠️  [Nexus] FRONTEND_URL missing or local (${v || "undefined"}).`,
        "    → The dashboard WebSocket WILL REJECT any real origin (CSWSH / CONTROL-PLANE-001):",
        "      'forbidden origin' errors in a loop as soon as the UI is opened on a real domain.",
        "    → Deploying behind a domain: set",
        "          FRONTEND_URL=https://your-domain",
        "      (the FULL origin, no trailing slash, no :443, byte-identical to the browser's Origin).",
        "",
      ].join("\n"),
    );
  }
}

async function main() {
  // Fail-fast on missing secrets — otherwise a later crash on first use
  requireStrongSecret("JWT_SECRET");
  requireStrongSecret("ECDSA_MASTER_SECRET");
  requireStrongSecretIfSet("METRICS_TOKEN");
  requireEnv("DATABASE_URL");
  // Non-fatal (localhost is valid in local dev), but visible at boot.
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

  // CSP: allow Keycloak in frame-src if SSO is active
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
        // data: for the FilesTab image preview (served inline as
        // data:image/...;base64 after fs.read). blob: in case a lib uses
        // URL.createObjectURL. No external origin whitelisted: an attacker
        // injecting an img can only serve their own data-encoded bytes, which
        // already went through our auth.
        imgSrc: ["'self'", "data:", "blob:"],
      },
    },
  });

  await app.register(cors, {
    origin: process.env.FRONTEND_URL || "http://localhost:26032",
    credentials: true,
  });

  // HTTP compression (gzip/br) — ~10x gain on large JSON payloads (machines
  // list, metrics, audit logs). 1KB threshold to avoid the overhead on small
  // payloads.
  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ["br", "gzip", "deflate"],
  });

  // Cookie parsing — must be registered BEFORE @fastify/jwt so that jwt's
  // cookie config can read the parsed cookies.
  await app.register(cookie, {
    secret: process.env.JWT_SECRET!, // for signed cookies (not used here, but required)
  });

  await app.register(jwt, {
    secret: process.env.JWT_SECRET!,
    // CONTROL-PLANE-008 — defense-in-depth: pin the local verifier to HS256 so a
    // token can't be accepted under a different algorithm (alg confusion / none).
    // The local path only ever issues HS256; refuse anything else outright.
    verify: { algorithms: ["HS256"] },
    sign: { algorithm: "HS256" },
    // Read the JWT from the httpOnly cookie in addition to the Authorization
    // header. The cookie is set by /api/auth/login after a successful local auth.
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
  // NEXUS-WEB-AUTHZ-005 — optional bearer (METRICS_TOKEN, constant-time, fail-closed)
  // ADDITIVE to network scoping. Extracted into prometheus.ts to be testable in CI.
  registerPrometheusEndpoint(app);

  // HTTP hook to measure requests
  app.addHook("onResponse", (request, reply, done) => {
    const route = request.routeOptions?.url || request.url;
    // Exclude /metrics and /health from the count
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

  // Seed the builtin capabilities/settings (idempotent)
  try {
    await ensureBuiltinSeed();
  } catch (err) {
    console.error("[Seed] Failed to seed builtin data:", err);
  }

  // Compute the reference sudoers hash for drift detection
  initSudoersVersion();

  // ===================== Keycloak =====================

  await initKeycloak();

  // ===================== WebSocket =====================

  setupWebSocketServer(app);


  // ===================== Background Tasks =====================
  // All intervals use jitteredInterval to offset their start by 0-30% of their
  // period and avoid the thundering herd (before, every setInterval fired on the
  // same tick, creating synchronized CPU/DB spikes).

  // Load the state of active alerts into an in-memory cache (avoids the N+1
  // findFirst in evaluateMetrics/resolveAlert on the hot path).
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
  // First scan 30s after startup
  setTimeout(() => evaluateCertAlerts().catch((err) => console.error("[AlertEngine] initial cert scan failed:", err)), 30_000);

  // Hardening posture: DB read of the latest SecurityScan (cheap), every
  // 15 min. Also triggered after each audit (route /security/audit).
  const stopHardeningAlert = jitteredInterval(
    () => evaluateHardeningAlerts().catch((err) => console.error("[AlertEngine] Hardening eval error:", err)),
    15 * 60_000
  );

  const stopLifecycle = jitteredInterval(checkMachineLifecycle, 60 * 60 * 1000);

  // Refresh the fleet metrics for Prometheus every 30s
  const stopFleetMetrics = jitteredInterval(refreshFleetMetrics, 30_000);
  refreshFleetMetrics();

  const stopMetricsCleanup = jitteredInterval(runMetricsCleanup, 6 * 60 * 60 * 1000);

  const stopBootstrapCleanup = jitteredInterval(
    () => cleanupExpiredTokens().catch((err) => console.error("[Bootstrap] Cleanup error:", err)),
    24 * 60 * 60 * 1000
  );

  // Apt catalog: initial ingestion if empty, then daily refresh
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
