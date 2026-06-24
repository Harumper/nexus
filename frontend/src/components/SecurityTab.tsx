import { useState } from "react";
import { ShieldCheck, AlertTriangle, Lightbulb, Loader2, Play, RefreshCw, Flame, Wrench, Check } from "lucide-react";
import { toast } from "sonner";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import { useConfirm } from "./ui";
import type { SecurityAuditResult } from "../types";

interface SecurityTabProps {
  machineId: string;
  canRemediate?: boolean;
}

// Onglet « Durcissement » : lance un audit Lynis (lecture seule) à la demande
// et affiche le score + warnings + suggestions. La remédiation 1-clic viendra
// en Phase 2 (mapping finding -> action Nexus).
export default function SecurityTab({ machineId, canRemediate = true }: SecurityTabProps) {
  const [result, setResult] = useState<SecurityAuditResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const { confirm, ConfirmDialogElement } = useConfirm();

  const runAudit = async () => {
    setLoading(true);
    try {
      const res = await api.securityAudit(machineId);
      setResult(res.data);
      if (res.data.lynis_installed_now) {
        toast.success("Lynis a été installé puis l'audit a été exécuté.");
      } else {
        toast.success("Audit de durcissement terminé.");
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "Échec de l'audit (Lynis indisponible ?)"));
    } finally {
      setLoading(false);
    }
  };

  // Applique une remédiation après confirmation, puis relance l'audit pour
  // rafraîchir l'état affiché.
  const applyRemediation = async (
    key: string,
    opts: { title: string; description: string },
    fn: () => Promise<unknown>
  ) => {
    if (!(await confirm({ title: opts.title, description: opts.description, confirmLabel: "Appliquer" }))) {
      return;
    }
    setApplying(key);
    try {
      await fn();
      toast.success("Remédiation appliquée.");
      await runAudit();
    } catch (err) {
      toast.error(getErrorMessage(err, "Échec de la remédiation"));
    } finally {
      setApplying(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* En-tête + action */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <ShieldCheck className="w-5 h-5" style={{ color: "var(--nx-accent)" }} />
              Durcissement de sécurité
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Audit basé sur <strong>Lynis</strong> (open-source, lecture seule). Aucune
              modification n'est appliquée — les corrections seront proposées en 1 clic.
            </p>
          </div>
          <button
            onClick={runAudit}
            disabled={loading}
            className="shrink-0 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
            style={{ background: "var(--nx-primary)", color: "var(--nx-primary-foreground)" }}
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Audit en cours…
              </>
            ) : result ? (
              <>
                <RefreshCw className="w-4 h-4" /> Relancer l'audit
              </>
            ) : (
              <>
                <Play className="w-4 h-4" /> Lancer un audit
              </>
            )}
          </button>
        </div>
        {loading && (
          <p className="text-xs text-muted-foreground mt-3">
            Lynis analyse la configuration (parefeu, SSH, kernel, comptes, MAJ…). Cela peut
            prendre jusqu'à ~90&nbsp;secondes.
          </p>
        )}
      </div>

      {/* État initial */}
      {!result && !loading && (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Aucun audit pour l'instant. Lance un audit pour évaluer la posture de sécurité de
          cette machine.
        </div>
      )}

      {/* Résultats */}
      {result && (
        <>
          {/* Score + parefeu */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <HardeningScore index={result.hardening_index} />
            <StatCard
              label="Avertissements"
              value={result.warning_count}
              tone={result.warning_count > 0 ? "danger" : "ok"}
              icon={AlertTriangle}
            />
            <StatCard
              label="Suggestions"
              value={result.suggestion_count}
              tone={result.suggestion_count > 0 ? "warning" : "ok"}
              icon={Lightbulb}
            />
          </div>

          {/* Parefeu (résumé rapide) */}
          <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-2 text-sm">
            <Flame className="w-4 h-4" style={{ color: result.firewall_active ? "var(--nx-success)" : "var(--nx-danger)" }} />
            {result.firewall_active
              ? "Pare-feu actif"
              : "⚠ Pare-feu inactif — à activer (onglet Pare-feu)"}
            {result.firewall_active && result.firewall_empty_ruleset && (
              <span style={{ color: "var(--nx-warning)" }}> — mais aucune règle définie</span>
            )}
          </div>

          {/* Remédiations recommandées (1 clic) */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
              <Wrench className="w-4 h-4" style={{ color: "var(--nx-accent)" }} />
              Remédiations recommandées
            </h3>
            <div className="space-y-2">
              <RemediationRow
                label="Protection anti-bruteforce (fail2ban)"
                active={result.fail2ban_active}
                activeLabel={result.fail2ban_installed && !result.fail2ban_active ? "Installé, inactif" : "Actif"}
                actionLabel={result.fail2ban_installed ? "Activer" : "Installer + activer"}
                busy={applying === "fail2ban"}
                disabled={!canRemediate}
                onApply={() =>
                  applyRemediation(
                    "fail2ban",
                    {
                      title: "Installer/activer fail2ban ?",
                      description:
                        "Installe fail2ban (si absent), déploie une jail SSH par défaut (ban après 5 essais) et active le service.",
                    },
                    () => api.hardenFail2ban(machineId)
                  )
                }
              />
              <RemediationRow
                label="Mises à jour de sécurité automatiques (unattended-upgrades)"
                active={result.auto_updates_active}
                activeLabel="Actif"
                actionLabel="Activer"
                busy={applying === "autoupd"}
                disabled={!canRemediate}
                onApply={() =>
                  applyRemediation(
                    "autoupd",
                    {
                      title: "Activer les mises à jour automatiques ?",
                      description:
                        "Installe unattended-upgrades (si absent) et active l'application automatique des mises à jour de sécurité.",
                    },
                    () => api.enableAutoUpdates(machineId)
                  )
                }
              />
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Le durcissement SSH et l'assistant pare-feu (avec garde anti-lock-out) arrivent
              dans un prochain incrément.
            </p>
          </div>

          {result.warnings.length > 0 && (
            <FindingList
              title="Avertissements"
              items={result.warnings}
              icon={AlertTriangle}
              color="var(--nx-danger)"
            />
          )}
          {result.suggestions.length > 0 && (
            <FindingList
              title="Suggestions de durcissement"
              items={result.suggestions}
              icon={Lightbulb}
              color="var(--nx-warning)"
            />
          )}

          <p className="text-xs text-muted-foreground">
            Lynis {result.lynis_version || "?"} · le score de durcissement est un indicateur
            des mesures prises, pas un pourcentage de « sécurité ».
          </p>
        </>
      )}
      {ConfirmDialogElement}
    </div>
  );
}

function RemediationRow({
  label,
  active,
  activeLabel,
  actionLabel,
  busy,
  disabled,
  onApply,
}: {
  label: string;
  active: boolean;
  activeLabel: string;
  actionLabel: string;
  busy: boolean;
  disabled?: boolean;
  onApply: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
      <span className="text-sm text-foreground">{label}</span>
      {active ? (
        <span className="shrink-0 inline-flex items-center gap-1 text-xs font-medium" style={{ color: "var(--nx-success)" }}>
          <Check className="w-4 h-4" /> {activeLabel}
        </span>
      ) : (
        <button
          onClick={onApply}
          disabled={busy || disabled}
          title={disabled ? "Réservé aux machines AGENT / rôle autorisé" : undefined}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
          style={{ border: "1px solid var(--nx-accent)", color: "var(--nx-accent)" }}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function HardeningScore({ index }: { index: number }) {
  const has = index >= 0;
  const color =
    !has ? "var(--nx-text-weak)" : index >= 70 ? "var(--nx-success)" : index >= 50 ? "var(--nx-warning)" : "var(--nx-danger)";
  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col items-center justify-center">
      <div className="text-4xl font-bold tabular-nums" style={{ color }}>
        {has ? index : "—"}
        {has && <span className="text-lg text-muted-foreground">/100</span>}
      </div>
      <div className="text-xs uppercase mt-1" style={{ color: "var(--nx-text-weak)" }}>
        Indice de durcissement
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number;
  tone: "ok" | "warning" | "danger";
  icon: typeof AlertTriangle;
}) {
  const color =
    tone === "danger" ? "var(--nx-danger)" : tone === "warning" ? "var(--nx-warning)" : "var(--nx-success)";
  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col items-center justify-center">
      <Icon className="w-5 h-5 mb-1" style={{ color }} />
      <div className="text-3xl font-bold tabular-nums" style={{ color }}>
        {value}
      </div>
      <div className="text-xs uppercase mt-1" style={{ color: "var(--nx-text-weak)" }}>
        {label}
      </div>
    </div>
  );
}

function FindingList({
  title,
  items,
  icon: Icon,
  color,
}: {
  title: string;
  items: { id: string; text: string }[];
  icon: typeof AlertTriangle;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
        <Icon className="w-4 h-4" style={{ color }} />
        {title} <span className="text-muted-foreground">({items.length})</span>
      </h3>
      <ul className="space-y-2">
        {items.map((it, i) => (
          <li key={`${it.id}-${i}`} className="flex items-start gap-3 text-sm">
            <span
              className="shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded mt-0.5"
              style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-text-weak)" }}
            >
              {it.id || "—"}
            </span>
            <span className="text-foreground">{it.text || it.id}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
