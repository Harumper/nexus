-- Add multi-channel notification support to AlertRule.
-- Stores an array of {type: "DISCORD"|"SLACK"|"TEAMS"|"EMAIL"|"WEBHOOK", config: {...}}
-- Legacy fields notifyEmail (boolean) + notifyWebhook (string) are kept for
-- backwards-compat and still handled by the alert dispatcher.
ALTER TABLE "AlertRule" ADD COLUMN "channels" JSONB;
