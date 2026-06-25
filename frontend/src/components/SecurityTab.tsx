import { useState, useEffect, useRef } from "react";
import { ShieldCheck, AlertTriangle, Lightbulb, Loader2, Play, RefreshCw, Flame, Wrench, Check, CheckCircle2, KeyRound, Network, TrendingUp } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { toast } from "sonner";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import { useConfirm } from "./ui";
import SecurityAuditDialog from "./SecurityAuditDialog";
import type { SecurityAuditResult, ListeningService, SecurityScanPoint } from "../types";

interface SecurityTabProps {
  machineId: string;
  canRemediate?: boolean;
}

type Pending = { kind: "sshd" | "firewall"; requestId: string; expiresAt: number };

// Reconstitue un SecurityAuditResult à partir du dernier scan persisté
// (tendance). Seuls les TEXTES des warnings/suggestions ne sont pas conservés
// en base → listes vides ; le reste (indice, compteurs, remédiations) est exact.
// Permet d'afficher la dernière posture connue au montage, au lieu d'un faux
// « Aucun audit pour l'instant » alors que la tendance montre des scans.
function scanPointToResult(p: SecurityScanPoint): SecurityAuditResult {
  return {
    hardening_index: p.hardeningIndex,
    lynis_version: "",
    warnings: [],
    suggestions: [],
    warning_count: p.warningCount,
    suggestion_count: p.suggestionCount,
    firewall_active: p.firewallActive,
    firewall_empty_ruleset: false,
    scan_date: p.scannedAt,
    lynis_installed_now: false,
    lynis_path: "",
    fail2ban_installed: p.fail2banActive,
    fail2ban_active: p.fail2banActive,
    auto_updates_active: p.autoUpdatesActive,
    ssh_hardened: p.sshHardened,
  };
}

