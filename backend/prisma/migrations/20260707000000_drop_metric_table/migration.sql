-- Metrics are no longer persisted (live-only in-memory buffer; long-term history
-- is Prometheus/Grafana). Drop the Metric table and its indexes.
DROP TABLE IF EXISTS "Metric";
