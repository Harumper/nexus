export interface InstallStep {
  id: string;
  title: string;
  description: string;
  command: string;
}

export interface BootstrapArtifacts {
  installSteps: InstallStep[];
  installCommand: string;
  expiresAt: string;
}

export function getAgentBackendUrl(): string {
  const url = process.env.AGENT_BACKEND_URL;
  if (!url) {
    throw new Error(
      "AGENT_BACKEND_URL environment variable is required to generate install commands"
    );
  }
  return url.replace(/\/$/, "");
}

export function getWsAgentUrl(backendUrl: string): string {
  // http:// -> ws://, https:// -> wss://
  const wsBase = backendUrl.replace(/^http(s?):/, (_m, s) => `ws${s}:`);
  return `${wsBase}/ws/agent`;
}

interface GenerateStepsParams {
  machineId: string;
  machineName: string;
  enrollmentToken: string;
  backendPublicKey: string;
  binaryToken: string;
  scriptToken: string;
  backendUrl: string;
}

export function generateInstallSteps(params: GenerateStepsParams): InstallStep[] {
  const { machineId, enrollmentToken, backendPublicKey, binaryToken, scriptToken, backendUrl } =
    params;
  const wsUrl = getWsAgentUrl(backendUrl);

  return [
    {
      id: "binary",
      title: "Télécharger le binaire de l'agent",
      description: "Récupère le binaire nexus-agent depuis le serveur dans /tmp.",
      command: `curl -fSL "${backendUrl}/api/agents/download?token=${binaryToken}" \\
  -o /tmp/nexus-agent && chmod +x /tmp/nexus-agent`,
    },
    {
      id: "script",
      title: "Télécharger le script d'installation",
      description: "Récupère le script install-agent.sh qui configure user Linux, sudoers et systemd.",
      command: `curl -fSL "${backendUrl}/api/agents/install-script?token=${scriptToken}" \\
  -o /tmp/install-agent.sh && chmod +x /tmp/install-agent.sh`,
    },
    {
      id: "run",
      title: "Installer et démarrer l'agent",
      description: "Écrit la clé publique du serveur dans un fichier temporaire puis lance l'installation.",
      command: `sudo tee /tmp/nexus-pubkey.pem > /dev/null <<'NEXUS_PUBKEY_EOF'
${backendPublicKey.trimEnd()}
NEXUS_PUBKEY_EOF
sudo /tmp/install-agent.sh \\
  --server-url "${wsUrl}" \\
  --machine-id "${machineId}" \\
  --enrollment-token "${enrollmentToken}" \\
  --server-public-key-file /tmp/nexus-pubkey.pem \\
  --binary /tmp/nexus-agent`,
    },
  ];
}

export function stepsToSingleCommand(steps: InstallStep[]): string {
  return steps
    .map((s, i) => `# Étape ${i + 1}/${steps.length} — ${s.title}\n${s.command}`)
    .join("\n\n");
}
