import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../middleware/auth.js";
import { prisma } from "../services/database.js";
import { executeProfile } from "../services/profile-engine.js";

const VALID_PROFILE_TYPES = ["UPGRADE", "REBOOT", "SCRIPT", "PACKAGE"];

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  // List all profiles with execution count and last execution date
  app.get(
    "/api/profiles",
    { preHandler: [requireAdmin] },
    async (_request, reply) => {
      const profiles = await prisma.profile.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { executions: true } },
          executions: {
            orderBy: { startedAt: "desc" },
            take: 1,
            select: { startedAt: true, status: true },
          },
          creator: {
            select: { id: true, username: true },
          },
        },
      });

      const result = profiles.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        description: p.description,
        config: p.config,
        enabled: p.enabled,
        tagFilters: p.tagFilters,
        createdBy: p.createdBy,
        creator: p.creator,
        executionCount: p._count.executions,
        lastExecution: p.executions[0]?.startedAt ?? null,
        lastExecutionStatus: p.executions[0]?.status ?? null,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }));

      return reply.send(result);
    }
  );

  // Get profile detail with recent executions
  app.get(
    "/api/profiles/:id",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const profile = await prisma.profile.findUnique({
        where: { id },
        include: {
          creator: { select: { id: true, username: true } },
          executions: {
            orderBy: { startedAt: "desc" },
            take: 20,
            include: {
              machine: {
                select: { id: true, hostname: true },
              },
            },
          },
        },
      });

      if (!profile) {
        return reply.code(404).send({ error: "Profile not found" });
      }

      return reply.send(profile);
    }
  );

  // Create profile
  app.post(
    "/api/profiles",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["name", "type", "config"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            type: { type: "string", enum: VALID_PROFILE_TYPES },
            description: { type: "string", maxLength: 500 },
            config: { type: "object" },
            enabled: { type: "boolean" },
            tagFilters: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        name: string;
        type: string;
        description?: string;
        config: Record<string, any>;
        enabled?: boolean;
        tagFilters?: string[];
      };
      const user = (request as any).user;

      // Check for duplicate name
      const existing = await prisma.profile.findUnique({
        where: { name: body.name },
      });
      if (existing) {
        return reply
          .code(409)
          .send({ error: "A profile with this name already exists" });
      }

      const profile = await prisma.profile.create({
        data: {
          name: body.name,
          type: body.type as any,
          description: body.description,
          config: body.config as any,
          enabled: body.enabled ?? true,
          tagFilters: body.tagFilters ?? [],
          createdBy: user?.sub,
        },
        include: {
          creator: { select: { id: true, username: true } },
        },
      });

      return reply.code(201).send(profile);
    }
  );

  // Update profile
  app.put(
    "/api/profiles/:id",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            type: { type: "string", enum: VALID_PROFILE_TYPES },
            description: { type: "string", maxLength: 500 },
            config: { type: "object" },
            enabled: { type: "boolean" },
            tagFilters: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        type?: string;
        description?: string;
        config?: Record<string, any>;
        enabled?: boolean;
        tagFilters?: string[];
      };

      const existing = await prisma.profile.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: "Profile not found" });
      }

      // Check name uniqueness if name is being changed
      if (body.name && body.name !== existing.name) {
        const duplicate = await prisma.profile.findUnique({
          where: { name: body.name },
        });
        if (duplicate) {
          return reply
            .code(409)
            .send({ error: "A profile with this name already exists" });
        }
      }

      const profile = await prisma.profile.update({
        where: { id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.type !== undefined && { type: body.type as any }),
          ...(body.description !== undefined && {
            description: body.description,
          }),
          ...(body.config !== undefined && { config: body.config as any }),
          ...(body.enabled !== undefined && { enabled: body.enabled }),
          ...(body.tagFilters !== undefined && { tagFilters: body.tagFilters }),
        },
        include: {
          creator: { select: { id: true, username: true } },
        },
      });

      return reply.send(profile);
    }
  );

  // Delete profile (cascades executions)
  app.delete(
    "/api/profiles/:id",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const existing = await prisma.profile.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: "Profile not found" });
      }

      // Delete executions first, then profile
      await prisma.profileExecution.deleteMany({
        where: { profileId: id },
      });
      await prisma.profile.delete({ where: { id } });

      return reply.send({ success: true, message: "Profile deleted" });
    }
  );

  // List executions for a profile with pagination
  app.get(
    "/api/profiles/:id/executions",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { page?: string; limit?: string };

      const page = Math.max(1, parseInt(query.page || "1", 10));
      const limit = Math.min(100, Math.max(1, parseInt(query.limit || "20", 10)));
      const skip = (page - 1) * limit;

      const existing = await prisma.profile.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: "Profile not found" });
      }

      const [executions, total] = await Promise.all([
        prisma.profileExecution.findMany({
          where: { profileId: id },
          orderBy: { startedAt: "desc" },
          skip,
          take: limit,
          include: {
            machine: {
              select: { id: true, hostname: true },
            },
          },
        }),
        prisma.profileExecution.count({ where: { profileId: id } }),
      ]);

      return reply.send({
        data: executions,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    }
  );

  // Manually trigger profile execution
  app.post(
    "/api/profiles/:id/execute",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const result = await executeProfile(id);

      if (!result.success) {
        return reply.code(400).send({ error: result.error });
      }

      return reply.send({
        success: true,
        totalMachines: result.totalMachines,
        dispatched: result.dispatched,
        skipped: result.skipped,
        failed: result.failed,
      });
    }
  );
}
