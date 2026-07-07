-- Track prometheus-node-exporter install intent per machine, for the Prometheus
-- http_sd targets endpoint (GET /api/prometheus/targets).
ALTER TABLE "Machine" ADD COLUMN "nodeExporter" BOOLEAN NOT NULL DEFAULT false;
