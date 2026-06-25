import { useState, useEffect, useRef } from "react";
import { ShieldCheck, AlertTriangle, Lightbulb, Loader2, Play, RefreshCw, Flame, Wrench, Check, CheckCircle2, KeyRound, Network, TrendingUp, Eye, ChevronUp, ArrowLeft } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { toast } from "sonner";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import { useConfirm, Dialog, Textarea, Button, Input } from "./ui";

// Bannière par défaut proposée dans l'éditeur (modifiable avant dépôt).
const DEFAULT_BANNER = `*** Accès restreint ***
Tout accès non autorisé à ce système est interdit et peut faire l'objet de
poursuites. Toutes les activités peuvent être journalisées et surveillées.`;
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
  const [fwDockerServices, setFwDockerServices] = useState<ListeningService[]>([]);
  const [fwSelected, setFwSelected] = useState<Set<string>>(new Set());
  const [fwLoading, setFwLoading] = useState(false);
  const [bannerOpen, setBannerOpen] = useState(false);
  const [bannerText, setBannerText] = useState(DEFAULT_BANNER);
  const [f2bOpen, setF2bOpen] = useState(false);
  const [f2bBantime, setF2bBantime] = useState("1h");
  const [f2bFindtime, setF2bFindtime] = useState("10m");
  const [f2bMaxretry, setF2bMaxretry] = useState("5");
  // Posture modifiée par une remédiation mais audit pas encore relancé
  // (indice/findings non recalculés) → bandeau "relancer un audit".
  const [postureDirty, setPostureDirty] = useState(false);
  // Aperçu inline (dry-run) déplié sous une remédiation. `previewLoading` = clé
  // en cours de chargement de l'aperçu.
  const [preview, setPreview] = useState<{
    key: string;
    title: string;
    changes: { path: string; content: string }[];
    note?: string;
    applyLabel: string;
    onApply: () => void;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);

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
  // Applique une mesure SANS re-scanner : la carte passe à "actif" en optimiste,
  // et on marque la posture "à rafraîchir" (un seul audit à relancer à la fin).
  const markApplied = (patch: Partial<SecurityAuditResult>) => {
    setResult((r) => (r ? { ...r, ...patch } : r));
    setPostureDirty(true);
  };

  const applyFail2ban = async () => {
    setApplying("fail2ban");
    try {
      await api.hardenFail2ban(machineId, {
        bantime: f2bBantime,
        findtime: f2bFindtime,
        maxretry: f2bMaxretry,
      });
      toast.success("fail2ban configuré.");
      setF2bOpen(false);
      markApplied({ fail2ban_active: true, fail2ban_installed: true });
    } catch (err) {
      toast.error(getErrorMessage(err, "Échec de la configuration fail2ban"));
    } finally {
      setApplying(null);
    }
  };

  const applyBanner = async () => {
    setApplying("banner");
    try {
      await api.setLoginBanner(machineId, bannerText);
      toast.success("Bannière déposée.");
      setBannerOpen(false);
      markApplied({ login_banner_set: true });
    } catch (err) {
      toast.error(getErrorMessage(err, "Échec du dépôt de la bannière"));
    } finally {
      setApplying(null);
    }
  };

  // Ouvre/replie l'aperçu inline d'une remédiation (dry-run côté agent → contenu
  // exact, sans rien appliquer). Re-cliquer sur la même clé referme.
  const togglePreview = async (
    key: string,
    actionId: string,
    title: string,
    applyLabel: string,
    onApply: () => void
  ) => {
    if (preview?.key === key) {
      setPreview(null);
      return;
    }
    setPreviewLoading(key);
    try {
      const res = await api.remediationPreview(machineId, actionId);
      setPreview({ key, title, changes: res.data.changes, note: res.data.note, applyLabel, onApply });
    } catch (err) {
      toast.error(getErrorMessage(err, "Échec de l'aperçu"));
    } finally {
      setPreviewLoading(null);
    }
  };

  // Application "instantanée" depuis l'aperçu (core-dumps, login.defs, auto-updates) :
  // patch optimiste + posture marquée à rafraîchir (pas de re-scan immédiat).
  const applyFromPreview = async (
    key: string,
    fn: () => Promise<unknown>,
    patch: Partial<SecurityAuditResult>
  ) => {
    setApplying(key);
    try {
      await fn();
      markApplied(patch);
      setPreview(null);
      toast.success("Remédiation appliquée.");
    } catch (err) {
      toast.error(getErrorMessage(err, "Échec de la remédiation"));
    } finally {
      setApplying(null);
    }
  };

  // SSH : application réelle (watchdog-revert) depuis l'aperçu.
  const doSshHarden = async () => {
    setApplying("sshd");
    try {
      const res = await api.sshdHarden(machineId);
      setPending({ kind: "sshd", requestId: res.data.request_id, expiresAt: Date.now() + 120_000 });
      setPreview(null);
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
      const exposed = res.data.services.filter((s) => s.exposed); // loopback non concerné
      // Ports publiés par Docker : gérés par les règles iptables de Docker, ufw
      // ne les filtre pas → on les sépare (affichés mais NON sélectionnables/
      // appliqués) pour éviter d'ajouter des règles ufw inopérantes.
      const docker = exposed.filter((s) => s.docker_managed);
      const actionable = exposed.filter((s) => !s.docker_managed);
      setFwServices(actionable);
      setFwDockerServices(docker);
      // Présélection : services non-Docker exposés ; SSH toujours coché.
      setFwSelected(new Set(actionable.map((s) => s.port)));
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
    <div className="space-y-5 relative">
      {/* Aperçu d'une remédiation : overlay couvrant la zone de contenu de
          l'onglet (Retour / Appliquer), au lieu de décaler la liste. */}
      {preview && (
        <PreviewOverlay
          title={preview.title}
          changes={preview.changes}
          note={preview.note}
          applyLabel={preview.applyLabel}
          applying={applying === preview.key}
          disabled={!canRemediate || (preview.key === "sshd" && pending !== null)}
          onApply={preview.onApply}
          onClose={() => setPreview(null)}
        />
      )}

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
            setPostureDirty(false);
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
                actionLabel={result.fail2ban_installed ? "Configurer" : "Installer + configurer"}
                busy={applying === "fail2ban"}
                disabled={!canRemediate}
                onApply={() => setF2bOpen(true)}
              />

              <RemediationRow
                label="Mises à jour de sécurité automatiques (unattended-upgrades)"
                active={result.auto_updates_active}
                activeLabel="Actif"
                busy={applying === "autoupd"}
                previewLoading={previewLoading === "autoupd"}
                previewing={preview?.key === "autoupd"}
                disabled={!canRemediate}
                onPreview={() =>
                  togglePreview("autoupd", "security.enable_auto_updates", "Mises à jour automatiques", "Activer", () =>
                    applyFromPreview("autoupd", () => api.enableAutoUpdates(machineId), { auto_updates_active: true })
                  )
                }
              />

              <RemediationRow
                label="Durcir SSH (algos modernes + limites)"
                icon={KeyRound}
                active={result.ssh_hardened}
                activeLabel="Durci"
                busy={applying === "sshd"}
                previewLoading={previewLoading === "sshd"}
                previewing={preview?.key === "sshd"}
                disabled={!canRemediate || pending !== null}
                onPreview={() => togglePreview("sshd", "sshd.harden", "Durcissement SSH", "Appliquer (watchdog 120s)", doSshHarden)}
              />

              <RemediationRow
                label="Bannière légale (/etc/issue, /etc/issue.net)"
                active={!!result.login_banner_set}
                activeLabel="En place"
                actionLabel="Configurer"
                busy={applying === "banner"}
                disabled={!canRemediate}
                onApply={() => setBannerOpen(true)}
              />

              <RemediationRow
                label="Désactiver les core dumps"
                active={!!result.core_dumps_disabled}
                activeLabel="Désactivés"
                busy={applying === "nocore"}
                previewLoading={previewLoading === "nocore"}
                previewing={preview?.key === "nocore"}
                disabled={!canRemediate}
                onPreview={() =>
                  togglePreview("nocore", "security.disable_core_dumps", "Désactiver les core dumps", "Désactiver", () =>
                    applyFromPreview("nocore", () => api.disableCoreDumps(machineId), { core_dumps_disabled: true })
                  )
                }
              />

              <RemediationRow
                label="Durcir /etc/login.defs (umask 027 + âges de mot de passe)"
                active={!!result.login_defs_hardened}
                activeLabel="Durci"
                busy={applying === "logindefs"}
                previewLoading={previewLoading === "logindefs"}
                previewing={preview?.key === "logindefs"}
                disabled={!canRemediate}
                onPreview={() =>
                  togglePreview("logindefs", "security.harden_login_defs", "Durcir /etc/login.defs", "Durcir", () =>
                    applyFromPreview("logindefs", () => api.hardenLoginDefs(machineId), { login_defs_hardened: true })
                  )
                }
              />
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Le durcissement SSH valide la config (`sshd -t`) puis recharge via SIGHUP avec
              watchdog 120s (anti-lock-out).
            </p>

            {postureDirty && (
              <div className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-elevated px-3 py-2">
                <span className="text-xs text-muted-foreground flex-1">
                  Mesures appliquées. Relance un audit pour recalculer l'indice et les
                  findings (tu peux d'abord enchaîner d'autres corrections).
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={runAudit}
                  disabled={auditOpen}
                  icon={<RefreshCw />}
                >
                  Relancer l'audit
                </Button>
              </div>
            )}
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

            {fwServices && fwServices.length === 0 && fwDockerServices.length === 0 && (
              <p className="text-sm text-muted-foreground">Aucun service exposé détecté (tout en loopback).</p>
            )}

            {fwServices && fwServices.length === 0 && fwDockerServices.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Aucun service non-Docker exposé. Tous les ports exposés sont publiés par
                Docker (gérés par ses propres règles iptables) — rien à ajouter dans ufw.
              </p>
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

            {fwDockerServices.length > 0 && (
              <div className="mt-4 rounded-lg border border-border bg-elevated p-3">
                <p className="text-xs font-medium text-muted-foreground mb-1.5">
                  {fwDockerServices.length} port{fwDockerServices.length > 1 ? "s" : ""} géré
                  {fwDockerServices.length > 1 ? "s" : ""} par Docker — exclu
                  {fwDockerServices.length > 1 ? "s" : ""} de la politique ufw
                </p>
                <p className="text-[11px] text-muted-foreground mb-2">
                  Docker insère ses propres règles iptables (chaîne DOCKER) ; ufw ne les
                  filtre pas. Pour restreindre ces ports, publie-les sur une IP précise
                  (<code>-p 127.0.0.1:…</code>) ou via un pare-feu en amont.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {fwDockerServices.map((s) => (
                    <span
                      key={`${s.address}:${s.port}`}
                      className="font-mono text-[10px] px-1.5 py-0.5 rounded"
                      style={{ background: "var(--nx-bg-base)", color: "var(--nx-text-weak)" }}
                      title={`${s.process || "docker"} · ${s.address}`}
                    >
                      {s.port}/tcp
                    </span>
                  ))}
                </div>
              </div>
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

      <Dialog
        open={bannerOpen}
        onClose={() => setBannerOpen(false)}
        size="lg"
        title="Bannière légale (/etc/issue, /etc/issue.net)"
        description="Avertissement affiché AVANT connexion (console + SSH). Personnalisable."
        footer={
          <>
            <Button variant="ghost" onClick={() => setBannerOpen(false)} disabled={applying === "banner"}>
              Annuler
            </Button>
            <Button
              variant="primary"
              onClick={applyBanner}
              loading={applying === "banner"}
              disabled={!canRemediate || bannerText.trim() === ""}
            >
              Déposer
            </Button>
          </>
        }
      >
        <Textarea
          value={bannerText}
          onChange={(e) => setBannerText(e.target.value)}
          rows={6}
          className="font-mono text-xs"
          placeholder="Texte de la bannière…"
        />
        <p className="text-[11px] text-muted-foreground mt-2">
          Sans incidence sur l'accès. Max 4096 caractères.
        </p>
      </Dialog>

      <Dialog
        open={f2bOpen}
        onClose={() => setF2bOpen(false)}
        size="md"
        title="Protection anti-bruteforce (fail2ban)"
        description="Installe fail2ban si absent, déploie une jail SSH et active le service."
        footer={
          <>
            <Button variant="ghost" onClick={() => setF2bOpen(false)} disabled={applying === "fail2ban"}>
              Annuler
            </Button>
            <Button
              variant="primary"
              onClick={applyFail2ban}
              loading={applying === "fail2ban"}
              disabled={!canRemediate}
            >
              Appliquer
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium">Durée de bannissement (bantime)</span>
            <Input value={f2bBantime} onChange={(e) => setF2bBantime(e.target.value)} placeholder="1h" className="font-mono" />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Fenêtre de détection (findtime)</span>
            <Input value={f2bFindtime} onChange={(e) => setF2bFindtime(e.target.value)} placeholder="10m" className="font-mono" />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Essais avant ban (maxretry)</span>
            <Input value={f2bMaxretry} onChange={(e) => setF2bMaxretry(e.target.value)} placeholder="5" className="font-mono" />
          </label>
          <p className="text-[11px] text-muted-foreground">
            Durées : secondes ou abrégé (<code>600</code>, <code>10m</code>, <code>1h</code>, <code>1d</code>, <code>1w</code>).
            SSH est protégé par défaut.
          </p>
        </div>
      </Dialog>
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
  onPreview,
  previewing,
  previewLoading,
}: {
  label: string;
  icon?: typeof AlertTriangle;
  active: boolean;
  activeLabel: string;
  actionLabel?: string;
  busy: boolean;
  disabled?: boolean;
  onApply?: () => void;
  // Si fourni : bouton « Voir » qui déplie un aperçu inline (l'application se
  // fait depuis le panneau, jamais à l'aveugle).
  onPreview?: () => void;
  previewing?: boolean;
  previewLoading?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
      <span className="text-sm text-foreground flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4" style={{ color: "var(--nx-text-weak)" }} />}
        {label}
      </span>
      <div className="shrink-0 flex items-center gap-2">
        {active && (
          <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: "var(--nx-success)" }}>
            <Check className="w-4 h-4" /> {activeLabel}
          </span>
        )}
        {onPreview ? (
          <button
            onClick={onPreview}
            disabled={disabled || busy}
            title={disabled ? "Réservé aux machines AGENT / rôle autorisé" : "Voir ce qui sera appliqué"}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
            style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
          >
            {previewLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : previewing ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <Eye className="w-3.5 h-3.5" />
            )}
            {previewing ? "Masquer" : "Voir"}
          </button>
        ) : (
          !active && (
            <button
              onClick={onApply}
              disabled={busy || disabled}
              title={disabled ? "Réservé aux machines AGENT / rôle autorisé" : undefined}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
              style={{ border: "1px solid var(--nx-accent)", color: "var(--nx-accent)" }}
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
              {actionLabel}
            </button>
          )
        )}
      </div>
    </div>
  );
}

