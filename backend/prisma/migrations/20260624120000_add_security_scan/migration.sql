-- Historique des audits de durcissement (Lynis) : un enregistrement par scan,
-- pour tracer l'evolution de l'indice de durcissement et detecter les regressions.

-- CreateTable
CREATE TABLE "SecurityScan" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "hardeningIndex" INTEGER NOT NULL,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "suggestionCount" INTEGER NOT NULL DEFAULT 0,
    "lynisVersion" TEXT,
    "fail2banActive" BOOLEAN NOT NULL DEFAULT false,
    "autoUpdatesActive" BOOLEAN NOT NULL DEFAULT false,
    "sshHardened" BOOLEAN NOT NULL DEFAULT false,
    "firewallActive" BOOLEAN NOT NULL DEFAULT false,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityScan_machineId_scannedAt_idx" ON "SecurityScan"("machineId", "scannedAt");

-- AddForeignKey
ALTER TABLE "SecurityScan" ADD CONSTRAINT "SecurityScan_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
