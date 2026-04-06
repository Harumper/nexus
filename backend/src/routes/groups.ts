import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAdmin } from "../middleware/auth.js";

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  // List all groups with member count
  app.get(
    "/api/groups",
    { preHandler: [requireAdmin] },
    async (_request, reply) => {
      const groups = await prisma.machineGroup.findMany({
        include: {
          _count: { select: { members: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      return reply.send(groups);
    }
  );

  // Create group
  app.post(
    "/api/groups",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["name", "type"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            description: { type: "string", maxLength: 500 },
            type: { type: "string", enum: ["STATIC", "DYNAMIC"] },
            filter: {
              type: "object",
              properties: {
                tags: { type: "array", items: { type: "string" } },
                status: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, description, type, filter } = request.body as {
        name: string;
        description?: string;
        type: "STATIC" | "DYNAMIC";
        filter?: { tags?: string[]; status?: string[] };
      };

      const group = await prisma.machineGroup.create({
        data: {
          name,
          description,
          type,
          filter: filter ?? undefined,
        },
      });

      return reply.code(201).send(group);
    }
  );

  // Update group
  app.put(
    "/api/groups/:id",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            description: { type: "string", maxLength: 500 },
            type: { type: "string", enum: ["STATIC", "DYNAMIC"] },
            filter: {
              type: "object",
              properties: {
                tags: { type: "array", items: { type: "string" } },
                status: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { name, description, type, filter } = request.body as {
        name?: string;
        description?: string;
        type?: "STATIC" | "DYNAMIC";
        filter?: { tags?: string[]; status?: string[] };
      };

      const group = await prisma.machineGroup.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(type !== undefined && { type }),
          ...(filter !== undefined && { filter }),
        },
      });

      return reply.send(group);
    }
  );

  // Delete group
  app.delete(
    "/api/groups/:id",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      await prisma.machineGroup.delete({ where: { id } });

      return reply.code(204).send();
    }
  );

  // Get group machines (resolve members)
  app.get(
    "/api/groups/:id/machines",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const group = await prisma.machineGroup.findUnique({ where: { id } });
      if (!group) {
        return reply.code(404).send({ error: "Group not found" });
      }

      if (group.type === "STATIC") {
        const members = await prisma.machineGroupMember.findMany({
          where: { groupId: id },
          include: { machine: true },
        });

        return reply.send(members.map((m) => m.machine));
      }

      // DYNAMIC: evaluate filter
      const filter = group.filter as { tags?: string[]; status?: string[] } | null;
      const where: any = {};

      if (filter?.tags && filter.tags.length > 0) {
        // Machines that have ALL specified tags
        where.AND = filter.tags.map((tagName: string) => ({
          tags: {
            some: {
              tag: { name: tagName },
            },
          },
        }));
      }

      if (filter?.status && filter.status.length > 0) {
        where.status = { in: filter.status };
      }

      const machines = await prisma.machine.findMany({ where });

      return reply.send(machines);
    }
  );

  // Add machine to static group
  app.post(
    "/api/groups/:id/members",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["machineId"],
          properties: {
            machineId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { machineId } = request.body as { machineId: string };

      const group = await prisma.machineGroup.findUnique({ where: { id } });
      if (!group) {
        return reply.code(404).send({ error: "Group not found" });
      }
      if (group.type === "DYNAMIC") {
        return reply.code(400).send({ error: "Cannot manually add members to a dynamic group" });
      }

      const member = await prisma.machineGroupMember.create({
        data: { groupId: id, machineId },
        include: { machine: true },
      });

      return reply.code(201).send(member);
    }
  );

  // Remove machine from static group
  app.delete(
    "/api/groups/:id/members/:machineId",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id, machineId } = request.params as { id: string; machineId: string };

      await prisma.machineGroupMember.delete({
        where: { groupId_machineId: { groupId: id, machineId } },
      });

      return reply.code(204).send();
    }
  );
}
