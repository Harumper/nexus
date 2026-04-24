import { useState, useEffect } from "react";
import { X, Copy, Check, Terminal as TerminalIcon, ExternalLink, Info } from "lucide-react";

interface Props {
  ipAddress: string;
  defaultUser?: string | null;
  onClose: () => void;
}

type OS = "macos" | "windows" | "linux" | "unknown";

function detectOS(): OS {
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform || "").toLowerCase();
  if (/mac|iphone|ipad/.test(platform) || /mac|iphone|ipad/.test(ua)) return "macos";
  if (/win/.test(platform) || /windows/.test(ua)) return "windows";
  if (/linux/.test(platform) || /linux/.test(ua)) return "linux";
  return "unknown";
}

export default function SshConnectDialog({ ipAddress, defaultUser, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const [sshUser, setSshUser] = useState<string>(() => {
    // Priorite : user configure sur la machine > user memorise globalement
    return defaultUser || localStorage.getItem("nexus.ssh.user") || "";
  });
  const [os, setOs] = useState<OS>("unknown");

  useEffect(() => { setOs(detectOS()); }, []);

  const command = sshUser ? `ssh ${sshUser}@${ipAddress}` : `ssh ${ipAddress}`;
  const sshUri = sshUser ? `ssh://${sshUser}@${ipAddress}` : `ssh://${ipAddress}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const saveUser = (u: string) => {
    setSshUser(u);
    if (u) localStorage.setItem("nexus.ssh.user", u);
    else localStorage.removeItem("nexus.ssh.user");
  };

  const tryOpenTerminal = () => {
    // Tente d'ouvrir via le scheme ssh://. Ne marchera que si un handler est enregistre.
    window.location.href = sshUri;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-xl overflow-hidden"
        style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid var(--nx-border)" }}>
          <div className="flex items-center gap-2">
            <TerminalIcon className="w-4 h-4" style={{ color: "var(--nx-info)" }} />
            <h2 className="text-sm font-semibold">Connexion SSH</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* User field */}
          <div>
            <label className="block text-xs font-medium mb-1.5">Utilisateur SSH (mémorisé pour la prochaine fois)</label>
            <input
              type="text"
              value={sshUser}
              onChange={(e) => saveUser(e.target.value.trim())}
              placeholder="root, admin, ubuntu…"
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </div>

          {/* Command to copy */}
          <div>
            <label className="block text-xs font-medium mb-1.5">Commande</label>
            <div className="flex gap-2">
              <code
                className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm font-mono truncate"
                style={{ background: "var(--nx-bg-elevated)" }}
              >
                {command}
              </code>
              <button
                onClick={copy}
                className="inline-flex items-center gap-1.5 rounded px-3 py-2 text-xs font-medium"
                style={{ background: "var(--nx-primary)", color: "var(--nx-bg-base)" }}
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? "Copié" : "Copier"}
              </button>
            </div>
          </div>

          {/* Try open button */}
          <div className="rounded-lg p-3 flex items-start gap-3" style={{ background: "var(--nx-bg-elevated)" }}>
            <Info className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "var(--nx-info)" }} />
            <div className="flex-1 text-xs space-y-2">
              <p>
                Si un gestionnaire <code className="font-mono">ssh://</code> est configuré sur votre OS,
                le bouton ci-dessous ouvrira un terminal directement. Sinon, copiez la commande
                ci-dessus et collez-la dans votre terminal.
              </p>
              <button
                onClick={tryOpenTerminal}
                className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium"
                style={{ border: "1px solid var(--nx-info)", color: "var(--nx-info)" }}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Tenter d'ouvrir un terminal
              </button>
            </div>
          </div>

          {/* OS-specific instructions */}
          <details className="rounded-lg border border-border" open={os !== "unknown"}>
            <summary className="px-4 py-2 text-xs font-medium cursor-pointer hover:bg-muted">
              Comment configurer ssh:// sur mon OS {os !== "unknown" && `(${osLabel(os)} détecté)`}
            </summary>
            <div className="px-4 py-3 text-xs space-y-4" style={{ color: "var(--nx-text-weak)" }}>
              <OsSection
                title="macOS"
                active={os === "macos"}
              >
                <p>macOS ne définit plus de handler <code>ssh://</code> par défaut depuis 10.6. Pour activer :</p>
                <ol className="list-decimal list-inside space-y-1 mt-2">
                  <li>Installer <a href="https://github.com/Lord-Kamina/SwiftDefaultApps" target="_blank" rel="noopener noreferrer" className="underline">SwiftDefaultApps</a> via Homebrew : <code className="block mt-1 font-mono bg-muted px-2 py-1 rounded">brew install --cask swiftdefaultappsprefpane</code></li>
                  <li>Ouvrir Réglages système → SwiftDefaultApps → onglet <strong>URL Schemes</strong></li>
                  <li>Associer <code>ssh</code> à <strong>Terminal.app</strong> (ou iTerm2/Warp)</li>
                </ol>
              </OsSection>

              <OsSection title="Linux (GNOME/KDE)" active={os === "linux"}>
                <p>Créer un fichier desktop qui déclare le handler :</p>
                <pre className="mt-2 font-mono bg-muted px-2 py-2 rounded text-[11px] overflow-x-auto">{`# ~/.local/share/applications/ssh-handler.desktop
[Desktop Entry]
Name=SSH Handler
Exec=gnome-terminal -- ssh %u
Type=Application
Terminal=false
MimeType=x-scheme-handler/ssh;
NoDisplay=true`}</pre>
                <p className="mt-2">Puis enregistrer le handler :</p>
                <pre className="mt-1 font-mono bg-muted px-2 py-2 rounded text-[11px]">{`update-desktop-database ~/.local/share/applications/
xdg-mime default ssh-handler.desktop x-scheme-handler/ssh`}</pre>
                <p className="mt-2">Remplace <code>gnome-terminal</code> par <code>konsole --new-tab -e</code>, <code>xfce4-terminal -e</code>, <code>alacritty -e</code>… selon ton DE.</p>
              </OsSection>

              <OsSection title="Windows 10/11" active={os === "windows"}>
                <p>Plusieurs options :</p>
                <ul className="list-disc list-inside space-y-1 mt-2">
                  <li><strong>PuTTY</strong> : lors de l'installation, cocher « associer aux URL ssh:// »</li>
                  <li><strong>Windows Terminal</strong> : installer <a href="https://www.microsoft.com/store/productid/9N0DX20HK701" target="_blank" rel="noopener noreferrer" className="underline">Windows Terminal</a> 1.16+ et créer un .reg :
                    <pre className="mt-1 font-mono bg-muted px-2 py-2 rounded text-[11px] overflow-x-auto">{`Windows Registry Editor Version 5.00
[HKEY_CLASSES_ROOT\\ssh]
"URL Protocol"=""
@="URL:ssh"
[HKEY_CLASSES_ROOT\\ssh\\shell\\open\\command]
@="\\"C:\\\\Windows\\\\System32\\\\cmd.exe\\" /c start wt.exe ssh %1"`}</pre>
                  </li>
                  <li><strong>OpenSSH</strong> (builtin Win10+) : utilisez <a href="https://kb.openrport.io/getting-started/using-the-remote-access/open-ssh-from-the-browser" target="_blank" rel="noopener noreferrer" className="underline">le script RPort</a></li>
                </ul>
              </OsSection>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

function OsSection({ title, active, children }: { title: string; active: boolean; children: React.ReactNode }) {
  return (
    <div
      className="rounded p-3"
      style={{
        background: active ? "var(--nx-info-subtle)" : "transparent",
        border: active ? "1px solid var(--nx-info)" : "1px solid var(--nx-border)",
      }}
    >
      <div className="font-semibold mb-1 flex items-center gap-2" style={{ color: active ? "var(--nx-info)" : "var(--nx-text)" }}>
        {title}
        {active && <span className="text-[10px] uppercase tracking-wider">Votre OS</span>}
      </div>
      {children}
    </div>
  );
}

function osLabel(os: OS): string {
  return { macos: "macOS", windows: "Windows", linux: "Linux", unknown: "" }[os];
}
