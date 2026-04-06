import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAdmin } from "../middleware/auth.js";

export async function tagRoutes(app: FastifyInstance): Promise<void> {
  // List all tags with machine count
  app.get(
    "/api/tags",
    { preHandler: [requireAdmin] },
    async (_request, reply) => {
      const tags = await prisma.tag.findMany({
        include: {
          _count: { select: { machines: true } },
        },
        orderBy: { name: "asc" },
      });

      return reply.send(tags);
    }
  );

  // Create tag
  app.post(
    "/api/tags",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 50 },
            color: { type: "string", maxLength: 7 },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, color } = request.body as { name: string; color?: string };

      const existing = await prisma.tag.findUnique({ where: { name } });
      if (existing) {
        return reply.code(409).send({ error: "Tag with this name already exists" });
      }

      const tag = await prisma.tag.create({
        data: { name, color },
      });

      return reply.code(201).send(tag);
    }
  );

  // Update tag
  app.put(
    "/api/tags/:id",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 50 },
            color: { type: "string", maxLength: 7 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { name, color } = request.body as { name?: string; color?: string };

      const tag = await prisma.tag.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(color !== undefined && { color }),
        },
      });

      return reply.send(tag);
    }
  );

  // Delete tag (cascade removes MachineTag)
  app.delete(
    "/api/tags/:id",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      await prisma.tag.delete({ where: { id } });

      return reply.code(204).send();
    }
  );

  // Assign tag to machine
  app.post(
    "/api/machines/:machineId/tags",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["tagId"],
          properties: {
            tagId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { machineId } = request.params as { machineId: string };
      const { tagId } = request.body as { tagId: string };

      const existing = await prisma.machineTag.findUnique({
        where: { machineId_tagId: { machineId, tagId } },
      });
      if (existing) {
        return reply.code(409).send({ error: "Tag already assigned to this machine" });
      }

      const machineTag = await prisma.machineTag.create({
        data: { machineId, tagId },
        include: { tag: true },
      });

      return reply.code(201).send(machineTag);
    }
  );

  // Remove tag from machine
  app.delete(
    "/api/machines/:machineId/tags/:tagId",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { machineId, tagId } = request.params as { machineId: string; tagId: string };

      await prisma.machineTag.delete({
        where: { machineId_tagId: { machineId, tagId } },
      });

      return reply.code(204).send();
    }
  );
}
