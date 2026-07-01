import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { encryptAES } from "../services/crypto.js";
import {
  fetchNautilusSnapshot,
  getNautilusConfig,
  NAUTILUS_SETTINGS_KEYS,
} from "../services/nautilus-integration.js";

export async function integrationsRoutes(app: FastifyInstance): Promise<void> {
  // Returns the current config (url, enabled, masked token)
  app.get(
    "/api/integrations/nautilus/config",
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const cfg = await getNautilusConfig();
      return reply.send({
        enabled: cfg.enabled,
        url: cfg.url,
        // Never return the token in clear text. Just whether it is set.
        tokenConfigured: cfg.token !== null,
      });
    }
  );

  // Update the config (ADMIN)
  app.put(
    "/api/integrations/nautilus/config",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            url: { type: "string", maxLength: 500 },
            token: { type: ["string", "null"], maxLength: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        enabled?: boolean;
        url?: string;
        token?: string | null;
      };

      const updates: Array<Promise<unknown>> = [];
      if (body.enabled !== undefined) {
        updates.push(
          prisma.setting.upsert({
            where: { key: NAUTILUS_SETTINGS_KEYS.ENABLED },
            create: { key: NAUTILUS_SETTINGS_KEYS.ENABLED, value: body.enabled },
            update: { value: body.enabled },
          })
        );
      }
      if (body.url !== undefined) {
        // Minimal URL validation
        try {
          new URL(body.url);
        } catch {
          return reply.code(400).send({ error: "Invalid URL" });
        }
        updates.push(
          prisma.setting.upsert({
            where: { key: NAUTILUS_SETTINGS_KEYS.URL },
            create: { key: NAUTILUS_SETTINGS_KEYS.URL, value: body.url },
            update: { value: body.url },
          })
        );
      }
      if (body.token !== undefined) {
        // If token is null or empty, delete the setting
        if (body.token === null || body.token === "") {
          updates.push(
            prisma.setting
              .delete({ where: { key: NAUTILUS_SETTINGS_KEYS.TOKEN } })
              .catch((err) => {
                // P2025 = record not found, legitimate when deleting an absent token
                if (err?.code !== "P2025") console.error("[Nautilus] token delete failed:", err);
              })
          );
        } else {
          // Encrypted at rest with the master secret (like agent private keys).
          const encrypted = encryptAES(body.token, process.env.ECDSA_MASTER_SECRET!);
          updates.push(
            prisma.setting.upsert({
              where: { key: NAUTILUS_SETTINGS_KEYS.TOKEN },
              create: { key: NAUTILUS_SETTINGS_KEYS.TOKEN, value: encrypted },
              update: { value: encrypted },
            })
          );
        }
      }
      await Promise.all(updates);

      const cfg = await getNautilusConfig();
      return reply.send({
        enabled: cfg.enabled,
        url: cfg.url,
        tokenConfigured: cfg.token !== null,
      });
    }
  );

  // Test the Nautilus connection (ADMIN)
  app.post(
    "/api/integrations/nautilus/test",
    { preHandler: [requireAdmin] },
    async (_request, reply) => {
      try {
        const snapshot = await fetchNautilusSnapshot();
        return reply.send({
          success: true,
          servers: snapshot.meta.totalServers,
          activeServers: snapshot.meta.activeServers,
          containers: snapshot.containers.length,
          durationMs: snapshot.scrapeDurationMs,
        });
      } catch (err: any) {
        return reply.code(502).send({
          success: false,
          error: err?.message || "Failed to fetch Nautilus metrics",
        });
      }
    }
  );

  // Returns the current snapshot (used by the Containers page)
  app.get(
    "/api/integrations/nautilus/snapshot",
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      try {
        const snapshot = await fetchNautilusSnapshot();
        return reply.send(snapshot);
      } catch (err: any) {
        return reply.code(502).send({
          error: err?.message || "Failed to fetch Nautilus metrics",
        });
      }
    }
  );
}
