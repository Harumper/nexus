import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import { formatDateTime } from "../lib/format";
import { useNavigate, useParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { getErrorMessage } from "../services/errors";
import {
  ArrowLeft,
  Check,
  Copy,
  Server,
  Terminal,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { api } from "../services/api";
import type {
  BootstrapArtifacts,
  CreateMachineResponse,
  InstallStep,
  Machine,
} from "../types";

type Step = 1 | 2 | 3;

// Appends --reenroll to an install command (idempotent). Used by the
// "reinstall on already-enrolled host" checkbox: the flag makes the agent wipe
// residual identity clean BEFORE enrolling (otherwise it keeps the old identity
// → "Session handshake failed: error"). We append at the end of the command (the
// order of flags is free); the purge stays a DELIBERATE gesture (checkbox
// unchecked by default).
function withReenroll(command: string): string {
  if (/(^|\s)--reenroll(\s|$)/.test(command)) return command;
  // trailing trim: otherwise a final \n would break the "\" line continuation.
  return `${command.replace(/\s+$/, "")} \\\n  --reenroll`;
}

export default function MachineEnroll() {
  const { t } = useTranslation(["enroll", "common"]);
  const { id: paramId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const isRegenerateMode = Boolean(paramId);

  const [step, setStep] = useState<Step>(isRegenerateMode ? 2 : 1);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [machine, setMachine] = useState<Machine | null>(null);
  const [machineId, setMachineId] = useState<string | null>(paramId || null);
  const [bootstrap, setBootstrap] = useState<BootstrapArtifacts | null>(null);
  const [enrollmentToken, setEnrollmentToken] = useState<string>("");

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // "reinstall on already-enrolled host" checkbox → injects --reenroll into the
  // copied command. Only relevant at creation (in regeneration, the
  // reEnrollMachine command already contains --reenroll).
  const [reenroll, setReenroll] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ===== Regenerate mode: load the machine + new tokens on mount =====
  useEffect(() => {
    if (!isRegenerateMode || !paramId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const m = await api.getMachine(paramId);
        if (cancelled) return;
        setMachine(m);
        setName(m.name);
        // Re-provisioning an existing machine → ALWAYS a --reenroll command
        // (api.reEnrollMachine → POST /re-enroll, with no status guard). It regenerates
        // token + backend ECDSA pair, disconnects the agent, and PURGES the residual
        // identity on the host side (keys, shared.secret, old server key, snapshots).
        // We NO LONGER distinguish ENROLLMENT_PENDING: a PENDING machine may have a
        // residual identity from a previous cycle (earlier re-enroll), and the old
        // `regenerateBootstrap` branch (install WITHOUT --reenroll) kept that stale
        // key → deadlock "Session handshake failed: error". The purge is harmless
        // if there is nothing to purge (fresh host), so --reenroll is always safe here.
        const res = await api.reEnrollMachine(paramId);
        if (cancelled) return;
        setBootstrap(res.bootstrap);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, t("errors.load")));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isRegenerateMode, paramId]);

  // ===== Polling step 3 =====
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (pollStopRef.current) {
      clearTimeout(pollStopRef.current);
      pollStopRef.current = null;
    }
  }, []);

  const refreshMachine = useCallback(async () => {
    if (!machineId) return;
    try {
      const m = await api.getMachine(machineId);
      setMachine(m);
      // We stop polling only when the agent is ONLINE AND its version has come
      // up (it arrives at the 1st heartbeat, right after going ONLINE).
      // Otherwise the screen stayed stuck on "version —".
      if (m.status === "ONLINE" && m.agentVersion) {
        stopPolling();
      }
    } catch {
      // ignore transient errors
    }
  }, [machineId, stopPolling]);

  // (Re)starts polling: immediate fetch + 2s interval, with a 2 min cap.
  // Reused by the "Refresh" button to restart after a stop.
  const startPolling = useCallback(() => {
    stopPolling();
    refreshMachine();
    pollTimerRef.current = setInterval(refreshMachine, 2000);
    pollStopRef.current = setTimeout(() => stopPolling(), 120_000);
  }, [refreshMachine, stopPolling]);

  useEffect(() => {
    if (step !== 3 || !machineId) return;
    startPolling();
    return stopPolling;
  }, [step, machineId, startPolling, stopPolling]);

  // ===== Actions =====
  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res: CreateMachineResponse = await api.createMachine(name);
      setMachineId(res.id);
      setEnrollmentToken(res.enrollmentToken);
      setBootstrap(res.bootstrap);
      setMachine({
        id: res.id,
        name: res.name,
        hostname: null,
        os: null,
        osVersion: null,
        arch: null,
        ipAddress: null,
        agentVersion: null,
        status: "ENROLLMENT_PENDING",
        sshUser: null,
        isCritical: false,
        lastHeartbeat: null,
        lastMetrics: null,
        enrolledAt: null,
        createdAt: new Date().toISOString(),
      });
      setStep(2);
    } catch (err) {
      setError(getErrorMessage(err, t("errors.create")));
    } finally {
      setLoading(false);
    }
  };

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // ===== Derived UI state =====
  const isOnline = machine?.status === "ONLINE";
  const lastHeartbeatRecent =
    machine?.lastHeartbeat &&
    Date.now() - new Date(machine.lastHeartbeat).getTime() < 90_000;

  // Displayed/copied command: --reenroll injected only in the "run" step
  // (not in the downloads) when the checkbox is ticked.
  const installCommand =
    bootstrap && reenroll ? withReenroll(bootstrap.installCommand) : bootstrap?.installCommand ?? "";
  const displaySteps =
    bootstrap?.installSteps.map((s) =>
      reenroll && s.id === "run" ? { ...s, command: withReenroll(s.command) } : s
    ) ?? [];

  // ===== Render =====
  return (
    <div className="container max-w-3xl mx-auto py-8 px-4">
      <button
        onClick={() => navigate("/machines")}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        {t("back")}
      </button>

      <div className="flex items-center gap-3 mb-8">
        <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10">
          <Server className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {isRegenerateMode ? t("titleRegenerate", { name }) : t("titleNew")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isRegenerateMode ? t("subtitleRegenerate") : t("subtitleNew")}
          </p>
        </div>
      </div>

      <StepIndicator current={step} skipFirst={isRegenerateMode} />

      {error && (
        <div className="mt-6 rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {step === 1 && (
        <form
          onSubmit={handleCreate}
          className="mt-8 space-y-5 bg-card border border-border rounded-xl p-6"
        >
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t("nameLabel")}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder={t("namePlaceholder")}
              required
              autoFocus
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => navigate("/machines")}
              className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              {t("common:actions.cancel")}
            </button>
            <button
              type="submit"
              disabled={loading || !name}
              className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {loading ? t("creating") : t("create")}
            </button>
          </div>
        </form>
      )}

      {step === 2 && (
        <div className="mt-8 space-y-5">
          {bootstrap ? (
            <>
              <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
                <div className="text-sm">
                  <div className="font-medium text-foreground">
                    {t("commandsValidUntil", { date: formatDateTime(bootstrap.expiresAt) })}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {t("executeHint")}
                  </div>
                </div>
                <button
                  onClick={() => copy(installCommand, "all")}
                  className="shrink-0 flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  {copiedKey === "all" ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  {t("copyAll")}
                </button>
              </div>

              {!isRegenerateMode && (
                <label className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reenroll}
                    onChange={(e) => setReenroll(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-input"
                  />
                  <span className="text-sm">
                    <span className="font-medium text-foreground">{t("reenrollLabel")}</span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      {t("reenrollHint")}
                    </span>
                  </span>
                </label>
              )}

              <div className="space-y-4">
                {displaySteps.map((s, i) => (
                  <CommandCard
                    key={s.id}
                    index={i + 1}
                    total={displaySteps.length}
                    step={s}
                    copied={copiedKey === s.id}
                    onCopy={() => copy(s.command, s.id)}
                  />
                ))}
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => navigate("/machines")}
                  className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
                >
                  {t("later")}
                </button>
                <button
                  onClick={() => setStep(3)}
                  className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  {t("executed")}
                </button>
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-sm text-amber-200 space-y-3">
              <div className="font-medium">
                {t("autogenDisabledTitle")}
              </div>
              <p>
                <Trans i18nKey="autogenDisabledBody" t={t} components={{ code: <code className="font-mono text-xs" /> }} />
              </p>
              {machineId && (
                <div className="space-y-2 mt-3">
                  <InfoRow label={t("machineIdLabel")} value={machineId} copied={copiedKey === "mid"} onCopy={() => copy(machineId, "mid")} />
                  {enrollmentToken && (
                    <InfoRow
                      label={t("enrollmentTokenLabel")}
                      value={enrollmentToken}
                      copied={copiedKey === "etok"}
                      onCopy={() => copy(enrollmentToken, "etok")}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="mt-8 space-y-5">
          <div className="rounded-xl border border-border bg-card p-6">
            <h2 className="text-lg font-semibold text-foreground mb-1">
              {t("verifyTitle")}
            </h2>
            <p className="text-sm text-muted-foreground mb-5">
              {t("verifySubtitle")}
            </p>

            <div className="space-y-3">
              <StatusRow
                label={t("status.handshake")}
                status={isOnline ? "ok" : "pending"}
                hint={isOnline ? t("status.validated") : t("status.pending")}
              />
              <StatusRow
                label={t("status.websocket")}
                status={lastHeartbeatRecent ? "ok" : "pending"}
                hint={
                  lastHeartbeatRecent
                    ? t("status.connected")
                    : t("status.noHeartbeat")
                }
              />
              <StatusRow
                label={t("status.agentVersion")}
                status={machine?.agentVersion ? "ok" : "pending"}
                hint={machine?.agentVersion || "—"}
              />
            </div>

            <div className="mt-6 flex items-center justify-between gap-3">
              {isOnline ? (
                <div className="flex-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-4 py-3 text-sm text-emerald-400 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  {t("agentConnected")}{" "}
                  {machine?.hostname && <span>{machine.hostname} — </span>}
                  {machine?.ipAddress}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t("monitoring")}
                </div>
              )}
              {/* Button always available: restarts polling (useful if polling
                  has stopped or if the agent connected afterwards). */}
              <button
                onClick={startPolling}
                className="shrink-0 flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                title={t("refreshTitle")}
              >
                <RefreshCw className="w-4 h-4" />
                {t("common:actions.refresh")}
              </button>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setStep(2)}
              className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              {t("reviewCommands")}
            </button>
            <button
              onClick={() =>
                navigate(isOnline && machineId ? `/machines/${machineId}` : "/machines")
              }
              className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              {isOnline ? t("openMachine") : t("finish")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StepIndicator({ current, skipFirst }: { current: Step; skipFirst?: boolean }) {
  const { t } = useTranslation("enroll");
  const steps = [
    { n: 1, label: t("steps.name") },
    { n: 2, label: t("steps.install") },
    { n: 3, label: t("steps.verify") },
  ];
  return (
    <div className="flex items-center gap-3">
      {steps.map((s, i) => {
        const isPast = current > s.n || (skipFirst && s.n === 1);
        const isCurrent = current === s.n;
        return (
          <div key={s.n} className="flex items-center gap-3 flex-1">
            <div
              className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-medium transition-colors ${
                isPast
                  ? "bg-primary text-primary-foreground"
                  : isCurrent
                  ? "bg-primary/10 text-primary border border-primary/30"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {isPast ? <Check className="w-4 h-4" /> : s.n}
            </div>
            <div
              className={`text-sm font-medium ${
                isCurrent ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              {s.label}
            </div>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-px ${isPast ? "bg-primary" : "bg-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CommandCard({
  index,
  total,
  step,
  copied,
  onCopy,
}: {
  index: number;
  total: number;
  step: InstallStep;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t } = useTranslation(["enroll", "common"]);
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-start justify-between px-4 py-3 border-b border-border">
        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            {t("stepN", { index, total })}
          </div>
          <div className="text-sm font-medium text-foreground mt-0.5">
            {step.title}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {step.description}
          </div>
        </div>
        <button
          onClick={onCopy}
          className="shrink-0 flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              {t("copied")}
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              {t("common:actions.copy")}
            </>
          )}
        </button>
      </div>
      <pre className="px-4 py-3 text-xs font-mono text-foreground overflow-x-auto bg-muted/30 whitespace-pre">
        <Terminal className="inline w-3 h-3 mr-2 text-muted-foreground" />
        {step.command}
      </pre>
    </div>
  );
}

function StatusRow({
  label,
  status,
  hint,
}: {
  label: string;
  status: "ok" | "pending";
  hint: string;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <div className="flex items-center gap-3">
        <span
          className={`w-2 h-2 rounded-full ${
            status === "ok" ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
          }`}
        />
        <span className="text-sm text-foreground">{label}</span>
      </div>
      <span
        className={`text-xs ${
          status === "ok" ? "text-emerald-400" : "text-muted-foreground"
        }`}
      >
        {hint}
      </span>
    </div>
  );
}

function InfoRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded bg-background px-2 py-1 text-xs font-mono truncate">
          {value}
        </code>
        <button
          onClick={onCopy}
          className="p-1.5 rounded border border-border hover:bg-muted transition-colors"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
