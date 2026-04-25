import { useState } from "react";
import { Copy, Check, Terminal as TerminalIcon, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { Dialog, Button } from "./ui";

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
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <TerminalIcon className="w-4 h-4 text-info" /> Connexion SSH
        </span>
      }
    >
      <div className="space-y-3">
        <div className="flex gap-2">
          <code className="flex-1 rounded border border-input bg-elevated px-3 py-2 text-sm font-mono truncate">
            {command}
          </code>
          <Button
            variant="primary"
            size="md"
            onClick={copy}
            icon={copied ? <Check /> : <Copy />}
          >
            {copied ? "Copié" : "Copier"}
          </Button>
        </div>

        <a
          href={sshUri}
          className="flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium border border-info text-info hover:bg-info-subtle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Ouvrir dans le terminal
        </a>

        <p className="text-[11px] text-center text-muted-foreground">
          Si le bouton ne fait rien, voir la{" "}
          <Link
            to="/docs?section=ssh"
            className="underline text-info hover:opacity-80"
            onClick={onClose}
          >
            configuration SSH par OS
          </Link>
          .
        </p>
      </div>
    </Dialog>
  );
}
