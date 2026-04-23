import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Server, Plus, Search } from "lucide-react";
import { useMachines } from "../hooks/useMachines";
import { api } from "../services/api";
import MachineCard from "../components/MachineCard";

export default function Machines() {
  const navigate = useNavigate();
  const { machines, loading, refresh } = useMachines();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const filtered = machines.filter((m) => {
    const matchesSearch =
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.hostname?.toLowerCase().includes(search.toLowerCase()) ||
      m.ipAddress?.includes(search);
    const matchesStatus =
      statusFilter === "all" || m.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const statusOptions = [
    { value: "all", label: "Tous" },
    { value: "ONLINE", label: "En ligne" },
    { value: "OFFLINE", label: "Hors ligne" },
    { value: "ENROLLMENT_PENDING", label: "En attente" },
    { value: "REVOKED", label: "Révoqué" },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Machines</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {machines.length} machine{machines.length > 1 ? "s" : ""} enregistrée{machines.length > 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={() => navigate("/machines/new")}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Ajouter
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher..."
            className="w-full rounded-lg border border-input bg-background pl-10 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex gap-1 rounded-lg border border-border p-1">
          {statusOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStatusFilter(opt.value)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                statusFilter === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <Server className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p>Aucune machine trouvée</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((machine) => (
            <MachineCard key={machine.id} machine={machine} onDeleted={refresh} />
          ))}
        </div>
      )}

    </div>
  );
}
