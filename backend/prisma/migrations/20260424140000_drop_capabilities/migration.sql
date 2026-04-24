-- Drop Capability model. Replaced by Machine.type-based access control (PROBE/AGENT).
-- PROBE = read-only monitoring actions. AGENT = all actions allowed.

DROP TABLE IF EXISTS "MachineCapability" CASCADE;
DROP TABLE IF EXISTS "Capability" CASCADE;
