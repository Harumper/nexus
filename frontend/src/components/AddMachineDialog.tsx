import { useState, type FormEvent } from "react";
import { X, Copy, Check, Terminal } from "lucide-react";
import { api } from "../services/api";
import type { CreateMachineResponse } from "../types";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export default function AddMachineDialog({ onClose, onCreated }: Props) {
  const [step, setStep] = useState<"form" | "result">("form");
  const [name, setName] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>(["monitoring"]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CreateMachineResponse | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await api.createMachine(name, capabilities);
      setResult(res);
      setStep("result");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const toggleCapability = (cap: string) => {
    setCapabilities((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">
            {step === "form" ? "Ajouter une machine" : "Machine créée"}
          </h2>
          <button
            onClick={step === "result" ? onCreated : onClose}
            className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {step === "form" ? (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && (
              <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

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
                Capabilities
              </label>
              <div className="flex flex-wrap gap-2">
                {["monitoring", "updates", "terminal"].map((cap) => (
                  <button
                    key={cap}
                    type="button"
                    onClick={() => toggleCapability(cap)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      capabilities.includes(cap)
                        ? "bg-primary/10 border-primary/30 text-primary"
                        : "bg-muted border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {cap}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
              >
                Annuler
              </button>
              <button
                type="submit"
                disabled={loading || !name}
                className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {loading ? "Création..." : "Créer"}
              </button>
            </div>
          </form>
        ) : (
          result && (
            <div className="p-6 space-y-4">
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-4 py-3 text-sm text-emerald-400">
                Machine "{result.name}" créée avec succès
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Machine ID
                </label>
                <CopyField
                  value={result.id}
                  copied={copied === "id"}
                  onCopy={() => copyToClipboard(result.id, "id")}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Token d'enrollment
                </label>
                <CopyField
                  value={result.enrollmentToken}
                  copied={copied === "token"}
                  onCopy={() =>
                    copyToClipboard(result.enrollmentToken, "token")
                  }
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Usage unique. Expire le{" "}
                  {new Date(result.expiresAt).toLocaleString("fr-FR")}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Clé publique du serveur
                </label>
                <CopyField
                  value={result.backendPublicKey}
                  copied={copied === "pubkey"}
                  onCopy={() =>
                    copyToClipboard(result.backendPublicKey, "pubkey")
                  }
                  multiline
                />
              </div>

              <div className="rounded-lg bg-muted p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Terminal className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">
                    Déployer l'agent
                  </span>
                </div>
                <pre className="text-xs text-muted-foreground overflow-x-auto">
{`NEXUS_SERVER_URL=wss://votre-serveur/ws/agent \\
NEXUS_MACHINE_ID=${result.id} \\
NEXUS_ENROLLMENT_TOKEN=${result.enrollmentToken} \\
nexus-agent`}
                </pre>
              </div>

              <button
                onClick={onCreated}
                className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Fermer
              </button>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function CopyField({
  value,
  copied,
  onCopy,
  multiline,
}: {
  value: string;
  copied: boolean;
  onCopy: () => void;
  multiline?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <div
        className={`flex-1 rounded-lg border border-input bg-background px-3 py-2 text-xs font-mono text-foreground ${
          multiline ? "max-h-20 overflow-y-auto whitespace-pre-wrap break-all" : "truncate"
        }`}
      >
        {value}
      </div>
      <button
        onClick={onCopy}
        className="shrink-0 p-2 rounded-lg border border-input text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        title="Copier"
      >
        {copied ? (
          <Check className="w-4 h-4 text-emerald-400" />
        ) : (
          <Copy className="w-4 h-4" />
        )}
      </button>
    </div>
  );
}
