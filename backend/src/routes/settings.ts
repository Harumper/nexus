import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAdmin } from "../middleware/auth.js";
import { sendTestEmail } from "../services/email.js";

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // List all settings
  app.get(
    "/api/settings",
    { preHandler: [requireAdmin] },
    async (_request, reply) => {
      const settings = await prisma.setting.findMany({
        orderBy: { key: "asc" },
      });

      return reply.send(settings);
    }
  );

  // Get single setting
  app.get(
    "/api/settings/:key",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { key } = request.params as { key: string };

      const setting = await prisma.setting.findUnique({ where: { key } });
      if (!setting) {
        return reply.code(404).send({ error: "Setting not found" });
      }

      return reply.send(setting);
    }
  );

  // Upsert setting
  app.put(
    "/api/settings/:key",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["value"],
          properties: {
            value: {},
          },
        },
      },
    },
    async (request, reply) => {
      const { key } = request.params as { key: string };
      const { value } = request.body as { value: any };

      const setting = await prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });

      return reply.send(setting);
    }
  );

  // Send a test email using the SMTP config in the request body (so the admin can
  // validate settings before saving). Returns the SMTP error on failure.
  app.post(
    "/api/settings/smtp/test",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "object" } },
        },
      },
    },
    async (request, reply) => {
      const { value } = request.body as { value: unknown };
      try {
        const { to } = await sendTestEmail(value);
        return reply.send({ success: true, to });
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message || "SMTP test failed" });
      }
    }
  );

  // Regenerate the webhook signing secret (crypto-random). The button used to
  // write the literal placeholder "__regenerate__" through the generic upsert,
  // which turned the HMAC key into a known constant.
  app.post(
    "/api/settings/webhook/regenerate",
    { preHandler: [requireAdmin] },
    async (_request, reply) => {
      const value = randomBytes(32).toString("hex");
      const setting = await prisma.setting.upsert({
        where: { key: "webhook_secret" },
        update: { value },
        create: { key: "webhook_secret", value },
      });
      return reply.send(setting);
    }
  );
}
