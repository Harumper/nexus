-- CreateTable
CREATE TABLE "BootstrapToken" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BootstrapToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BootstrapToken_tokenHash_key" ON "BootstrapToken"("tokenHash");

-- CreateIndex
CREATE INDEX "BootstrapToken_machineId_purpose_idx" ON "BootstrapToken"("machineId", "purpose");

-- CreateIndex
CREATE INDEX "BootstrapToken_expiresAt_idx" ON "BootstrapToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "BootstrapToken" ADD CONSTRAINT "BootstrapToken_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
