import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAuth } from "../middleware/auth.js";
import type { AuditAction, Prisma } from "@prisma/client";

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  // List audit logs with filters
  app.get(
    "/api/audit",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const {
        action,
        resource,
        machineId,
        userId,
        from,
        to,
        limit = "50",
        offset = "0",
        search,
      } = request.query as {
        action?: string;
        resource?: string;
        machineId?: string;
        userId?: string;
        from?: string;
        to?: string;
        limit?: string;
        offset?: string;
        search?: string;
      };

      const where: Prisma.AuditLogWhereInput = {};

      if (action) where.action = action as AuditAction;
      if (resource) where.resource = resource;
      if (machineId) where.machineId = machineId;
      if (userId) where.userId = userId;

      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from);
        if (to) where.createdAt.lte = new Date(to);
      }

      // Text search in the details (resourceId or details JSON)
      if (search) {
        where.OR = [
          { resourceId: { contains: search, mode: "insensitive" } },
          { resource: { contains: search, mode: "insensitive" } },
        ];
      }

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          include: {
            user: { select: { id: true, username: true } },
            machine: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "desc" },
          take: Math.min(parseInt(limit, 10), 200),
          skip: parseInt(offset, 10),
        }),
        prisma.auditLog.count({ where }),
      ]);

      return reply.send({
        logs,
        total,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      });
    }
  );

  // Get single audit log detail
  app.get(
    "/api/audit/:id",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const log = await prisma.auditLog.findUnique({
        where: { id },
        include: {
          user: { select: { id: true, username: true, email: true } },
          machine: { select: { id: true, name: true, hostname: true } },
        },
      });

      if (!log) {
        return reply.code(404).send({ error: "Audit log not found" });
      }

      return reply.send(log);
    }
  );

  // Get audit stats (action counts for last 24h)
  app.get(
    "/api/audit/stats",
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const stats = await prisma.auditLog.groupBy({
        by: ["action"],
        where: { createdAt: { gte: since } },
        _count: { action: true },
        orderBy: { _count: { action: "desc" } },
      });

      const total = await prisma.auditLog.count({
        where: { createdAt: { gte: since } },
      });

      return reply.send({
        period: "24h",
        total,
        byAction: stats.map((s) => ({
          action: s.action,
          count: s._count.action,
        })),
      });
    }
  );
}
