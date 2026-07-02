import { useState, useEffect, useRef } from "react";
import { formatDateTime } from "../lib/format";
import { ShieldCheck, AlertTriangle, Lightbulb, Loader2, Play, RefreshCw, Flame, Wrench, Check, CheckCircle2, KeyRound, Network, TrendingUp, Eye, ChevronUp, ChevronDown, ArrowLeft, X } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import { useConfirm, Dialog, Textarea, Button, Input } from "./ui";
import SecurityAuditDialog from "./SecurityAuditDialog";
import type { SecurityAuditResult, ListeningService, SecurityScanPoint } from "../types";

interface SecurityTabProps {
  machineId: string;
}

type Pending = { kind: "sshd" | "firewall"; requestId: string; expiresAt: number };

// Reconstructs a SecurityAuditResult from the last persisted scan (trend).
// Only the TEXTS of warnings/suggestions are not kept in the database →
// empty lists; everything else (index, counters, remediations) is exact.
// Lets us display the last known posture on mount, instead of a bogus
// "No audit yet" while the trend shows scans.
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

// "Hardening" tab: Lynis audit (read-only) + 1-click remediations
// (fail2ban, auto-updates, SSH with watchdog) + firewall wizard (60s watchdog).
export default function SecurityTab({ machineId }: SecurityTabProps) {
  const { t } = useTranslation(["security", "common"]);
  const [result, setResult] = useState<SecurityAuditResult | null>(null);
  // result reconstructed from history (warnings/suggestions detail absent).
  const [resultStale, setResultStale] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false); // audit progress modal
  const [applying, setApplying] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [remaining, setRemaining] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { confirm, ConfirmDialogElement } = useConfirm();

  // Firewall wizard: detected services + selection of ports to allow.
  const [fwServices, setFwServices] = useState<ListeningService[] | null>(null);
  const [fwDockerServices, setFwDockerServices] = useState<ListeningService[]>([]);
  const [fwSelected, setFwSelected] = useState<Set<string>>(new Set());
  const [fwLoading, setFwLoading] = useState(false);
  const [bannerOpen, setBannerOpen] = useState(false);
  const [bannerText, setBannerText] = useState(() => t("bannerDialog.defaultBanner"));
  const [f2bOpen, setF2bOpen] = useState(false);
  const [f2bBantime, setF2bBantime] = useState("1h");
  const [f2bFindtime, setF2bFindtime] = useState("10m");
  const [f2bMaxretry, setF2bMaxretry] = useState("5");
  // Posture modified by a remediation but audit not re-run yet
  // (index/findings not recomputed) → "re-run an audit" banner.
  const [postureDirty, setPostureDirty] = useState(false);
  // Overview (trend graph + stats) collapsed by default: the page
  // opens directly on the remediations list (better focus).
  const [overviewOpen, setOverviewOpen] = useState(false);
  // Inline preview (dry-run) expanded under a remediation. `previewLoading` = key
  // currently loading its preview.
  const [preview, setPreview] = useState<{
    key: string;
    title: string;
    changes: { path: string; content: string }[];
    note?: string;
    applyLabel: string;
    onApply: () => void;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);

  // Scan history (index trend). Loaded on mount.
  const [history, setHistory] = useState<SecurityScanPoint[]>([]);

  const loadHistory = async (): Promise<SecurityScanPoint[]> => {
    try {
      const res = await api.securityScans(machineId, 50);
      const scans = res.scans ?? []; // never null → no .filter/.length crash
      setHistory(scans);
      return scans;
    } catch {
      // history is non-blocking
      return [];
    }
  };

  useEffect(() => {
    // On mount: load the trend AND, absent a live audit, display the
    // last known posture (reconstructed from the last persisted scan).
    (async () => {
      const scans = await loadHistory();
      // result === null on mount; we never overwrite a live result.
      if (scans.length > 0 && !result) {
        setResult(scanPointToResult(scans[0]));
        setResultStale(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId]);

  // Watchdog countdown (SSH or firewall) — auto-revert if not confirmed.
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

  // Opens the progress modal — it dispatches the audit, shows the live-streamed
  // output, and returns the result (onResult) to refresh the tab.
  const runAudit = () => setAuditOpen(true);

  // Applies a remediation after confirmation, then re-runs the audit to
  // refresh the displayed state.
  // Applies a measure WITHOUT re-scanning: the card optimistically flips to
  // "active", and we mark the posture "to refresh" (a single audit to re-run at the end).
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
      toast.success(t("toasts.f2bConfigured"));
      setF2bOpen(false);
      markApplied({ fail2ban_active: true, fail2ban_installed: true });
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.f2bError")));
    } finally {
      setApplying(null);
    }
  };

  const applyBanner = async () => {
    setApplying("banner");
    try {
      await api.setLoginBanner(machineId, bannerText);
      toast.success(t("toasts.bannerDeposited"));
      setBannerOpen(false);
      markApplied({ login_banner_set: true });
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.bannerError")));
    } finally {
      setApplying(null);
    }
  };

  // Opens/collapses the inline preview of a remediation (agent-side dry-run →
  // exact content, without applying anything). Re-clicking the same key closes it.
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
      toast.error(getErrorMessage(err, t("toasts.previewError")));
    } finally {
      setPreviewLoading(null);
    }
  };

  // "Instant" apply from the preview (core-dumps, login.defs, auto-updates):
  // optimistic patch + posture marked to refresh (no immediate re-scan).
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
      toast.success(t("toasts.remediationApplied"));
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.remediationError")));
    } finally {
      setApplying(null);
    }
  };

  // SSH: real apply (watchdog-revert) from the preview.
  const doSshHarden = async () => {
    setApplying("sshd");
    try {
      const res = await api.sshdHarden(machineId);
      setPending({ kind: "sshd", requestId: res.data.request_id, expiresAt: Date.now() + 120_000 });
      setPreview(null);
      toast.success(t("toasts.sshApplied"));
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.sshError")));
    } finally {
      setApplying(null);
    }
  };

  // Confirms the current watchdog (SSH or firewall), depending on the kind.
  const handleConfirm = async () => {
    if (!pending) return;
    try {
      if (pending.kind === "sshd") {
        await api.sshdConfirm(machineId, pending.requestId);
      } else {
        await api.firewallConfirm(machineId, pending.requestId);
      }
      setPending(null);
      toast.success(t("toasts.confirmed"));
      runAudit();
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.confirmError")));
    }
  };

  // ── Firewall wizard ─────────────────────────────────────────
  const analyzeFirewall = async () => {
    setFwLoading(true);
    try {
      const res = await api.listeningServices(machineId);
      const exposed = res.data.services.filter((s) => s.exposed); // loopback not concerned
      // Ports published by Docker: handled by Docker's iptables rules, ufw
      // doesn't filter them → we separate them (shown but NOT selectable/
      // applied) to avoid adding inoperative ufw rules.
      const docker = exposed.filter((s) => s.docker_managed);
      const actionable = exposed.filter((s) => !s.docker_managed);
      setFwServices(actionable);
      setFwDockerServices(docker);
      // Preselection: exposed non-Docker services; SSH always checked.
      setFwSelected(new Set(actionable.map((s) => s.port)));
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.analyzeError")));
    } finally {
      setFwLoading(false);
    }
  };

  const toggleFwPort = (svc: ListeningService) => {
    if (svc.is_ssh) return; // SSH locked (anti-lockout)
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
    const sshNote = hasSsh ? "" : t("confirmFirewall.sshWarning");
    if (
      !(await confirm({
        title: t("confirmFirewall.title"),
        description:
          t("confirmFirewall.desc", { ports: ports.join(", ") || t("confirmFirewall.noPorts") }) +
          sshNote,
        confirmLabel: t("common:actions.apply"),
        variant: "danger",
      }))
    )
      return;
    setApplying("firewall");
    try {
      const res = await api.firewallApplyPolicy(machineId, ports);
      setPending({ kind: "firewall", requestId: res.data.request_id, expiresAt: Date.now() + 60_000 });
      toast.success(t("toasts.policyApplied"));
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.policyError")));
    } finally {
      setApplying(null);
    }
  };

  return (
    <div className="space-y-5 relative">
      {/* Remediation preview: overlay covering the tab's content area
          (Back / Apply), instead of shifting the list. */}
      {preview && (
        <PreviewOverlay
          title={preview.title}
          changes={preview.changes}
          note={preview.note}
          applyLabel={preview.applyLabel}
          applying={applying === preview.key}
          disabled={preview.key === "sshd" && pending !== null}
          onApply={preview.onApply}
          onClose={() => setPreview(null)}
        />
      )}

      {/* Watchdog banner (SSH or firewall): confirm before auto-revert */}
      {pending && remaining > 0 && (
        <div
          className="rounded-xl border p-4 flex items-center justify-between gap-3"
          style={{ background: "var(--nx-warning-subtle)", borderColor: "var(--nx-warning)" }}
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5" style={{ color: "var(--nx-warning)" }} />
            <div>
              <div className="text-sm font-semibold" style={{ color: "var(--nx-warning)" }}>
                {t("watchdog.confirm", {
                  subject: pending.kind === "sshd" ? t("watchdog.subjectSsh") : t("watchdog.subjectFirewall"),
                  count: remaining,
                })}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "var(--nx-text-weak)" }}>
                {pending.kind === "sshd" ? t("watchdog.hintSsh") : t("watchdog.hintFirewall")}{" "}
                {t("watchdog.revert")}
              </div>
            </div>
          </div>
          <button
            onClick={handleConfirm}
            className="shrink-0 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
            style={{ background: "var(--nx-success)", color: "var(--nx-bg-base)" }}
          >
            <CheckCircle2 className="w-4 h-4" />
            {t("watchdog.confirmButton", { count: remaining })}
          </button>
        </div>
      )}

      {/* Header + action */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <ShieldCheck className="w-5 h-5" style={{ color: "var(--nx-accent)" }} />
              {t("header.title")}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              <Trans i18nKey="header.subtitle" t={t} components={[<strong key="0" />]} />
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
                <RefreshCw className="w-4 h-4" /> {t("header.runAudit")}
              </>
            ) : (
              <>
                <Play className="w-4 h-4" /> {t("header.startAudit")}
              </>
            )}
          </button>
        </div>
      </div>

      {/* Progress modal (Lynis output streamed live, like the agent update) */}
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

      {/* Initial state */}
      {!result && !auditOpen && (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {t("header.empty")}
        </div>
      )}

      {/* Results */}
      {result && (
        <>
          {resultStale && (
            <div className="rounded-lg border border-border bg-elevated px-4 py-2.5 text-xs text-muted-foreground flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 shrink-0" />
              <span>
                {t("stale.text", {
                  auditDate: result.scan_date
                    ? t("stale.auditDate", { date: formatDateTime(result.scan_date) })
                    : "",
                })}
              </span>
            </div>
          )}
          {/* Overview (collapsed by default): index + stats + trend.
              We keep focus on the remediations list below. */}
          <div className="rounded-xl border border-border bg-card">
            <button
              onClick={() => setOverviewOpen((o) => !o)}
              className="w-full flex items-center justify-between gap-2 px-5 py-3 text-left"
              aria-expanded={overviewOpen}
            >
              <span className="text-sm font-semibold text-foreground flex items-center gap-2">
                <TrendingUp className="w-4 h-4" style={{ color: "var(--nx-accent)" }} />
                {t("overview.title")}
                <span className="text-xs font-normal text-muted-foreground">
                  {t("overview.inline", { index: result.hardening_index, warnings: result.warning_count, suggestions: result.suggestion_count })}
                </span>
              </span>
              {overviewOpen ? (
                <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
              )}
            </button>
            {overviewOpen && (
              <div className="px-5 pb-5 space-y-4 border-t border-border pt-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <HardeningScore index={result.hardening_index} />
                  <StatCard
                    label={t("overview.warnings")}
                    value={result.warning_count}
                    tone={result.warning_count > 0 ? "danger" : "ok"}
                    icon={AlertTriangle}
                  />
                  <StatCard
                    label={t("overview.suggestions")}
                    value={result.suggestion_count}
                    tone={result.suggestion_count > 0 ? "warning" : "ok"}
                    icon={Lightbulb}
                  />
                </div>
                <HardeningTrend history={history} />
              </div>
            )}
          </div>

          {/* Firewall (quick summary) */}
          <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-2 text-sm">
            <Flame className="w-4 h-4" style={{ color: result.firewall_active ? "var(--nx-success)" : "var(--nx-danger)" }} />
            {result.firewall_active
              ? t("firewallSummary.active")
              : t("firewallSummary.inactive")}
            {result.firewall_active && result.firewall_empty_ruleset && (
              <span style={{ color: "var(--nx-warning)" }}>{t("firewallSummary.noRules")}</span>
            )}
          </div>

          {/* Recommended remediations (1 click) */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
              <Wrench className="w-4 h-4" style={{ color: "var(--nx-accent)" }} />
              {t("remediations.title")}
            </h3>
            <div className="space-y-2">
              <RemediationRow
                label={t("remediations.fail2banName")}
                active={result.fail2ban_active}
                activeLabel={result.fail2ban_installed && !result.fail2ban_active ? t("remediations.fail2banInactive") : t("remediations.active")}
                actionLabel={result.fail2ban_installed ? t("remediations.configure") : t("remediations.installConfigure")}
                busy={applying === "fail2ban"}                onApply={() => setF2bOpen(true)}
              />

              <RemediationRow
                label={t("remediations.autoUpdatesLabel")}
                active={result.auto_updates_active}
                activeLabel={t("remediations.active")}
                busy={applying === "autoupd"}
                previewLoading={previewLoading === "autoupd"}
                previewing={preview?.key === "autoupd"}                onPreview={() =>
                  togglePreview("autoupd", "security.enable_auto_updates", t("remediations.autoUpdatesPreviewTitle"), t("remediations.enable"), () =>
                    applyFromPreview("autoupd", () => api.enableAutoUpdates(machineId), { auto_updates_active: true })
                  )
                }
              />

              <RemediationRow
                label={t("remediations.sshLabel")}
                icon={KeyRound}
                active={result.ssh_hardened}
                activeLabel={t("remediations.sshActive")}
                busy={applying === "sshd"}
                previewLoading={previewLoading === "sshd"}
                previewing={preview?.key === "sshd"}
                disabled={pending !== null}
                onPreview={() => togglePreview("sshd", "sshd.harden", t("remediations.sshPreviewTitle"), t("remediations.sshPreviewApply"), doSshHarden)}
              />

              <RemediationRow
                label={t("remediations.bannerLabel")}
                active={!!result.login_banner_set}
                activeLabel={t("remediations.bannerActive")}
                actionLabel={t("remediations.configure")}
                busy={applying === "banner"}                onApply={() => setBannerOpen(true)}
              />

              <RemediationRow
                label={t("remediations.coreDumpsLabel")}
                active={!!result.core_dumps_disabled}
                activeLabel={t("remediations.coreDumpsActive")}
                busy={applying === "nocore"}
                previewLoading={previewLoading === "nocore"}
                previewing={preview?.key === "nocore"}                onPreview={() =>
                  togglePreview("nocore", "security.disable_core_dumps", t("remediations.coreDumpsLabel"), t("remediations.coreDumpsApply"), () =>
                    applyFromPreview("nocore", () => api.disableCoreDumps(machineId), { core_dumps_disabled: true })
                  )
                }
              />

              <RemediationRow
                label={t("remediations.loginDefsLabel")}
                active={!!result.login_defs_hardened}
                activeLabel={t("remediations.loginDefsActive")}
                busy={applying === "logindefs"}
                previewLoading={previewLoading === "logindefs"}
                previewing={preview?.key === "logindefs"}                onPreview={() =>
                  togglePreview("logindefs", "security.harden_login_defs", t("remediations.loginDefsPreviewTitle"), t("remediations.loginDefsApply"), () =>
                    applyFromPreview("logindefs", () => api.hardenLoginDefs(machineId), { login_defs_hardened: true })
                  )
                }
              />

              <RemediationRow
                label={t("remediations.sysctlNetworkLabel")}
                active={!!result.sysctl_network_hardened}
                activeLabel={t("remediations.sysctlNetworkActive")}
                busy={applying === "netsysctl"}
                previewLoading={previewLoading === "netsysctl"}
                previewing={preview?.key === "netsysctl"}
                onPreview={() =>
                  togglePreview("netsysctl", "security.harden_sysctl_network", t("remediations.sysctlNetworkPreviewTitle"), t("remediations.sysctlNetworkApply"), () =>
                    applyFromPreview("netsysctl", () => api.hardenSysctlNetwork(machineId), { sysctl_network_hardened: true })
                  )
                }
              />
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              {t("remediations.sshNote")}
            </p>

            {postureDirty && (
              <div className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-elevated px-3 py-2">
                <span className="text-xs text-muted-foreground flex-1">
                  {t("remediations.postureDirty")}
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={runAudit}
                  disabled={auditOpen}
                  icon={<RefreshCw />}
                >
                  {t("header.runAudit")}
                </Button>
              </div>
            )}
          </div>

          {/* Firewall wizard */}
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Network className="w-4 h-4" style={{ color: "var(--nx-accent)" }} />
                {t("firewallWizard.title")}
              </h3>
              <button
                onClick={analyzeFirewall}
                disabled={fwLoading}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
              >
                {fwLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                {t("firewallWizard.analyze")}
              </button>
            </div>

            {!fwServices && (
              <p className="text-sm text-muted-foreground">
                {t("firewallWizard.intro")}
              </p>
            )}

            {fwServices && fwServices.length === 0 && fwDockerServices.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("firewallWizard.emptyAll")}</p>
            )}

            {fwServices && fwServices.length === 0 && fwDockerServices.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {t("firewallWizard.emptyNonDocker")}
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
                        disabled={s.is_ssh || pending !== null}
                        onChange={() => toggleFwPort(s)}
                      />
                      <span className="font-mono text-xs" style={{ color: "var(--nx-text)" }}>
                        {s.port}/tcp
                      </span>
                      <span className="text-muted-foreground">{s.process || "?"}</span>
                      <span className="text-[10px]" style={{ color: "var(--nx-text-weak)" }}>{s.address}</span>
                      {s.is_ssh && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase" style={{ background: "var(--nx-info-subtle)", color: "var(--nx-info)" }}>
                          {t("firewallWizard.sshLocked")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between mt-4">
                  <p className="text-xs text-muted-foreground">
                    {t("firewallWizard.applyHint")}
                  </p>
                  <button
                    onClick={applyFirewallPolicy}
                    disabled={pending !== null || applying === "firewall"}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                    style={{ border: "1px solid var(--nx-accent)", color: "var(--nx-accent)" }}
                  >
                    {applying === "firewall" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Flame className="w-3.5 h-3.5" />}
                    {t("firewallWizard.applyPolicy")}
                  </button>
                </div>
              </>
            )}

            {fwDockerServices.length > 0 && (
              <div className="mt-4 rounded-lg border border-border bg-elevated p-3">
                <p className="text-xs font-medium text-muted-foreground mb-1.5">
                  {t("firewallWizard.dockerPorts", { count: fwDockerServices.length })}
                </p>
                <p className="text-[11px] text-muted-foreground mb-2">
                  <Trans i18nKey="firewallWizard.dockerHint" t={t} components={[<code key="0" />]} />
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
              title={t("findings.warnings")}
              items={result.warnings}
              icon={AlertTriangle}
              color="var(--nx-danger)"
            />
          )}
          {result.suggestions.length > 0 && (
            <FindingList
              title={t("findings.suggestions")}
              items={result.suggestions}
              icon={Lightbulb}
              color="var(--nx-warning)"
            />
          )}

          <p className="text-xs text-muted-foreground">
            {t("lynisFooter", { version: result.lynis_version || "?" })}
          </p>
        </>
      )}
      {ConfirmDialogElement}

      <Dialog
        open={bannerOpen}
        onClose={() => setBannerOpen(false)}
        size="lg"
        title={t("remediations.bannerLabel")}
        description={t("bannerDialog.desc")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBannerOpen(false)} disabled={applying === "banner"}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={applyBanner}
              loading={applying === "banner"}
              disabled={bannerText.trim() === ""}
            >
              {t("bannerDialog.submit")}
            </Button>
          </>
        }
      >
        <Textarea
          value={bannerText}
          onChange={(e) => setBannerText(e.target.value)}
          rows={6}
          className="font-mono text-xs"
          placeholder={t("bannerDialog.placeholder")}
        />
        <p className="text-[11px] text-muted-foreground mt-2">
          {t("bannerDialog.hint")}
        </p>
      </Dialog>

      <Dialog
        open={f2bOpen}
        onClose={() => setF2bOpen(false)}
        size="md"
        title={t("remediations.fail2banName")}
        description={t("f2bDialog.desc")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setF2bOpen(false)} disabled={applying === "fail2ban"}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={applyFail2ban}
              loading={applying === "fail2ban"}
            >
              {t("common:actions.apply")}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium">{t("f2bDialog.bantime")}</span>
            <Input value={f2bBantime} onChange={(e) => setF2bBantime(e.target.value)} placeholder="1h" className="font-mono" />
          </label>
          <label className="block">
            <span className="text-xs font-medium">{t("f2bDialog.findtime")}</span>
            <Input value={f2bFindtime} onChange={(e) => setF2bFindtime(e.target.value)} placeholder="10m" className="font-mono" />
          </label>
          <label className="block">
            <span className="text-xs font-medium">{t("f2bDialog.maxretry")}</span>
            <Input value={f2bMaxretry} onChange={(e) => setF2bMaxretry(e.target.value)} placeholder="5" className="font-mono" />
          </label>
          <p className="text-[11px] text-muted-foreground">
            <Trans i18nKey="f2bDialog.durationsHint" t={t} components={[<code key="0" />, <code key="1" />, <code key="2" />, <code key="3" />, <code key="4" />]} />
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
  // If provided: a "View" button that expands an inline preview (applying
  // happens from the panel, never blindly).
  onPreview?: () => void;
  previewing?: boolean;
  previewLoading?: boolean;
}) {
  const { t } = useTranslation("security");
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
            title={disabled ? t("remediations.disabledTitle") : t("remediations.previewTooltip")}
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
            {previewing ? t("remediations.hide") : t("remediations.show")}
          </button>
        ) : (
          !active && (
            <button
              onClick={onApply}
              disabled={busy || disabled}
              title={disabled ? t("remediations.disabledTitle") : undefined}
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

// Remediation preview: a side sheet (drawer) sliding in from the right, Stripe/
// Linear style. Shows the EXACT content that will be written (read from the agent)
// before applying. Fixed to the viewport → always fully visible, the list stays
// visible behind (context preserved). Light scrim, close on click/Esc.
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
  const { t } = useTranslation(["security", "common"]);
  // Entry animation (slide from the right) + close on Esc key.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !applying) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applying, onClose]);

  return (
    <>
      {/* Light scrim (not an opaque modal backdrop): click = close */}
      <div
        className={`fixed inset-0 z-40 bg-black/20 transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
        onClick={() => !applying && onClose()}
        aria-hidden="true"
      />
      {/* Drawer on the right */}
      <div
        role="dialog"
        aria-modal="true"
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-xl flex flex-col bg-card border-l border-border shadow-2xl transform transition-transform duration-200 ${shown ? "translate-x-0" : "translate-x-full"}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border shrink-0 bg-elevated">
          <h3 className="text-sm font-semibold text-foreground truncate">{t("preview.titleSuffix", { title })}</h3>
          <button
            onClick={onClose}
            aria-label={t("common:a11y.close")}
            className="inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-muted text-muted-foreground transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {/* Body: the exact content that will be written */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            {t("preview.exactContent")}
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
        {/* Footer: Back / Apply */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0 bg-elevated">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={applying} icon={<ArrowLeft />}>
            {t("preview.back")}
          </Button>
          <Button variant="primary" size="sm" onClick={onApply} loading={applying} disabled={disabled} icon={<Wrench />}>
            {applyLabel}
          </Button>
        </div>
      </div>
    </>
  );
}

// Evolution curve of the hardening index (from oldest to most recent).
function HardeningTrend({ history }: { history: SecurityScanPoint[] }) {
  const { t } = useTranslation("security");
  const points = history
    .filter((s) => s.hardeningIndex >= 0)
    .slice()
    .reverse()
    .map((s) => ({
      t: formatDateTime(s.scannedAt, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
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
          {t("trend.title")}
        </h3>
        {delta !== 0 && (
          <span
            className="text-xs font-medium"
            style={{ color: delta > 0 ? "var(--nx-success)" : "var(--nx-danger)" }}
          >
            {delta > 0 ? t("trend.deltaUp", { delta }) : t("trend.deltaDown", { delta })}
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
            <Area type="monotone" dataKey="index" stroke="var(--nx-accent)" fill="var(--nx-accent)" fillOpacity={0.15} strokeWidth={2} name={t("trend.seriesName")} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function HardeningScore({ index }: { index: number }) {
  const { t } = useTranslation("security");
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
        {t("score.label")}
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
  const { t } = useTranslation("security");
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
        <Icon className="w-4 h-4" style={{ color }} />
        {title} <span className="text-muted-foreground">({items.length})</span>
      </h3>
      <ul className="space-y-2">
        {items.map((it, i) => {
          // Lynis control IDs (AUTH-9230, BANN-7126, DEB-0280…) have an
          // official doc page → direct link from the report line.
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
                  title={t("findings.docTitle", { id: it.id })}
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
