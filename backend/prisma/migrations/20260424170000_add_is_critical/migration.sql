-- Flag isCritical sur Machine : bloque reboot, stop/restart de services critiques,
-- et retrait de paquets critiques (docker, nginx, postgresql, etc.).
ALTER TABLE "Machine" ADD COLUMN "isCritical" BOOLEAN NOT NULL DEFAULT false;