// Panneau d'aperçu inline (déplié sous une remédiation) : montre le contenu
// EXACT qui sera écrit (lu depuis l'agent), puis le bouton d'application.
// Overlay couvrant la zone de contenu de l'onglet : montre le contenu EXACT
// (lu depuis l'agent) avant d'appliquer, avec Retour / Appliquer. Le panneau est
// `sticky` pour rester visible quel que soit le défilement.
function PreviewOverlay({
  title,
  changes,
  note,
  applying,
  disabled,
  applyLabel,
  onApply,
  onClose,
}: {
  title: string;
  changes: { path: string; content: string }[];
  note?: string;
  applying: boolean;
  disabled?: boolean;
  applyLabel: string;
  onApply: () => void;
  onClose: () => void;
}) {
  return (
    // Panneau plein : couvre la zone de contenu de l'onglet de façon opaque
    // (pas une carte centrée). `sticky top-0` garde le panneau dans le viewport
    // quel que soit le défilement de la page.
    <div className="absolute inset-0 z-30 bg-background">
      <div className="sticky top-0 flex flex-col h-[80vh] rounded-xl border border-border bg-card overflow-hidden">
        {/* En-tête */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0 bg-elevated">
          <button
            onClick={onClose}
            aria-label="Retour"
            className="inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-muted text-muted-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h3 className="text-sm font-semibold text-foreground">{title} — aperçu</h3>
        </div>
        {/* Corps : le contenu exact qui sera écrit */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Contenu exact qui sera appliqué (lu depuis l'agent, pas une copie) :
          </p>
          {changes.map((c) => (
            <div key={c.path}>
              <div className="text-[10px] font-mono text-muted-foreground mb-1">{c.path}</div>
              <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words rounded bg-black/90 text-emerald-200 p-2">
                {c.content}
              </pre>
            </div>
          ))}
          {note && (
            <div className="rounded-lg border border-border bg-elevated px-3 py-2 text-[11px] text-muted-foreground">
              {note}
            </div>
          )}
        </div>
        {/* Pied : Retour / Appliquer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0 bg-elevated">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={applying} icon={<ArrowLeft />}>
            Retour
          </Button>
          <Button variant="primary" size="sm" onClick={onApply} loading={applying} disabled={disabled} icon={<Wrench />}>
            {applyLabel}
          </Button>
        </div>
      </div>
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
        {items.map((it, i) => {
          // Les IDs de contrôle Lynis (AUTH-9230, BANN-7126, DEB-0280…) ont une
          // page de doc officielle → lien direct depuis la ligne du rapport.
          const docUrl = /^[A-Z]+-\d+$/.test(it.id || "")
            ? `https://cisofy.com/lynis/controls/${it.id}/`
            : null;
          const idCls =
            "shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded mt-0.5 transition-colors";
          return (
            <li key={`${it.id}-${i}`} className="flex items-start gap-3 text-sm">
              {docUrl ? (
                <a
                  href={docUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Documentation Lynis — ${it.id}`}
                  className={`${idCls} hover:underline`}
                  style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-info)" }}
                >
                  {it.id}
                </a>
              ) : (
                <span
                  className={idCls}
                  style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-text-weak)" }}
                >
                  {it.id || "—"}
                </span>
              )}
              <span className="text-foreground">{it.text || it.id}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
