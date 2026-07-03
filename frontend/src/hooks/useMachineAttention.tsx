import { useState, useEffect, useCallback } from "react";
import { api } from "../services/api";

interface SslCert { subject?: string; path: string; days_remaining: number }
interface FailedService { unit?: string; description?: string }
export interface ActiveAlert {
  id: string;
  machineId: string;
  status: "FIRING" | "ACKNOWLEDGED";
  rule: { name: string; severity: string; conditionType: string };
  details: { value?: number; threshold?: number } | null;
}

export interface MachineAttentionData {
  alerts: ActiveAlert[];
  failedServices: FailedService[];
  updatesCount: number;
  securityUpdates: number;
  certs: SslCert[];
  minCertDays: number | null;
  loading: boolean;
  // True only during the very FIRST load (before any result). Stays false on the
  // 60s re-polls, so a healthy machine doesn't flicker a skeleton every minute.
  initialLoading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * Loads a machine's critical signals in parallel:
 * FIRING alerts, failed services, pending updates, expiring certs.
 *
 * Manual refresh via reload(). No auto-polling to avoid spamming
 * the agent (system.health_summary + ssl.scan = O(seconds)) — the user
 * can reload on demand, and the AlertEngine on the backend side detects
 * changes every 5 min anyway.
 */
export function useMachineAttention(machineId: string, enabled = true): MachineAttentionData {
  const [alerts, setAlerts] = useState<ActiveAlert[]>([]);
  const [failedServices, setFailedServices] = useState<FailedService[]>([]);
  const [updatesCount, setUpdatesCount] = useState(0);
  const [securityUpdates, setSecurityUpdates] = useState(0);
  const [certs, setCerts] = useState<SslCert[]>([]);
  const [minCertDays, setMinCertDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [firstLoadDone, setFirstLoadDone] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError("");
    try {
      const [alertsRes, healthRes, sslRes] = await Promise.all([
        api.getActiveAlerts().catch((err) => { console.warn("[Attention] alerts:", err); return []; }),
        api
          .dispatchActionSync<{ services: { failed: FailedService[]; count: number }; updates: { count: number; security: number } }>(
            machineId,
            "system.health_summary",
            undefined,
            20_000
          )
          .catch((err) => { console.warn("[Attention] health:", err); return null; }),
        api.sslScan(machineId).catch((err) => { console.warn("[Attention] ssl:", err); return null; }),
      ]);

      setAlerts((alertsRes ?? []).filter((a) => a.machineId === machineId) as ActiveAlert[]);
      setFailedServices(healthRes?.data?.services?.failed ?? []);
      setUpdatesCount(healthRes?.data?.updates?.count ?? 0);
      setSecurityUpdates(healthRes?.data?.updates?.security ?? 0);
      setCerts(sslRes?.data?.certs ?? []);
      setMinCertDays(sslRes?.data?.min_days ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
      setFirstLoadDone(true);
    }
  }, [machineId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    reload();
    // Auto-polling every 60s — the backend detection window is
    // 5 min (evaluateHealthAlerts), so 60s on the UI side catches changes
    // within the 60s following a new state detected by the server. Shorter
    // would be over-polling.
    const interval = setInterval(reload, 60_000);
    return () => clearInterval(interval);
  }, [reload, enabled]);

  return { alerts, failedServices, updatesCount, securityUpdates, certs, minCertDays, loading, initialLoading: loading && !firstLoadDone, error, reload };
}
