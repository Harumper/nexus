import { useState, useEffect, type FormEvent } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Bell, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, CardHeader, CardTitle, Input, PageHeader, PageLoader } from "../components/ui";
import AlertChannelEditor, { type NotificationChannel } from "../components/AlertChannelEditor";
import { useMachines } from "../hooks/useMachines";

const SEVERITY_OPTS = [
  { value: "INFO", label: "Info", className: "bg-info-subtle text-info border-info" },
  { value: "WARNING", label: "Warning", className: "bg-warning-subtle text-warning border-warning" },
  { value: "CRITICAL", label: "Critical", className: "bg-danger-subtle text-danger border-danger" },
] as const;

const CONDITION_GROUPS = [
  {
    label: "Métriques",
    options: [
      { value: "CPU_ABOVE", label: "CPU supérieur à" },
      { value: "MEMORY_ABOVE", label: "Mémoire supérieure à" },
      { value: "DISK_ABOVE", label: "Disque supérieur à" },
      { value: "LOAD_ABOVE", label: "Load average supérieur à" },
    ],
  },
  {
    label: "Connexion",
    options: [{ value: "MACHINE_OFFLINE", label: "Machine hors ligne depuis" }],
  },
  {
    label: "Santé système",
    options: [
      { value: "SERVICE_FAILED", label: "Service systemd en échec" },
      { value: "TIMER_FAILED", label: "Timer systemd en échec" },
      { value: "UPDATES_AVAILABLE", label: "Mises à jour disponibles (>X)" },
      { value: "CERT_EXPIRING", label: "Certificat SSL expirant dans" },
    ],
  },
];

function thresholdUnit(t: string): string {
  switch (t) {
    case "MACHINE_OFFLINE": return "secondes";
    case "CERT_EXPIRING": return "jours";
    case "UPDATES_AVAILABLE": return "updates";
    case "SERVICE_FAILED":
    case "TIMER_FAILED":
    case "CRON_FAILED":
      return "";
    default: return "%";
  }
}

function needsThreshold(t: string): boolean {
  return !["SERVICE_FAILED", "TIMER_FAILED", "CRON_FAILED"].includes(t);
}

function needsTargetPattern(t: string): boolean {
  return ["SERVICE_FAILED", "TIMER_FAILED", "CRON_FAILED"].includes(t);
}

