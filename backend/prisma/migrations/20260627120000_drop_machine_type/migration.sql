-- NEXUS-AGENT-007 (requalifié) — retrait du type PROBE : un seul type d'agent.
-- Le code ne lit plus Machine.type (commit applicatif précédent) ; on droppe la
-- colonne et l'enum MachineType. Idempotent (IF EXISTS) pour les bases déjà à jour.

ALTER TABLE "Machine" DROP COLUMN IF EXISTS "type";
DROP TYPE IF EXISTS "MachineType";
