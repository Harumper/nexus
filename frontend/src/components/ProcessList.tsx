import { useState, useCallback, useEffect } from "react";
import { RefreshCw, Skull, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useConfirm } from "./ui";

interface ProcessInfo {
  pid: number;
  name: string;
  cpu_percent: number;
  mem_percent: number;
  mem_rss: number;
  user: string;
  command: string;
}

interface ProcessListProps {
  machineId: string;
}

export default function ProcessList({ machineId }: ProcessListProps) {
  const { user } = useAuth();
  const [processes, setProcesses] = useState<{ top_cpu: ProcessInfo[]; top_memory: ProcessInfo[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [killing, setKilling] = useState<number | null>(null);
  const [tab, setTab] = useState<"cpu" | "memory">("cpu");
  const [error, setError] = useState<string | null>(null);
  const { confirm, ConfirmDialogElement } = useConfirm();

  // Auto-pull au montage du composant
  useEffect(() => {
    fetchProcesses();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchProcesses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.dispatchActionSync(machineId, "system.processes", {}, 15000);
      if (result.success && result.data) {
        setProcesses(result.data as any);
      } else {
        setError("Impossible de récupérer les processus");
      }
    } catch {
      setError("Erreur de communication avec l'agent");
    } finally {
      setLoading(false);
    }
  }, [machineId]);

  const killProcess = async (pid: number) => {
    if (!(await confirm({
      title: `Envoyer SIGTERM au processus ${pid} ?`,
      confirmLabel: "Tuer",
      variant: "danger",
    }))) return;
    setKilling(pid);
    try {
      await api.dispatchActionSync(machineId, "process.kill", { pid, signal: "SIGTERM" }, 10000);
      toast.success(`SIGTERM envoyé à PID ${pid}`);
      setTimeout(fetchProcesses, 1000);
    } catch (err: any) {
      toast.error(err?.message || "Échec");
    } finally {
      setKilling(null);
    }
  };

  const currentList = tab === "cpu" ? processes?.top_cpu : processes?.top_memory;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-foreground">Processus</h3>
        <button
          onClick={fetchProcesses}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {processes ? "Rafraîchir" : "Charger"}
        </button>
      </div>

      {error && (
        <div className="text-sm text-red-400 mb-3">{error}</div>
      )}

      {!processes && !loading && (
        <div className="text-center py-8 text-sm text-muted-foreground">
          Cliquez sur "Charger" pour récupérer les processus en cours
        </div>
      )}

      {processes && (
        <>
          {/* Tabs */}
          <div className="flex gap-1 mb-3 border-b border-border">
            {(["cpu", "memory"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                  tab === t
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                Top {t === "cpu" ? "CPU" : "Mémoire"}
              </button>
            ))}
          </div>

          {/* Process table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-2 px-2">PID</th>
                  <th className="text-left py-2 px-2">Nom</th>
                  <th className="text-right py-2 px-2">CPU%</th>
                  <th className="text-right py-2 px-2">MEM%</th>
                  <th className="text-left py-2 px-2">User</th>
                  {user?.role === "ADMIN" && <th className="text-center py-2 px-2">Action</th>}
                </tr>
              </thead>
              <tbody>
                {currentList?.map((p) => (
                  <tr key={p.pid} className="border-b border-border/50 hover:bg-muted/30">
                    <td className="py-1.5 px-2 font-mono text-muted-foreground">{p.pid}</td>
                    <td className="py-1.5 px-2 font-medium text-foreground">{p.name}</td>
                    <td className="py-1.5 px-2 text-right">
                      <span className={p.cpu_percent > 50 ? "text-red-400" : p.cpu_percent > 20 ? "text-amber-400" : "text-foreground"}>
                        {p.cpu_percent.toFixed(1)}%
                      </span>
                    </td>
                    <td className="py-1.5 px-2 text-right">
                      <span className={p.mem_percent > 50 ? "text-red-400" : p.mem_percent > 20 ? "text-amber-400" : "text-foreground"}>
                        {p.mem_percent.toFixed(1)}%
                      </span>
                    </td>
                    <td className="py-1.5 px-2 text-muted-foreground">{p.user}</td>
                    {user?.role === "ADMIN" && (
                      <td className="py-1.5 px-2 text-center">
                        <button
                          onClick={() => killProcess(p.pid)}
                          disabled={killing === p.pid}
                          className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-50"
                          title="Kill (SIGTERM)"
                        >
                          {killing === p.pid ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Skull className="w-3.5 h-3.5" />}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {ConfirmDialogElement}
    </div>
  );
}
