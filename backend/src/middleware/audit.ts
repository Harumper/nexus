import { prisma } from "../services/database.js";
import type { AuditAction } from "@prisma/client";

export async function logAudit(params: {
  action: AuditAction;
  resource: string;
  resourceId?: string;
  userId?: string;
  machineId?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: params.action,
        resource: params.resource,
        resourceId: params.resourceId,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        details: params.details as any,
        ...(params.userId ? { user: { connect: { id: params.userId } } } : {}),
        ...(params.machineId ? { machine: { connect: { id: params.machineId } } } : {}),
      },
    });
  } catch (err) {
    console.error("[Audit] Failed to log:", err);
  }
}
