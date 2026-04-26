import { useState, useEffect, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../services/api";
import { Drawer, Button, Spinner } from "./ui";
import { getErrorMessage } from "../services/errors";

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
    } catch (err) {
      setError(getErrorMessage(err, "Erreur de chargement des logs"));
    } finally {
      setLoading(false);
    }
  }, [machineId, service, lineCount, since]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Drawer
      open
      onClose={onClose}
      className="!max-w-5xl"
      title={
        <span>
          Logs — <span className="font-mono text-xs">{service}</span>
        </span>
      }
      description={`${lines.length} lignes${truncated ? " (tronqué)" : ""}`}
    >
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 p-3 border-b border-border bg-card">
          <select
            value={lineCount}
            onChange={(e) => setLineCount(Number(e.target.value))}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value={100}>100 lignes</option>
            <option value={500}>500 lignes</option>
            <option value={1000}>1000 lignes</option>
          </select>
          <select
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Tout</option>
            <option value="5m">5 min</option>
            <option value="1h">1 h</option>
            <option value="1d">1 jour</option>
            <option value="today">Aujourd'hui</option>
          </select>
          <Button
            variant="ghost"
            size="sm"
            onClick={load}
            loading={loading}
            icon={<RefreshCw />}
            aria-label="Rafraîchir"
          />
        </div>

        <div className="flex-1 overflow-auto bg-black/40 font-mono text-xs">
          {error ? (
            <div className="p-4 text-destructive">{error}</div>
          ) : loading ? (
            <div className="p-4 text-muted-foreground flex items-center gap-2">
              <Spinner size="sm" /> Chargement...
            </div>
          ) : (
            <pre className="p-4 whitespace-pre-wrap break-words text-muted-foreground">
              {lines.length > 0 ? lines.join("\n") : "(aucun log)"}
            </pre>
          )}
        </div>
      </div>
    </Drawer>
  );
}
