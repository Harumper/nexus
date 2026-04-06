import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAdmin } from "../middleware/auth.js";

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
}
