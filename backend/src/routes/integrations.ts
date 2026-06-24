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
  // Retourne la config actuelle (url, enabled, token masque)
  app.get(
    "/api/integrations/nautilus/config",
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const cfg = await getNautilusConfig();
      return reply.send({
        enabled: cfg.enabled,
        url: cfg.url,
        // Ne jamais retourner le token en clair. Juste l'info qu'il est set.
        tokenConfigured: cfg.token !== null,
      });
    }
  );

  // Met a jour la config (ADMIN)
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
        // Validation URL minimale
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
        // Si token est null ou vide, on supprime le setting
        if (body.token === null || body.token === "") {
          updates.push(
            prisma.setting
              .delete({ where: { key: NAUTILUS_SETTINGS_KEYS.TOKEN } })
              .catch((err) => {
                // P2025 = record not found, légitime quand on supprime un token absent
                if (err?.code !== "P2025") console.error("[Nautilus] token delete failed:", err);
              })
          );
        } else {
          // Chiffré au repos avec le master secret (comme les clés privées agent).
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

  // Test la connexion Nautilus (ADMIN)
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

  // Retourne le snapshot courant (utilise par la page Containers)
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
