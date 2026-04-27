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
  error: string;
  reload: () => Promise<void>;
}

/**
 * Charge en parallèle les signaux critiques d'une machine :
 * alerts FIRING, services failed, updates pending, certs expiring.
 *
 * Refresh manuel via reload(). Pas de polling auto pour ne pas spammer
 * l'agent (system.health_summary + ssl.scan = O(secondes)) — l'utilisateur
 * peut recharger à la demande, et l'AlertEngine côté backend détecte les
 * changements toutes les 5 min de toute façon.
 */
export function useMachineAttention(machineId: string, enabled = true): MachineAttentionData {
  const [alerts, setAlerts] = useState<ActiveAlert[]>([]);
  const [failedServices, setFailedServices] = useState<FailedService[]>([]);
  const [updatesCount, setUpdatesCount] = useState(0);
  const [securityUpdates, setSecurityUpdates] = useState(0);
  const [certs, setCerts] = useState<SslCert[]>([]);
  const [minCertDays, setMinCertDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
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

      setAlerts(alertsRes.filter((a) => a.machineId === machineId) as ActiveAlert[]);
      setFailedServices(healthRes?.data?.services?.failed ?? []);
      setUpdatesCount(healthRes?.data?.updates?.count ?? 0);
      setSecurityUpdates(healthRes?.data?.updates?.security ?? 0);
      setCerts(sslRes?.data?.certs ?? []);
      setMinCertDays(sslRes?.data?.min_days ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, [machineId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    reload();
    // Polling auto toutes les 60s — la fenêtre de détection backend est de
    // 5 min (evaluateHealthAlerts), donc 60s côté UI capte les changements
    // dans les 60s qui suivent un nouvel état détecté serveur. Plus court
    // serait du sur-polling.
    const interval = setInterval(reload, 60_000);
    return () => clearInterval(interval);
  }, [reload, enabled]);

  return { alerts, failedServices, updatesCount, securityUpdates, certs, minCertDays, loading, error, reload };
}
