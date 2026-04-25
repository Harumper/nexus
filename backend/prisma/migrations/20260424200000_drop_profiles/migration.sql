-- Drop Profile and ProfileExecution tables.
-- Profiles redondaient avec les Bulk actions (multi-select machines + dispatch).
-- Le scheduler automatique n'a jamais ete implemente (initProfileScheduler stub),
-- et le type REBOOT etait SKIPPED. Suppression complete au profit des Bulk actions.

DROP TABLE IF EXISTS "ProfileExecution" CASCADE;
DROP TABLE IF EXISTS "Profile" CASCADE;
DROP TYPE IF EXISTS "ProfileType";
