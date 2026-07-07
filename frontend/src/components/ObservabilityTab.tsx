import NodeExporterCard from "./NodeExporterCard";
import LogShippingTab from "./LogShippingTab";

// Observability tab = metrics (node-exporter) + logs (log shipping). Nexus wires
// the exporters/shippers on the host; the data itself lives in Prometheus/Grafana
// and Loki — Nexus is a control plane, not an observability platform.
export default function ObservabilityTab({ machineId }: { machineId: string }) {
  return (
    <div className="space-y-6">
      <NodeExporterCard machineId={machineId} />
      <LogShippingTab machineId={machineId} />
    </div>
  );
}
