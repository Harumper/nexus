-- Drop Module table. The plugin module system (nautilus/zfs/backup skeletons)
-- was never implemented and removed. Docker management is handled externally
-- (Nautilus standalone tool).
DROP TABLE IF EXISTS "Module" CASCADE;
