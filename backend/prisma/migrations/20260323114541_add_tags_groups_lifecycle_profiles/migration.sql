-- CreateEnum
CREATE TYPE "MachineType" AS ENUM ('AGENT', 'PROBE');

-- CreateEnum
CREATE TYPE "GroupType" AS ENUM ('STATIC', 'DYNAMIC');

-- CreateEnum
CREATE TYPE "ProfileType" AS ENUM ('UPGRADE', 'REBOOT', 'SCRIPT', 'PACKAGE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MachineStatus" ADD VALUE 'STALE';
ALTER TYPE "MachineStatus" ADD VALUE 'ARCHIVED';

-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "rebootRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "type" "MachineType" NOT NULL DEFAULT 'AGENT';

-- AlterTable
ALTER TABLE "Metric" ADD COLUMN     "processes" JSONB;

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineTag" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MachineTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "GroupType" NOT NULL DEFAULT 'STATIC',
    "filter" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineGroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MachineGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ProfileType" NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "tagFilters" TEXT[],
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileExecution" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "output" JSONB,

    CONSTRAINT "ProfileExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");

-- CreateIndex
CREATE INDEX "MachineTag_machineId_idx" ON "MachineTag"("machineId");

-- CreateIndex
CREATE INDEX "MachineTag_tagId_idx" ON "MachineTag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "MachineTag_machineId_tagId_key" ON "MachineTag"("machineId", "tagId");

-- CreateIndex
CREATE UNIQUE INDEX "MachineGroup_name_key" ON "MachineGroup"("name");

-- CreateIndex
CREATE INDEX "MachineGroupMember_groupId_idx" ON "MachineGroupMember"("groupId");

-- CreateIndex
CREATE INDEX "MachineGroupMember_machineId_idx" ON "MachineGroupMember"("machineId");

-- CreateIndex
CREATE UNIQUE INDEX "MachineGroupMember_groupId_machineId_key" ON "MachineGroupMember"("groupId", "machineId");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_name_key" ON "Profile"("name");

-- CreateIndex
CREATE INDEX "Profile_enabled_idx" ON "Profile"("enabled");

-- CreateIndex
CREATE INDEX "Profile_type_idx" ON "Profile"("type");

-- CreateIndex
CREATE INDEX "ProfileExecution_profileId_startedAt_idx" ON "ProfileExecution"("profileId", "startedAt");

-- CreateIndex
CREATE INDEX "ProfileExecution_machineId_idx" ON "ProfileExecution"("machineId");

-- CreateIndex
CREATE INDEX "Machine_type_idx" ON "Machine"("type");

-- AddForeignKey
ALTER TABLE "MachineTag" ADD CONSTRAINT "MachineTag_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineTag" ADD CONSTRAINT "MachineTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineGroupMember" ADD CONSTRAINT "MachineGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "MachineGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineGroupMember" ADD CONSTRAINT "MachineGroupMember_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileExecution" ADD CONSTRAINT "ProfileExecution_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileExecution" ADD CONSTRAINT "ProfileExecution_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
