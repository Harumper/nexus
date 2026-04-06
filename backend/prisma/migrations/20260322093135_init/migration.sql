-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OPERATOR', 'READONLY');

-- CreateEnum
CREATE TYPE "MachineStatus" AS ENUM ('ENROLLMENT_PENDING', 'ONLINE', 'OFFLINE', 'DEGRADED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('LOGIN', 'LOGOUT', 'MACHINE_CREATE', 'MACHINE_UPDATE', 'MACHINE_DELETE', 'MACHINE_ENROLL', 'MACHINE_REVOKE', 'ACTION_REQUEST', 'ACTION_COMPLETE', 'ACTION_FAILED', 'CAPABILITY_GRANT', 'CAPABILITY_REVOKE', 'CERT_ROTATE', 'CERT_REVOKE', 'SECURITY_ALERT', 'ALERT_TRIGGERED', 'ALERT_RESOLVED', 'UPDATE_START', 'UPDATE_COMPLETE', 'UPDATE_FAILED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertConditionType" AS ENUM ('CPU_ABOVE', 'MEMORY_ABOVE', 'DISK_ABOVE', 'MACHINE_OFFLINE', 'LOAD_ABOVE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('FIRING', 'RESOLVED', 'ACKNOWLEDGED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'OPERATOR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLogin" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Machine" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT,
    "os" TEXT,
    "osVersion" TEXT,
    "arch" TEXT,
    "ipAddress" TEXT,
    "agentVersion" TEXT,
    "status" "MachineStatus" NOT NULL DEFAULT 'ENROLLMENT_PENDING',
    "enrollmentToken" TEXT,
    "enrollmentExpiry" TIMESTAMP(3),
    "enrolledAt" TIMESTAMP(3),
    "backendPrivateKey" TEXT,
    "backendPublicKey" TEXT,
    "agentPublicKey" TEXT,
    "sharedSecret" TEXT,
    "boundIp" TEXT,
    "keyRevokedAt" TIMESTAMP(3),
    "keyRevokedReason" TEXT,
    "lastHeartbeat" TIMESTAMP(3),
    "lastMetrics" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Capability" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "actions" TEXT[],
    "isBuiltin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineCapability" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" TEXT,

    CONSTRAINT "MachineCapability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Metric" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "cpuPercent" DOUBLE PRECISION NOT NULL,
    "memoryUsed" BIGINT NOT NULL,
    "memoryTotal" BIGINT NOT NULL,
    "memoryPercent" DOUBLE PRECISION NOT NULL,
    "disks" JSONB NOT NULL,
    "network" JSONB,
    "loadAvg1" DOUBLE PRECISION,
    "loadAvg5" DOUBLE PRECISION,
    "loadAvg15" DOUBLE PRECISION,
    "uptime" BIGINT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Metric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineEvent" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MachineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT,
    "machineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARNING',
    "conditionType" "AlertConditionType" NOT NULL,
    "threshold" DOUBLE PRECISION,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "machineIds" TEXT[],
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 300,
    "notifyEmail" BOOLEAN NOT NULL DEFAULT false,
    "notifyWebhook" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertState" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'FIRING',
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "lastNotified" TIMESTAMP(3),
    "details" JSONB,

    CONSTRAINT "AlertState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Module" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "capability" TEXT NOT NULL,
    "actions" TEXT[],
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_enrollmentToken_key" ON "Machine"("enrollmentToken");

-- CreateIndex
CREATE INDEX "Machine_status_idx" ON "Machine"("status");

-- CreateIndex
CREATE INDEX "Machine_name_idx" ON "Machine"("name");

-- CreateIndex
CREATE INDEX "Machine_lastHeartbeat_idx" ON "Machine"("lastHeartbeat");

-- CreateIndex
CREATE INDEX "Machine_enrollmentToken_idx" ON "Machine"("enrollmentToken");

-- CreateIndex
CREATE UNIQUE INDEX "Capability_name_key" ON "Capability"("name");

-- CreateIndex
CREATE INDEX "MachineCapability_machineId_idx" ON "MachineCapability"("machineId");

-- CreateIndex
CREATE INDEX "MachineCapability_capabilityId_idx" ON "MachineCapability"("capabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "MachineCapability_machineId_capabilityId_key" ON "MachineCapability"("machineId", "capabilityId");

-- CreateIndex
CREATE INDEX "Metric_machineId_timestamp_idx" ON "Metric"("machineId", "timestamp");

-- CreateIndex
CREATE INDEX "Metric_timestamp_idx" ON "Metric"("timestamp");

-- CreateIndex
CREATE INDEX "MachineEvent_machineId_timestamp_idx" ON "MachineEvent"("machineId", "timestamp");

-- CreateIndex
CREATE INDEX "MachineEvent_type_timestamp_idx" ON "MachineEvent"("type", "timestamp");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_machineId_createdAt_idx" ON "AuditLog"("machineId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AlertRule_enabled_idx" ON "AlertRule"("enabled");

-- CreateIndex
CREATE INDEX "AlertRule_conditionType_idx" ON "AlertRule"("conditionType");

-- CreateIndex
CREATE INDEX "AlertState_machineId_idx" ON "AlertState"("machineId");

-- CreateIndex
CREATE INDEX "AlertState_status_idx" ON "AlertState"("status");

-- CreateIndex
CREATE INDEX "AlertState_firedAt_idx" ON "AlertState"("firedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlertState_ruleId_machineId_status_key" ON "AlertState"("ruleId", "machineId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Module_name_key" ON "Module"("name");

-- AddForeignKey
ALTER TABLE "MachineCapability" ADD CONSTRAINT "MachineCapability_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineCapability" ADD CONSTRAINT "MachineCapability_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Metric" ADD CONSTRAINT "Metric_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineEvent" ADD CONSTRAINT "MachineEvent_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertState" ADD CONSTRAINT "AlertState_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertState" ADD CONSTRAINT "AlertState_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
