import { useState, useEffect, useCallback } from "react";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import type { Machine } from "../types";

export function useMachines() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMachines = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getMachines();
      setMachines(data);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to fetch machines"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMachines();
    // Refresh toutes les 30s
    const interval = setInterval(fetchMachines, 30_000);
    return () => clearInterval(interval);
  }, [fetchMachines]);

  const updateMachineStatus = useCallback(
    (machineId: string, updates: Partial<Machine>) => {
      setMachines((prev) =>
        prev.map((m) => (m.id === machineId ? { ...m, ...updates } : m))
      );
    },
    []
  );

  return { machines, loading, error, refresh: fetchMachines, updateMachineStatus };
}