// Onglet « Durcissement » : audit Lynis (lecture seule) + remédiations 1-clic
// (fail2ban, MAJ auto, SSH avec watchdog) + assistant pare-feu (watchdog 60s).
export default function SecurityTab({ machineId, canRemediate = true }: SecurityTabProps) {
  const [result, setResult] = useState<SecurityAuditResult | null>(null);
  // result reconstitué depuis l'historique (détail warnings/suggestions absent).
  const [resultStale, setResultStale] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false); // modal de progression de l'audit
  const [applying, setApplying] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [remaining, setRemaining] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { confirm, ConfirmDialogElement } = useConfirm();

  // Assistant pare-feu : services détectés + sélection des ports à autoriser.
  const [fwServices, setFwServices] = useState<ListeningService[] | null>(null);
  const [fwSelected, setFwSelected] = useState<Set<string>>(new Set());
  const [fwLoading, setFwLoading] = useState(false);

  // Historique des scans (tendance de l'indice). Chargé au montage.
  const [history, setHistory] = useState<SecurityScanPoint[]>([]);

  const loadHistory = async (): Promise<SecurityScanPoint[]> => {
    try {
      const res = await api.securityScans(machineId, 50);
      setHistory(res.scans);
      return res.scans;
    } catch {
      // historique non bloquant
      return [];
    }
  };

  useEffect(() => {
    // Au montage : charger la tendance ET, faute d'audit live, afficher la
    // dernière posture connue (reconstituée depuis le dernier scan persisté).
    (async () => {
      const scans = await loadHistory();
      // result === null au montage ; on n'écrase jamais un résultat live.
      if (scans.length > 0 && !result) {
        setResult(scanPointToResult(scans[0]));
        setResultStale(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId]);

  // Décompte du watchdog (SSH ou pare-feu) — revert auto si non confirmé.
  useEffect(() => {
    if (!pending) {
      setRemaining(0);
      return;
    }
    const tick = () => {
      const r = Math.max(0, Math.floor((pending.expiresAt - Date.now()) / 1000));
      setRemaining(r);
      if (r <= 0) {
        setPending(null);
        if (countdownRef.current) clearInterval(countdownRef.current);
        runAudit();
      }
    };
    tick();
    countdownRef.current = setInterval(tick, 1000);
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  // Ouvre la modal de progression — elle dispatche l'audit, affiche la sortie
  // streamée en direct, et renvoie le résultat (onResult) pour rafraîchir l'onglet.
  const runAudit = () => setAuditOpen(true);

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

  // Durcissement SSH : watchdog-revert (comme netplan/firewall). On NE relance
  // PAS l'audit immédiatement — on attend la confirmation (ou le revert auto).
  const applySshHarden = async () => {
    if (
      !(await confirm({
        title: "Durcir la configuration SSH ?",
        description:
          "Applique des algorithmes modernes + limites (MaxAuthTries…). La config est validée par `sshd -t` puis rechargée SANS couper ta session. ⚠️ Vérifie que tu peux toujours te reconnecter en SSH AVANT de confirmer : sans confirmation sous 120s, l'état précédent est restauré automatiquement.",
        confirmLabel: "Appliquer",
        variant: "danger",
      }))
    )
      return;
    setApplying("sshd");
    try {
      const res = await api.sshdHarden(machineId);
      setPending({ kind: "sshd", requestId: res.data.request_id, expiresAt: Date.now() + 120_000 });
      toast.success("Durcissement SSH appliqué — confirme avant 120s (teste ta reconnexion).");
    } catch (err) {
      toast.error(getErrorMessage(err, "Échec du durcissement SSH"));
    } finally {
      setApplying(null);
    }
  };

  // Confirme le watchdog en cours (SSH ou pare-feu), selon le kind.
  const handleConfirm = async () => {
    if (!pending) return;
    try {
      if (pending.kind === "sshd") {
        await api.sshdConfirm(machineId, pending.requestId);
      } else {
        await api.firewallConfirm(machineId, pending.requestId);
      }
      setPending(null);
      toast.success("Modification confirmée.");
      runAudit();
    } catch (err) {
      toast.error(getErrorMessage(err, "Échec de la confirmation"));
    }
  };

  // ── Assistant pare-feu ──────────────────────────────────────
  const analyzeFirewall = async () => {
    setFwLoading(true);
    try {
      const res = await api.listeningServices(machineId);
      const svcs = res.data.services.filter((s) => s.exposed); // loopback non concerné
      setFwServices(svcs);
      // Présélection : tous les services exposés détectés (on garde joignable ce
      // qui tourne) ; SSH toujours coché (et non décochable côté UI).
      setFwSelected(new Set(svcs.map((s) => s.port)));
    } catch (err) {
      toast.error(getErrorMessage(err, "Échec de l'analyse des ports"));
    } finally {
      setFwLoading(false);
    }
  };

  const toggleFwPort = (svc: ListeningService) => {
    if (svc.is_ssh) return; // SSH verrouillé (anti-lockout)
    setFwSelected((prev) => {
      const next = new Set(prev);
      if (next.has(svc.port)) next.delete(svc.port);
      else next.add(svc.port);
      return next;
    });
  };

  const applyFirewallPolicy = async () => {
    if (!fwServices) return;
    const ports = Array.from(new Set(Array.from(fwSelected).map((p) => `${p}/tcp`)));
    const hasSsh = fwServices.some((s) => s.is_ssh && fwSelected.has(s.port));
    const sshNote = hasSsh
      ? ""
      : "\n⚠️ ATTENTION : aucun port SSH détecté/sélectionné — risque de te bloquer dehors.";
    if (
      !(await confirm({
        title: "Appliquer cette politique pare-feu ?",
        description:
          `Active ufw (deny entrant par défaut) et autorise : ${ports.join(", ") || "(aucun)"}.` +
          " Watchdog 60s : si tu perds l'accès ou ne confirmes pas, l'état précédent est restauré automatiquement." +
          sshNote,
        confirmLabel: "Appliquer",
        variant: "danger",
      }))
    )
      return;
    setApplying("firewall");
    try {
      const res = await api.firewallApplyPolicy(machineId, ports);
      setPending({ kind: "firewall", requestId: res.data.request_id, expiresAt: Date.now() + 60_000 });
      toast.success("Politique appliquée — confirme avant 60s (vérifie ton accès).");
    } catch (err) {
      toast.error(getErrorMessage(err, "Échec de l'application de la politique"));
    } finally {
      setApplying(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Bandeau watchdog (SSH ou pare-feu) : à confirmer avant revert auto */}
      {pending && remaining > 0 && (
        <div
          className="rounded-xl border p-4 flex items-center justify-between gap-3"
          style={{ background: "var(--nx-warning-subtle)", borderColor: "var(--nx-warning)" }}
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5" style={{ color: "var(--nx-warning)" }} />
            <div>
              <div className="text-sm font-semibold" style={{ color: "var(--nx-warning)" }}>
                {pending.kind === "sshd" ? "Durcissement SSH appliqué" : "Politique pare-feu appliquée"} — confirmer dans {remaining}s
              </div>
              <div className="text-xs mt-0.5" style={{ color: "var(--nx-text-weak)" }}>
                {pending.kind === "sshd"
                  ? "Teste ta reconnexion SSH."
                  : "Vérifie que tu as toujours accès à la machine."}{" "}
                Sans confirmation, l'état précédent sera restauré automatiquement.
              </div>
            </div>
          </div>
          <button
            onClick={handleConfirm}
            className="shrink-0 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
            style={{ background: "var(--nx-success)", color: "var(--nx-bg-base)" }}
          >
            <CheckCircle2 className="w-4 h-4" />
            Confirmer ({remaining}s)
          </button>
        </div>
      )}

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
            disabled={auditOpen}
            className="shrink-0 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
            style={{ background: "var(--nx-primary)", color: "var(--nx-primary-foreground)" }}
          >
            {result ? (
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
      </div>

      {/* Modal de progression (sortie Lynis streamée en direct, comme la MAJ agent) */}
      {auditOpen && (
        <SecurityAuditDialog
          machineId={machineId}
          onClose={() => setAuditOpen(false)}
          onResult={(data) => {
            setResult(data);
            setResultStale(false);
            loadHistory();
          }}
        />
      )}

      {/* Tendance de l'indice de durcissement (historique) */}
      <HardeningTrend history={history} />

      {/* État initial */}
      {!result && !auditOpen && (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Aucun audit pour l'instant. Lance un audit pour évaluer la posture de sécurité de
          cette machine.
        </div>
      )}

      {/* Résultats */}
      {result && (
        <>
          {resultStale && (
            <div className="rounded-lg border border-border bg-elevated px-4 py-2.5 text-xs text-muted-foreground flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 shrink-0" />
              <span>
                Dernière posture connue
                {result.scan_date
                  ? ` (audit du ${new Date(result.scan_date).toLocaleString("fr-FR")})`
                  : ""}
                . Le détail des warnings/suggestions n'est pas conservé — relance
                l'audit pour le voir.
              </span>
            </div>
          )}
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
              <RemediationRow
                label="Durcir SSH (algos modernes + limites)"
                icon={KeyRound}
                active={result.ssh_hardened}
                activeLabel="Durci"
                actionLabel="Durcir"
                busy={applying === "sshd"}
                disabled={!canRemediate || pending !== null}
                onApply={applySshHarden}
              />
              <RemediationRow
                label="Bannière légale (/etc/issue, /etc/issue.net)"
                active={!!result.login_banner_set}
                activeLabel="En place"
                actionLabel="Déposer"
                busy={applying === "banner"}
                disabled={!canRemediate}
                onApply={() =>
                  applyRemediation(
                    "banner",
                    {
                      title: "Déposer la bannière légale ?",
                      description:
                        "Écrit un avertissement d'accès restreint dans /etc/issue et /etc/issue.net (affiché avant connexion). Aucune incidence sur l'accès.",
                    },
                    () => api.setLoginBanner(machineId)
                  )
                }
              />
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Le durcissement SSH valide la config (`sshd -t`) puis recharge via SIGHUP avec
              watchdog 120s (anti-lock-out).
            </p>
          </div>

          {/* Assistant pare-feu */}
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Network className="w-4 h-4" style={{ color: "var(--nx-accent)" }} />
                Assistant pare-feu
              </h3>
              <button
                onClick={analyzeFirewall}
                disabled={fwLoading}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
              >
                {fwLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Analyser les ports ouverts
              </button>
            </div>

            {!fwServices && (
              <p className="text-sm text-muted-foreground">
                Détecte les services en écoute (non-loopback) et propose une politique :
                autoriser les ports cochés + tout bloquer en entrée par défaut.
              </p>
            )}

            {fwServices && fwServices.length === 0 && (
              <p className="text-sm text-muted-foreground">Aucun service exposé détecté (tout en loopback).</p>
            )}

            {fwServices && fwServices.length > 0 && (
              <>
                <ul className="space-y-1.5">
                  {fwServices.map((s) => (
                    <li key={`${s.address}:${s.port}`} className="flex items-center gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={fwSelected.has(s.port)}
                        disabled={s.is_ssh || !canRemediate || pending !== null}
                        onChange={() => toggleFwPort(s)}
                      />
                      <span className="font-mono text-xs" style={{ color: "var(--nx-text)" }}>
                        {s.port}/tcp
                      </span>
                      <span className="text-muted-foreground">{s.process || "?"}</span>
                      <span className="text-[10px]" style={{ color: "var(--nx-text-weak)" }}>{s.address}</span>
                      {s.is_ssh && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase" style={{ background: "var(--nx-info-subtle)", color: "var(--nx-info)" }}>
                          SSH (verrouillé)
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between mt-4">
                  <p className="text-xs text-muted-foreground">
                    Active ufw (deny entrant) + autorise les ports cochés. Watchdog 60s anti-lock-out.
                  </p>
                  <button
                    onClick={applyFirewallPolicy}
                    disabled={!canRemediate || pending !== null || applying === "firewall"}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                    style={{ border: "1px solid var(--nx-accent)", color: "var(--nx-accent)" }}
                  >
                    {applying === "firewall" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Flame className="w-3.5 h-3.5" />}
                    Appliquer la politique
                  </button>
                </div>
              </>
            )}
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
  icon: Icon,
  active,
  activeLabel,
  actionLabel,
  busy,
  disabled,
  onApply,
}: {
  label: string;
  icon?: typeof AlertTriangle;
  active: boolean;
  activeLabel: string;
  actionLabel: string;
  busy: boolean;
  disabled?: boolean;
  onApply: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
      <span className="text-sm text-foreground flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4" style={{ color: "var(--nx-text-weak)" }} />}
        {label}
      </span>
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

// Courbe d'évolution de l'indice de durcissement (du plus ancien au plus récent).
function HardeningTrend({ history }: { history: SecurityScanPoint[] }) {
  const points = history
    .filter((s) => s.hardeningIndex >= 0)
    .slice()
    .reverse()
    .map((s) => ({
      t: new Date(s.scannedAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
      index: s.hardeningIndex,
    }));
  if (points.length < 2) return null;

  const last = points[points.length - 1].index;
  const prev = points[points.length - 2].index;
  const delta = last - prev;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <TrendingUp className="w-4 h-4" style={{ color: "var(--nx-accent)" }} />
          Tendance de l'indice
        </h3>
        {delta !== 0 && (
          <span
            className="text-xs font-medium"
            style={{ color: delta > 0 ? "var(--nx-success)" : "var(--nx-danger)" }}
          >
            {delta > 0 ? "▲ +" : "▼ "}{delta} depuis le dernier scan
          </span>
        )}
      </div>
      <div style={{ width: "100%", height: 160 }}>
        <ResponsiveContainer>
          <AreaChart data={points} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--nx-border)" />
            <XAxis dataKey="t" tick={{ fontSize: 10, fill: "var(--nx-text-weak)" }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--nx-text-weak)" }} />
            <Tooltip
              contentStyle={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "var(--nx-text-weak)" }}
            />
            <Area type="monotone" dataKey="index" stroke="var(--nx-accent)" fill="var(--nx-accent)" fillOpacity={0.15} strokeWidth={2} name="Indice" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
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
