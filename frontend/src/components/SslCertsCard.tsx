import { useState, useEffect } from "react";
import { ShieldCheck, AlertTriangle, RefreshCw, Loader2, Lock } from "lucide-react";
import { api } from "../services/api";

interface Props {
  machineId: string;
}

export default function SslCertsCard({ machineId }: Props) {
  const [certs, setCerts] = useState<any[]>([]);
  const [minDays, setMinDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const scan = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.sslScan(machineId);
      setCerts(res?.data?.certs || []);
      setMinDays(res?.data?.min_days ?? null);
    } catch (err: any) {
      setError(err?.message || "scan failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Pas d'auto-load : on attend le clic pour eviter spam
  }, [machineId]);

  const byColor = (days: number) => {
    if (days < 0) return "var(--nx-danger)";
    if (days < 7) return "var(--nx-danger)";
    if (days < 30) return "var(--nx-warning)";
    return "var(--nx-success)";
  };

  return (
    <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color: "var(--nx-text-weak)" }}>
          <Lock className="w-3 h-3" /> Certificats SSL
        </h3>
        <button
          onClick={scan}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px]"
          style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Scanner
        </button>
      </div>

      {error && (
        <div className="rounded px-2 py-1.5 text-[10px] mb-2" style={{ background: "var(--nx-danger-subtle)", color: "var(--nx-danger)" }}>
          {error}
        </div>
      )}

      {certs.length === 0 && !loading && !error && (
        <p className="text-xs" style={{ color: "var(--nx-text-weak)" }}>
          Cliquez sur <strong>Scanner</strong> pour détecter les certs (/etc/letsencrypt/live, /etc/ssl/*, /etc/nginx/ssl…).
        </p>
      )}

      {certs.length > 0 && (
        <div className="space-y-2">
          {minDays !== null && (
            <div className="text-xs flex items-center gap-2">
              {minDays < 30 ? (
                <AlertTriangle className="w-3.5 h-3.5" style={{ color: byColor(minDays) }} />
              ) : (
                <ShieldCheck className="w-3.5 h-3.5" style={{ color: byColor(minDays) }} />
              )}
              <span>
                <strong style={{ color: byColor(minDays) }}>{minDays} jours</strong> avant le premier renouvellement
              </span>
            </div>
          )}

          <div className="space-y-1">
            {certs.map((c, i) => (
              <div key={i} className="flex items-center justify-between py-1 text-[11px]" style={{ borderBottom: "1px solid var(--nx-border)" }}>
                <div className="min-w-0 flex-1">
                  <div className="font-mono truncate">{c.subject || "(sans CN)"}</div>
                  <div className="text-[10px] truncate" style={{ color: "var(--nx-text-weak)" }}>
                    {c.path}
                  </div>
                </div>
                <span className="shrink-0 font-mono font-semibold" style={{ color: byColor(c.days_remaining) }}>
                  {c.days_remaining}j
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
