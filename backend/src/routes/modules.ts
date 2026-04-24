import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

export async function moduleRoutes(app: FastifyInstance): Promise<void> {
  // List all modules
  app.get(
    "/api/modules",
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const modules = await prisma.module.findMany({
        orderBy: { name: "asc" },
      });
      return reply.send(modules);
    }
  );

  // Get module detail
  app.get(
    "/api/modules/:name",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { name } = request.params as { name: string };
      const module = await prisma.module.findUnique({ where: { name } });
      if (!module) {
        return reply.code(404).send({ error: "Module not found" });
      }
      return reply.send(module);
    }
  );

  // Register a module (called when a module connects to the agent)
  app.post(
    "/api/modules",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["name", "version", "capability", "actions"],
          properties: {
            name: { type: "string", minLength: 1 },
            version: { type: "string" },
            description: { type: "string" },
            capability: { type: "string" },
            actions: { type: "array", items: { type: "string" } },
            config: { type: "object" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        name: string;
        version: string;
        description?: string;
        capability: string;
        actions: string[];
        config?: Record<string, unknown>;
      };

      const module = await prisma.module.upsert({
        where: { name: body.name },
        update: {
          version: body.version,
          description: body.description,
          capability: body.capability,
          actions: body.actions,
          config: body.config as any,
        },
        create: {
          name: body.name,
          version: body.version,
          description: body.description,
          capability: body.capability,
          actions: body.actions,
          config: body.config as any,
        },
      });

      return reply.code(201).send(module);
    }
  );

  // Enable/disable module
  app.post(
    "/api/modules/:name/enable",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { name } = request.params as { name: string };
      const module = await prisma.module.update({
        where: { name },
        data: { enabled: true },
      });
      return reply.send(module);
    }
  );

  app.post(
    "/api/modules/:name/disable",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { name } = request.params as { name: string };
      const module = await prisma.module.update({
        where: { name },
        data: { enabled: false },
      });
      return reply.send(module);
    }
  );

  // Update module config
  app.put(
    "/api/modules/:name/config",
    {
      preHandler: [requireAdmin],
      schema: {
        body: { type: "object" },
      },
    },
    async (request, reply) => {
      const { name } = request.params as { name: string };
      const config = request.body;

      const module = await prisma.module.update({
        where: { name },
        data: { config: config as any },
      });

      return reply.send(module);
    }
  );

  // Delete module
  app.delete(
    "/api/modules/:name",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { name } = request.params as { name: string };
      await prisma.module.delete({ where: { name } });
      return reply.code(204).send();
    }
  );
}
