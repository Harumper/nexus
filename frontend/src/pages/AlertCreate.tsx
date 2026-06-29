import { useState, useEffect, type FormEvent } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Bell, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, CardHeader, CardTitle, Input, PageHeader, PageLoader } from "../components/ui";
import AlertChannelEditor, { type NotificationChannel } from "../components/AlertChannelEditor";
import { useMachines } from "../hooks/useMachines";
import { getErrorMessage } from "../services/errors";

const SEVERITY_OPTS = [
  { value: "INFO", className: "bg-info-subtle text-info border-info" },
  { value: "WARNING", className: "bg-warning-subtle text-warning border-warning" },
  { value: "CRITICAL", className: "bg-danger-subtle text-danger border-danger" },
] as const;

// Groupes du sélecteur de condition : clé de groupe i18n + valeurs.
// Le libellé de chaque option vient de t(`conditionsForm.${v}`) avec fallback
// sur t(`conditions.${v}`) (override seulement là où le form diffère, ex. UPDATES_AVAILABLE).
const CONDITION_GROUPS = [
  { key: "metrics", options: ["CPU_ABOVE", "MEMORY_ABOVE", "DISK_ABOVE", "LOAD_ABOVE"] },
  { key: "connection", options: ["MACHINE_OFFLINE"] },
  { key: "systemHealth", options: ["SERVICE_FAILED", "TIMER_FAILED", "UPDATES_AVAILABLE", "CERT_EXPIRING"] },
  { key: "security", options: ["HARDENING_INDEX_BELOW"] },
];

function thresholdUnitKey(t: string): string {
  switch (t) {
    case "MACHINE_OFFLINE": return "seconds";
    case "CERT_EXPIRING": return "days";
    case "UPDATES_AVAILABLE": return "updates";
    case "HARDENING_INDEX_BELOW": return "score";
    case "SERVICE_FAILED":
    case "TIMER_FAILED":
    case "CRON_FAILED":
      return "none";
    default: return "percent";
  }
}

function needsThreshold(t: string): boolean {
  return !["SERVICE_FAILED", "TIMER_FAILED", "CRON_FAILED"].includes(t);
}

function needsTargetPattern(t: string): boolean {
  return ["SERVICE_FAILED", "TIMER_FAILED", "CRON_FAILED"].includes(t);
}

export default function AlertCreate() {
  const { t } = useTranslation(["alerts", "common"]);
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
      .catch(() => toast.error(t("toast.loadError")))
      .finally(() => setLoading(false));
  }, [isEdit, id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error(t("toast.nameRequired"));
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
      toast.success(isEdit ? t("toast.saved") : t("toast.created"));
      navigate("/alerts");
    } catch (err) {
      toast.error(getErrorMessage(err, t("common:errors.generic")));
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
        <ArrowLeft className="w-3.5 h-3.5" /> {t("form.back")}
      </Link>

      <PageHeader
        icon={Bell}
        title={isEdit ? t("form.titleEdit") : t("form.titleNew")}
        description={isEdit ? t("form.subtitleEdit") : t("form.subtitleNew")}
      />

      <form onSubmit={submit} className="space-y-6">
        {/* Identité */}
        <Card>
          <CardHeader>
            <CardTitle>{t("form.sectionIdentity")}</CardTitle>
          </CardHeader>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                {t("form.nameLabel")} <span className="text-destructive">*</span>
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("form.namePlaceholder")}
                required
                autoFocus={!isEdit}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                {t("form.descriptionLabel")}
              </label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("form.descriptionPlaceholder")}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                {t("form.severityLabel")}
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
                    {t(`severity.${s.value}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>

        {/* Condition */}
        <Card>
          <CardHeader>
            <CardTitle>{t("form.sectionCondition")}</CardTitle>
          </CardHeader>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                {t("form.conditionTypeLabel")}
              </label>
              <select
                value={conditionType}
                onChange={(e) => setConditionType(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {CONDITION_GROUPS.map((g) => (
                  <optgroup key={g.key} label={t(`conditionGroups.${g.key}`)}>
                    {g.options.map((v) => (
                      <option key={v} value={v}>
                        {t(`conditionsForm.${v}`, { defaultValue: t(`conditions.${v}`) })}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {needsThreshold(conditionType) && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  {t("form.thresholdLabel", { unit: t(`units.${thresholdUnitKey(conditionType)}`) })}
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
                  {t("form.filterLabel")}
                </label>
                <Input
                  value={targetPattern}
                  onChange={(e) => setTargetPattern(e.target.value)}
                  placeholder={
                    conditionType === "SERVICE_FAILED"
                      ? t("form.filterPlaceholderService")
                      : t("form.filterPlaceholderDefault")
                  }
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t("form.filterHint")}
                </p>
              </div>
            )}
          </div>
        </Card>

        {/* Cibles */}
        <Card>
          <CardHeader>
            <CardTitle>{t("form.sectionTargets")}</CardTitle>
          </CardHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {machineIds.length === 0
                ? t("form.allMachinesDefault")
                : t("form.selectedCount", { count: machineIds.length })}
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
                {t("form.deselectAll")}
              </Button>
            )}
          </div>
        </Card>

        {/* Comportement */}
        <Card>
          <CardHeader>
            <CardTitle>{t("form.sectionBehavior")}</CardTitle>
          </CardHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                {t("form.durationLabel")}
              </label>
              <Input
                type="number"
                min={0}
                value={durationSeconds}
                onChange={(e) => setDurationSeconds(Number(e.target.value))}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                {t("form.durationHint")}
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                {t("form.cooldownLabel")}
              </label>
              <Input
                type="number"
                min={0}
                value={cooldownSeconds}
                onChange={(e) => setCooldownSeconds(Number(e.target.value))}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                {t("form.cooldownHint")}
              </p>
            </div>
          </div>
        </Card>

        {/* Channels */}
        <Card>
          <CardHeader>
            <CardTitle>{t("form.sectionChannels")}</CardTitle>
          </CardHeader>
          <p className="text-xs text-muted-foreground mb-3">
            {t("form.channelsHint")}
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
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={submitting}
            icon={<Save />}
          >
            {isEdit ? t("form.submitEdit") : t("form.submitNew")}
          </Button>
        </div>
      </form>
    </div>
  );
}
