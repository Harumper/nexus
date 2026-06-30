import { useState, useCallback, useEffect } from "react";
import { RefreshCw, Skull, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { api } from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useConfirm } from "./ui";
import { getErrorMessage } from "../services/errors";

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
  const { t } = useTranslation(["processList", "common"]);
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
        setError(t("errorFetch"));
      }
    } catch {
      setError(t("errorComm"));
    } finally {
      setLoading(false);
    }
  }, [machineId]);

  const killProcess = async (pid: number) => {
    if (!(await confirm({
      title: t("confirmKill", { pid }),
      confirmLabel: t("kill"),
      variant: "danger",
    }))) return;
    setKilling(pid);
    try {
      await api.dispatchActionSync(machineId, "process.kill", { pid, signal: "SIGTERM" }, 10000);
      toast.success(t("toastKilled", { pid }));
      setTimeout(fetchProcesses, 1000);
    } catch (err) {
      toast.error(getErrorMessage(err, t("killFallback")));
    } finally {
      setKilling(null);
    }
  };

  const currentList = tab === "cpu" ? processes?.top_cpu : processes?.top_memory;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-foreground">{t("title")}</h3>
        <button
          onClick={fetchProcesses}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {processes ? t("common:actions.refresh") : t("common:actions.load")}
        </button>
      </div>

      {error && (
        <div className="text-sm text-red-400 mb-3">{error}</div>
      )}

      {!processes && !loading && (
        <div className="text-center py-8 text-sm text-muted-foreground">
          {t("loadPrompt")}
        </div>
      )}

      {processes && (
        <>
          {/* Tabs */}
          <div className="flex gap-1 mb-3 border-b border-border">
            {(["cpu", "memory"] as const).map((tabId) => (
              <button
                key={tabId}
                onClick={() => setTab(tabId)}
                className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                  tab === tabId
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tabId === "cpu" ? t("topCpu") : t("topMemory")}
              </button>
            ))}
          </div>

          {/* Process table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-2 px-2">PID</th>
                  <th className="text-left py-2 px-2">{t("headers.name")}</th>
                  <th className="text-right py-2 px-2">CPU%</th>
                  <th className="text-right py-2 px-2">MEM%</th>
                  <th className="text-left py-2 px-2">{t("headers.user")}</th>
                  {user?.role === "ADMIN" && <th className="text-center py-2 px-2">{t("headers.action")}</th>}
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
                          title={t("killTitle")}
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
