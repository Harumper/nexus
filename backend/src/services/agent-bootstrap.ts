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

// Design A: release PUBLIC key (minisign) configured by the operator on the
// backend (env, never via the UI). If present, it is embedded in the bootstrap
// command → the installer writes /etc/nexus/release.pub at install AND at
// reenroll (which purges /etc/nexus). Closes the "reenroll loses release.pub" footgun.
// It's a public key: no secret transits. The PRIVATE key stays offline.
export function getReleasePubKey(): string {
  return (process.env.NEXUS_RELEASE_PUBKEY || "").trim();
}

interface GenerateStepsParams {
  machineId: string;
  machineName: string;
  enrollmentToken: string;
  backendPublicKey: string;
  binaryToken: string;
  scriptToken: string;
  backendUrl: string;
  // Re-enrollment: adds --reenroll so the script purges the residual identity
  // (keys, shared secret, snapshots) before re-enrolling cleanly.
  reenroll?: boolean;
}

export function generateInstallSteps(params: GenerateStepsParams): InstallStep[] {
  const { machineId, enrollmentToken, backendPublicKey, binaryToken, scriptToken, backendUrl, reenroll } =
    params;
  const wsUrl = getWsAgentUrl(backendUrl);
  const reenrollFlag = reenroll ? " \\\n  --reenroll" : "";

  // Design A: if the operator configured a release key on the backend, we
  // write it to a temp file and pass --release-pubkey-file → placed in
  // /etc/nexus/release.pub (install AND reenroll). Otherwise, behavior unchanged.
  const releasePubKey = getReleasePubKey();
  const releaseTee = releasePubKey
    ? `\nsudo rm -f /tmp/nexus-release.pub
sudo tee /tmp/nexus-release.pub > /dev/null <<'NEXUS_RELEASE_PUBKEY_EOF'
${releasePubKey}
NEXUS_RELEASE_PUBKEY_EOF`
    : "";
  const releaseFlag = releasePubKey
    ? " \\\n  --release-pubkey-file /tmp/nexus-release.pub"
    : "";

  return [
    {
      id: "binary",
      title: "Download the agent binary",
      description: "Fetches the nexus-agent binary from the server into /tmp.",
      // rm -f first: on a host that already has a /tmp/nexus-agent from a
      // previous run (different owner), fs.protected_regular refuses the write
      // even as root. So we delete before re-downloading.
      command: `sudo rm -f /tmp/nexus-agent && curl -fSL "${backendUrl}/api/agents/download?token=${binaryToken}" \\
  -o /tmp/nexus-agent && chmod +x /tmp/nexus-agent`,
    },
    {
      id: "script",
      title: "Download the installation script",
      description: "Fetches the install-agent.sh script that configures the Linux user, sudoers and systemd.",
      command: `sudo rm -f /tmp/install-agent.sh && curl -fSL "${backendUrl}/api/agents/install-script?token=${scriptToken}" \\
  -o /tmp/install-agent.sh && chmod +x /tmp/install-agent.sh`,
    },
    {
      id: "run",
      title: reenroll ? "Purge, reinstall and re-enroll the agent" : "Install and start the agent",
      description: reenroll
        ? "CLEAN SLATE (binary, keys, secret, config, sudoers, user; logs kept) then clean reinstall + re-enroll."
        : "Writes the server public key to a temp file then launches the installation.",
      command: `sudo rm -f /tmp/nexus-pubkey.pem
sudo tee /tmp/nexus-pubkey.pem > /dev/null <<'NEXUS_PUBKEY_EOF'
${backendPublicKey.trimEnd()}
NEXUS_PUBKEY_EOF${releaseTee}
sudo /tmp/install-agent.sh \\
  --server-url "${wsUrl}" \\
  --machine-id "${machineId}" \\
  --enrollment-token "${enrollmentToken}" \\
  --server-public-key-file /tmp/nexus-pubkey.pem${releaseFlag} \\
  --binary /tmp/nexus-agent${reenrollFlag}`,
    },
  ];
}

export function stepsToSingleCommand(steps: InstallStep[]): string {
  return steps
    .map((s, i) => `# Step ${i + 1}/${steps.length} — ${s.title}\n${s.command}`)
    .join("\n\n");
}
