import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAuth, requireAdmin, getUserFromRequest } from "../middleware/auth.js";
import { broadcastToDashboard } from "../websocket/dashboard.js";

export async function alertRoutes(app: FastifyInstance): Promise<void> {
  // List alert rules
  app.get(
    "/api/alerts/rules",
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const rules = await prisma.alertRule.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          _count: {
            select: {
              states: { where: { status: "FIRING" } },
            },
          },
        },
      });

      return reply.send(
        rules.map((r) => ({
          ...r,
          firingCount: r._count.states,
        }))
      );
    }
  );

  // Create alert rule
  app.post(
    "/api/alerts/rules",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["name", "conditionType"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            description: { type: "string" },
            severity: { type: "string", enum: ["INFO", "WARNING", "CRITICAL"] },
            conditionType: {
              type: "string",
              enum: [
                "CPU_ABOVE", "MEMORY_ABOVE", "DISK_ABOVE", "MACHINE_OFFLINE", "LOAD_ABOVE",
                "SERVICE_FAILED", "TIMER_FAILED", "CRON_FAILED", "UPDATES_AVAILABLE", "CERT_EXPIRING",
              ],
            },
            threshold: { type: "number" },
            targetPattern: { type: "string", maxLength: 128 },
            durationSeconds: { type: "number", minimum: 0 },
            machineIds: { type: "array", items: { type: "string" } },
            cooldownSeconds: { type: "number", minimum: 0 },
            notifyEmail: { type: "boolean" },
            notifyWebhook: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as any;
      const user = getUserFromRequest(request);

      const rule = await prisma.alertRule.create({
        data: {
          name: body.name,
          description: body.description,
          severity: body.severity || "WARNING",
          conditionType: body.conditionType,
          threshold: body.threshold,
          targetPattern: body.targetPattern || null,
          durationSeconds: body.durationSeconds || 0,
          machineIds: body.machineIds || [],
          cooldownSeconds: body.cooldownSeconds || 300,
          notifyEmail: body.notifyEmail || false,
          notifyWebhook: body.notifyWebhook,
          createdBy: user?.sub,
        },
      });

      return reply.code(201).send(rule);
    }
  );

  // Update alert rule
  app.put(
    "/api/alerts/rules/:id",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            description: { type: "string" },
            enabled: { type: "boolean" },
            severity: { type: "string", enum: ["INFO", "WARNING", "CRITICAL"] },
            threshold: { type: "number" },
            targetPattern: { type: "string", maxLength: 128 },
            durationSeconds: { type: "number" },
            machineIds: { type: "array", items: { type: "string" } },
            cooldownSeconds: { type: "number" },
            notifyEmail: { type: "boolean" },
            notifyWebhook: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as any;

      const rule = await prisma.alertRule.update({
        where: { id },
        data: body,
      });

      return reply.send(rule);
    }
  );

  // Delete alert rule
  app.delete(
    "/api/alerts/rules/:id",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await prisma.alertRule.delete({ where: { id } });
      return reply.code(204).send();
    }
  );

  // Get active alerts (currently firing)
  app.get(
    "/api/alerts/active",
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const alerts = await prisma.alertState.findMany({
        where: { status: { in: ["FIRING", "ACKNOWLEDGED"] } },
        include: {
          rule: { select: { name: true, severity: true, conditionType: true } },
          machine: { select: { id: true, name: true, hostname: true } },
        },
        orderBy: { firedAt: "desc" },
      });

      return reply.send(alerts);
    }
  );

  // Get alert history
  app.get(
    "/api/alerts/history",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { limit = "50", offset = "0", machineId } = request.query as {
        limit?: string;
        offset?: string;
        machineId?: string;
      };

      const where: any = {};
      if (machineId) where.machineId = machineId;

      const alerts = await prisma.alertState.findMany({
        where,
        include: {
          rule: { select: { name: true, severity: true, conditionType: true } },
          machine: { select: { id: true, name: true } },
        },
        orderBy: { firedAt: "desc" },
        take: parseInt(limit, 10),
        skip: parseInt(offset, 10),
      });

      const total = await prisma.alertState.count({ where });

      return reply.send({ alerts, total });
    }
  );

  // Acknowledge alert
  app.post(
    "/api/alerts/:id/acknowledge",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = getUserFromRequest(request);

      const alert = await prisma.alertState.update({
        where: { id },
        data: {
          status: "ACKNOWLEDGED",
          acknowledgedAt: new Date(),
          acknowledgedBy: user?.username,
        },
      });

      broadcastToDashboard({
        type: "alert.acknowledged",
        data: { id: alert.id, acknowledgedBy: user?.username },
      });

      return reply.send(alert);
    }
  );

  // Resolve alert manually
  app.post(
    "/api/alerts/:id/resolve",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const alert = await prisma.alertState.update({
        where: { id },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
        },
      });

      broadcastToDashboard({
        type: "alert.resolved",
        data: { id: alert.id },
      });

      return reply.send(alert);
    }
  );
}
