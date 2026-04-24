import { useState, useEffect, useCallback } from "react";
import { X, RefreshCw, Loader2 } from "lucide-react";
import { api } from "../services/api";

interface LogsDrawerProps {
  machineId: string;
  service: string;
  onClose: () => void;
}

export default function LogsDrawer({ machineId, service, onClose }: LogsDrawerProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lineCount, setLineCount] = useState(100);
  const [since, setSince] = useState<string>("");
  const [truncated, setTruncated] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.getServiceLogs(machineId, service, lineCount, since || undefined);
      setLines(res?.data?.lines || []);
      setTruncated(res?.data?.truncated || false);
    } catch (err: any) {
      setError(err?.message || "Erreur de chargement des logs");
    } finally {
      setLoading(false);
    }
  }, [machineId, service, lineCount, since]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-5xl h-[85vh] bg-card border border-border rounded-t-xl sm:rounded-xl shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Logs — <span className="font-mono text-xs">{service}</span>
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {lines.length} lignes{truncated ? " (tronqué)" : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={lineCount}
              onChange={(e) => setLineCount(Number(e.target.value))}
              className="rounded border border-input bg-background px-2 py-1 text-xs"
            >
              <option value={100}>100</option>
              <option value={500}>500</option>
              <option value={1000}>1000</option>
            </select>
            <select
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="rounded border border-input bg-background px-2 py-1 text-xs"
            >
              <option value="">Tout</option>
              <option value="5m">5 min</option>
              <option value="1h">1 h</option>
              <option value="1d">1 jour</option>
              <option value="today">Aujourd'hui</option>
            </select>
            <button
              onClick={load}
              disabled={loading}
              className="p-1.5 rounded hover:bg-muted transition-colors"
              title="Rafraîchir"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </button>
            <button onClick={onClose} className="p-1.5 rounded hover:bg-muted transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto bg-black/40 font-mono text-xs">
          {error ? (
            <div className="p-4 text-destructive">{error}</div>
          ) : loading ? (
            <div className="p-4 text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Chargement...
            </div>
          ) : (
            <pre className="p-4 whitespace-pre-wrap break-words" style={{ color: "var(--nx-text-weak)" }}>
              {lines.length > 0 ? lines.join("\n") : "(aucun log)"}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
