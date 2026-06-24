import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
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

export default function MachineEnroll() {
  const { id: paramId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const isRegenerateMode = Boolean(paramId);

  const [step, setStep] = useState<Step>(isRegenerateMode ? 2 : 1);
  const [name, setName] = useState("");
  const [machineType, setMachineType] = useState<"AGENT" | "PROBE">("AGENT");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [machine, setMachine] = useState<Machine | null>(null);
  const [machineId, setMachineId] = useState<string | null>(paramId || null);
  const [bootstrap, setBootstrap] = useState<BootstrapArtifacts | null>(null);
  const [enrollmentToken, setEnrollmentToken] = useState<string>("");

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ===== Regenerate mode : charger la machine + nouveaux tokens au mount =====
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
        // Machine déjà enrôlée (ONLINE/OFFLINE/REVOKED) → ré-enrollement complet :
        // régénère token + clé backend, déconnecte l'agent, et renvoie une
        // commande --reenroll qui purge l'identité résiduelle côté machine.
        // Machine encore ENROLLMENT_PENDING → simple régénération des tokens d'install.
        if (m.status === "ENROLLMENT_PENDING") {
          const artifacts = await api.regenerateBootstrap(paramId);
          if (cancelled) return;
          setBootstrap(artifacts);
        } else {
          const res = await api.reEnrollMachine(paramId);
          if (cancelled) return;
          setBootstrap(res.bootstrap);
        }
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Erreur lors du chargement"));
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
      // On arrête le polling seulement quand l'agent est ONLINE ET que sa
      // version est remontée (elle arrive au 1er heartbeat, juste après le
      // passage ONLINE). Sinon l'écran restait figé sur "version —".
      if (m.status === "ONLINE" && m.agentVersion) {
        stopPolling();
      }
    } catch {
      // ignore transient errors
    }
  }, [machineId, stopPolling]);

  // (Re)démarre le polling : fetch immédiat + interval 2s, avec un plafond de
  // 2 min. Réutilisé par le bouton "Rafraîchir" pour relancer après un arrêt.
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
      const res: CreateMachineResponse = await api.createMachine(name, machineType);
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
        type: machineType,
        sshUser: null,
        isCritical: false,
        lastHeartbeat: null,
        lastMetrics: null,
        enrolledAt: null,
        createdAt: new Date().toISOString(),
      });
      setStep(2);
    } catch (err) {
      setError(getErrorMessage(err, "Erreur lors de la création"));
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

  // ===== Render =====
  return (
    <div className="container max-w-3xl mx-auto py-8 px-4">
      <button
        onClick={() => navigate("/machines")}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Retour
      </button>

      <div className="flex items-center gap-3 mb-8">
        <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10">
          <Server className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {isRegenerateMode ? `Régénérer l'installation — ${name}` : "Ajouter une machine"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isRegenerateMode
              ? "Nouveaux tokens générés. Les anciens ont été invalidés."
              : "Enrolle un nouvel agent sur le serveur Nexus."}
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
              Nom de la machine
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="web-server-01"
              required
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Type de machine
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setMachineType("AGENT")}
                className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors ${
                  machineType === "AGENT"
                    ? "bg-primary/10 border-primary/30"
                    : "bg-muted border-border hover:bg-muted/80"
                }`}
              >
                <span className="text-sm font-semibold text-foreground">Agent</span>
                <span className="text-xs text-muted-foreground">
                  Toutes les actions : metriques, updates, services, pare-feu, paquets, reboot.
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMachineType("PROBE")}
                className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors ${
                  machineType === "PROBE"
                    ? "bg-primary/10 border-primary/30"
                    : "bg-muted border-border hover:bg-muted/80"
                }`}
              >
                <span className="text-sm font-semibold text-foreground">Probe</span>
                <span className="text-xs text-muted-foreground">
                  Monitoring en lecture seule uniquement, aucune mutation.
                </span>
              </button>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => navigate("/machines")}
              className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={loading || !name}
              className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {loading ? "Création..." : "Créer la machine"}
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
                    Commandes valides jusqu'au{" "}
                    {new Date(bootstrap.expiresAt).toLocaleString("fr-FR")}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Exécute ces commandes sur la machine cible (Linux, root requis).
                  </div>
                </div>
                <button
                  onClick={() => copy(bootstrap.installCommand, "all")}
                  className="shrink-0 flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  {copiedKey === "all" ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  Tout copier
                </button>
              </div>

              <div className="space-y-4">
                {bootstrap.installSteps.map((s, i) => (
                  <CommandCard
                    key={s.id}
                    index={i + 1}
                    total={bootstrap.installSteps.length}
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
                  Plus tard
                </button>
                <button
                  onClick={() => setStep(3)}
                  className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  J'ai exécuté les commandes
                </button>
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-sm text-amber-200 space-y-3">
              <div className="font-medium">
                Génération automatique des commandes désactivée
              </div>
              <p>
                La variable d'environnement <code className="font-mono text-xs">AGENT_BACKEND_URL</code>{" "}
                n'est pas configurée côté serveur. La machine a été créée mais vous
                devrez installer l'agent manuellement avec ces informations :
              </p>
              {machineId && (
                <div className="space-y-2 mt-3">
                  <InfoRow label="Machine ID" value={machineId} copied={copiedKey === "mid"} onCopy={() => copy(machineId, "mid")} />
                  {enrollmentToken && (
                    <InfoRow
                      label="Enrollment token"
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
              Vérification de la connexion
            </h2>
            <p className="text-sm text-muted-foreground mb-5">
              Nexus surveille la connexion de l'agent en temps réel.
            </p>

            <div className="space-y-3">
              <StatusRow
                label="Handshake ECDSA"
                status={isOnline ? "ok" : "pending"}
                hint={isOnline ? "Validé" : "En attente..."}
              />
              <StatusRow
                label="Connexion WebSocket"
                status={lastHeartbeatRecent ? "ok" : "pending"}
                hint={
                  lastHeartbeatRecent
                    ? "Connecté"
                    : "Pas encore de heartbeat reçu"
                }
              />
              <StatusRow
                label="Version de l'agent"
                status={machine?.agentVersion ? "ok" : "pending"}
                hint={machine?.agentVersion || "—"}
              />
            </div>

            <div className="mt-6 flex items-center justify-between gap-3">
              {isOnline ? (
                <div className="flex-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-4 py-3 text-sm text-emerald-400 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  Agent connecté —{" "}
                  {machine?.hostname && <span>{machine.hostname} — </span>}
                  {machine?.ipAddress}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Surveillance de la connexion...
                </div>
              )}
              {/* Bouton toujours disponible : relance le polling (utile si le
                  polling s'est arrêté ou si l'agent s'est connecté après coup). */}
              <button
                onClick={startPolling}
                className="shrink-0 flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                title="Rafraîchir l'état de la connexion"
              >
                <RefreshCw className="w-4 h-4" />
                Rafraîchir
              </button>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setStep(2)}
              className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              Revoir les commandes
            </button>
            <button
              onClick={() =>
                navigate(isOnline && machineId ? `/machines/${machineId}` : "/machines")
              }
              className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              {isOnline ? "Ouvrir la machine" : "Terminer"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StepIndicator({ current, skipFirst }: { current: Step; skipFirst?: boolean }) {
  const steps = [
    { n: 1, label: "Nom" },
    { n: 2, label: "Installation" },
    { n: 3, label: "Vérification" },
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
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-start justify-between px-4 py-3 border-b border-border">
        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            Étape {index}/{total}
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
              Copié
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              Copier
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