export default function AlertCreate() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);
  const { machines } = useMachines();

  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [conditionType, setConditionType] = useState("CPU_ABOVE");
  const [threshold, setThreshold] = useState<number>(90);
  const [targetPattern, setTargetPattern] = useState("");
  const [severity, setSeverity] = useState<"INFO" | "WARNING" | "CRITICAL">("WARNING");
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [cooldownSeconds, setCooldownSeconds] = useState(300);
  const [machineIds, setMachineIds] = useState<string[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);

  // Charger la règle existante en mode edit
  useEffect(() => {
    if (!isEdit || !id) return;
    fetch(`/api/alerts/rules/${id}`, {
      headers: { Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}` },
    })
      .then((r) => r.json())
      .then((rule) => {
        setName(rule.name || "");
        setDescription(rule.description || "");
        setConditionType(rule.conditionType);
        setThreshold(rule.threshold ?? 90);
        setTargetPattern(rule.targetPattern || "");
        setSeverity(rule.severity);
        setDurationSeconds(rule.durationSeconds || 0);
        setCooldownSeconds(rule.cooldownSeconds || 300);
        setMachineIds(rule.machineIds || []);
        setChannels(Array.isArray(rule.channels) ? rule.channels : []);
      })
      .catch(() => toast.error("Erreur de chargement de la règle"))
      .finally(() => setLoading(false));
  }, [isEdit, id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Le nom est requis");
      return;
    }
    setSubmitting(true);

    const payload: any = {
      name: name.trim(),
      description: description.trim() || undefined,
      conditionType,
      severity,
      durationSeconds,
      cooldownSeconds,
      machineIds,
    };
    if (needsThreshold(conditionType)) payload.threshold = threshold;
    if (needsTargetPattern(conditionType) && targetPattern.trim()) {
      payload.targetPattern = targetPattern.trim();
    }
    if (channels.length > 0) payload.channels = channels;

    const url = isEdit ? `/api/alerts/rules/${id}` : "/api/alerts/rules";
    const method = isEdit ? "PUT" : "POST";

    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Échec");
      }
      toast.success(isEdit ? "Règle modifiée" : "Règle créée");
      navigate("/alerts");
    } catch (err: any) {
      toast.error(err?.message || "Erreur");
    } finally {
      setSubmitting(false);
    }
  };

  const toggleMachine = (mid: string) => {
    setMachineIds((prev) =>
      prev.includes(mid) ? prev.filter((x) => x !== mid) : [...prev, mid]
    );
  };

  if (loading) return <PageLoader />;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        to="/alerts"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Retour aux alertes
      </Link>

      <PageHeader
        icon={Bell}
        title={isEdit ? "Modifier la règle" : "Nouvelle règle d'alerte"}
        description={
          isEdit
            ? "Édition d'une règle existante"
            : "Créez une règle qui se déclenche quand une condition est remplie"
        }
      />

      <form onSubmit={submit} className="space-y-6">
        {/* Identité */}
        <Card>
          <CardHeader>
            <CardTitle>Identité</CardTitle>
          </CardHeader>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Nom <span className="text-destructive">*</span>
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="CPU critique"
                required
                autoFocus={!isEdit}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Description
              </label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optionnel"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Sévérité
              </label>
              <div className="flex gap-2">
                {SEVERITY_OPTS.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => setSeverity(s.value)}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                      severity === s.value
                        ? s.className
                        : "border-border text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>

        {/* Condition */}
        <Card>
          <CardHeader>
            <CardTitle>Condition de déclenchement</CardTitle>
          </CardHeader>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Type de condition
              </label>
              <select
                value={conditionType}
                onChange={(e) => setConditionType(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {CONDITION_GROUPS.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {needsThreshold(conditionType) && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Seuil ({thresholdUnit(conditionType)})
                </label>
                <Input
                  type="number"
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  min={0}
                />
              </div>
            )}

            {needsTargetPattern(conditionType) && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Filtre (optionnel)
                </label>
                <Input
                  value={targetPattern}
                  onChange={(e) => setTargetPattern(e.target.value)}
                  placeholder={
                    conditionType === "SERVICE_FAILED"
                      ? "nginx, postgresql (vide = tout service en échec)"
                      : "pattern"
                  }
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Substring matching. Vide = n'importe quel service en échec déclenche.
                </p>
              </div>
            )}
          </div>
        </Card>

        {/* Cibles */}
        <Card>
          <CardHeader>
            <CardTitle>Machines ciblées</CardTitle>
          </CardHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {machineIds.length === 0
                ? "Toutes les machines sont surveillées (par défaut)"
                : `${machineIds.length} machine${machineIds.length > 1 ? "s" : ""} sélectionnée${machineIds.length > 1 ? "s" : ""}`}
            </p>
            {machines.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-60 overflow-y-auto">
                {machines.map((m) => (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded text-xs cursor-pointer hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      checked={machineIds.includes(m.id)}
                      onChange={() => toggleMachine(m.id)}
                      className="accent-primary"
                    />
                    <span className="font-mono truncate">{m.name}</span>
                  </label>
                ))}
              </div>
            )}
            {machineIds.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setMachineIds([])}
                icon={<Trash2 />}
              >
                Tout désélectionner (= toutes les machines)
              </Button>
            )}
          </div>
        </Card>

        {/* Comportement */}
        <Card>
          <CardHeader>
            <CardTitle>Comportement</CardTitle>
          </CardHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Durée minimale avant déclenchement (s)
              </label>
              <Input
                type="number"
                min={0}
                value={durationSeconds}
                onChange={(e) => setDurationSeconds(Number(e.target.value))}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                0 = déclenchement immédiat. Sinon la condition doit être vraie X secondes.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Cooldown anti-spam (s)
              </label>
              <Input
                type="number"
                min={0}
                value={cooldownSeconds}
                onChange={(e) => setCooldownSeconds(Number(e.target.value))}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Délai minimal entre deux notifications pour la même alerte.
              </p>
            </div>
          </div>
        </Card>

        {/* Channels */}
        <Card>
          <CardHeader>
            <CardTitle>Canaux de notification</CardTitle>
          </CardHeader>
          <p className="text-xs text-muted-foreground mb-3">
            Discord, Slack, Microsoft Teams, Email ou Webhook personnalisé. Aucun canal =
            l'alerte est visible uniquement dans l'UI/dashboard sans notification externe.
          </p>
          <AlertChannelEditor value={channels} onChange={setChannels} />
        </Card>

        {/* Footer actions */}
        <div className="flex justify-end gap-2 sticky bottom-4">
          <Button
            type="button"
            variant="outline"
            size="md"
            onClick={() => navigate("/alerts")}
            disabled={submitting}
          >
            Annuler
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={submitting}
            icon={<Save />}
          >
            {isEdit ? "Enregistrer" : "Créer la règle"}
          </Button>
        </div>
      </form>
    </div>
  );
}
