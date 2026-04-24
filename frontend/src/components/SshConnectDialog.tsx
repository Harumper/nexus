import { useState } from "react";
import { X, Copy, Check, Terminal as TerminalIcon, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";

interface Props {
  ipAddress: string;
  defaultUser?: string | null;
  onClose: () => void;
}

export default function SshConnectDialog({ ipAddress, defaultUser, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const user = defaultUser || "";
  const command = user ? `ssh ${user}@${ipAddress}` : `ssh ${ipAddress}`;
  const sshUri = user ? `ssh://${user}@${ipAddress}` : `ssh://${ipAddress}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl"
        style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid var(--nx-border)" }}>
          <div className="flex items-center gap-2">
            <TerminalIcon className="w-4 h-4" style={{ color: "var(--nx-info)" }} />
            <h2 className="text-sm font-semibold">Connexion SSH</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="flex gap-2">
            <code
              className="flex-1 rounded border border-input px-3 py-2 text-sm font-mono truncate"
              style={{ background: "var(--nx-bg-elevated)" }}
            >
              {command}
            </code>
            <button
              onClick={copy}
              className="shrink-0 inline-flex items-center gap-1.5 rounded px-3 py-2 text-xs font-medium"
              style={{ background: "var(--nx-primary)", color: "var(--nx-bg-base)" }}
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Copié" : "Copier"}
            </button>
          </div>

          <a
            href={sshUri}
            className="flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium"
            style={{ border: "1px solid var(--nx-info)", color: "var(--nx-info)" }}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Ouvrir dans le terminal
          </a>

          <p className="text-[11px] text-center" style={{ color: "var(--nx-text-weak)" }}>
            Si le bouton ne fait rien, voir la{" "}
            <Link to="/docs?section=ssh" className="underline" style={{ color: "var(--nx-info)" }} onClick={onClose}>
              configuration SSH par OS
            </Link>.
          </p>
        </div>
      </div>
    </div>
  );
}
