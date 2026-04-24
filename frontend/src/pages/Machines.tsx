import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Server, Plus, Search, Zap, CheckSquare, Square } from "lucide-react";
import { useMachines } from "../hooks/useMachines";
import MachineCard from "../components/MachineCard";
import BulkActionDialog from "../components/BulkActionDialog";

export default function Machines() {
  const navigate = useNavigate();
  const { machines, loading, refresh } = useMachines();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulk, setShowBulk] = useState(false);

  const filtered = useMemo(() => {
    return machines.filter((m) => {
      const matchesSearch =
        m.name.toLowerCase().includes(search.toLowerCase()) ||
        m.hostname?.toLowerCase().includes(search.toLowerCase()) ||
        m.ipAddress?.includes(search);
      const matchesStatus =
        statusFilter === "all" || m.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [machines, search, statusFilter]);

  const statusOptions = [
    { value: "all", label: "Tous" },
    { value: "ONLINE", label: "En ligne" },
    { value: "OFFLINE", label: "Hors ligne" },
    { value: "ENROLLMENT_PENDING", label: "En attente" },
    { value: "REVOKED", label: "Révoqué" },
  ];

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allVisibleSelected = filtered.length > 0 && filtered.every((m) => selected.has(m.id));
  const toggleAll = () => {
    if (allVisibleSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((m) => m.id)));
    }
  };

  const selectedMachines = machines.filter((m) => selected.has(m.id));

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
            {selected.size > 0 && ` · ${selected.size} sélectionnée${selected.size > 1 ? "s" : ""}`}
          </p>
        </div>
        <div className="flex gap-2">
          {selected.size > 0 && (
            <button
              onClick={() => setShowBulk(true)}
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
              style={{ background: "var(--nx-warning)", color: "var(--nx-bg-base)" }}
            >
              <Zap className="w-4 h-4" />
              Action groupée ({selected.size})
            </button>
          )}
          <button
            onClick={() => navigate("/machines/new")}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Ajouter
          </button>
        </div>
      </div>

      {/* Filters + bulk select */}
      <div className="flex gap-3 mb-6 items-center">
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
        {filtered.length > 0 && (
          <button
            onClick={toggleAll}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            title={allVisibleSelected ? "Désélectionner tout" : "Tout sélectionner"}
          >
            {allVisibleSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
            {allVisibleSelected ? "Aucun" : "Tout"}
          </button>
        )}
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
            <div key={machine.id} className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); toggle(machine.id); }}
                className="absolute top-3 left-3 z-10 p-1 rounded transition-colors hover:bg-background"
                title={selected.has(machine.id) ? "Désélectionner" : "Sélectionner"}
                style={{
                  background: selected.has(machine.id) ? "var(--nx-primary)" : "var(--nx-bg-surface)",
                  border: "1px solid var(--nx-border)",
                }}
              >
                {selected.has(machine.id) ? (
                  <CheckSquare className="w-3.5 h-3.5" style={{ color: "var(--nx-bg-base)" }} />
                ) : (
                  <Square className="w-3.5 h-3.5" style={{ color: "var(--nx-text-weak)" }} />
                )}
              </button>
              <MachineCard machine={machine} onDeleted={refresh} />
            </div>
          ))}
        </div>
      )}

      {showBulk && selectedMachines.length > 0 && (
        <BulkActionDialog
          machines={selectedMachines}
          onClose={() => setShowBulk(false)}
          onCompleted={() => { refresh(); setSelected(new Set()); }}
        />
      )}
    </div>
  );
}
