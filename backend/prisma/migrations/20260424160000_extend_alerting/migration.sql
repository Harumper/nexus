-- Extend AlertConditionType enum with systemd/cron/updates/certs conditions
ALTER TYPE "AlertConditionType" ADD VALUE 'SERVICE_FAILED';
ALTER TYPE "AlertConditionType" ADD VALUE 'TIMER_FAILED';
ALTER TYPE "AlertConditionType" ADD VALUE 'CRON_FAILED';
ALTER TYPE "AlertConditionType" ADD VALUE 'UPDATES_AVAILABLE';
ALTER TYPE "AlertConditionType" ADD VALUE 'CERT_EXPIRING';

-- Add targetPattern column on AlertRule (nullable, used for SERVICE_FAILED filter etc)
ALTER TABLE "AlertRule" ADD COLUMN "targetPattern" TEXT;
