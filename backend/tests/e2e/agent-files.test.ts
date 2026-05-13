import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const agentDir = resolve(__dirname, "../../../agent");

describe("Agent Go Files - Phase 4", () => {
  describe("Probe vs Agent split", () => {
    it("should have AgentType in config.go", () => {
      const path = resolve(agentDir, "internal/config/config.go");
      const content = readFileSync(path, "utf8");
      expect(content).toContain("AgentType");
      expect(content).toContain("NEXUS_AGENT_TYPE");
      expect(content).toContain('"agent"'); // default value
    });

    it("should have ProcessInterval in config.go", () => {
      const path = resolve(agentDir, "internal/config/config.go");
      const content = readFileSync(path, "utf8");
      expect(content).toContain("ProcessInterval");
      expect(content).toContain("NEXUS_PROCESS_INTERVAL");
    });

    it("should have probe mode whitelist in main.go", () => {
      const path = resolve(agentDir, "cmd/nexus-agent/main.go");
      const content = readFileSync(path, "utf8");
      expect(content).toContain("probeAllowedActions");
      expect(content).toContain("probe");
      expect(content).toContain("action not allowed in probe mode");
    });
  });

  describe("Reboot detection", () => {
    it("should check reboot-required in heartbeat", () => {
      const path = resolve(agentDir, "cmd/nexus-agent/main.go");
      const content = readFileSync(path, "utf8");
      expect(content).toContain("reboot-required");
      expect(content).toContain("reboot_required");
      expect(content).toContain("agent_type");
    });
  });

  describe("Network collector", () => {
    it("should have network.go collector", () => {
      const path = resolve(agentDir, "internal/collector/network.go");
      expect(existsSync(path)).toBe(true);

      const content = readFileSync(path, "utf8");
      expect(content).toContain("NetworkInterface");
      expect(content).toContain("GetNetworkStats");
      expect(content).toContain("/net/dev");
      expect(content).toContain("RxBytesPerSec");
      expect(content).toContain("TxBytesPerSec");
    });
  });

  describe("Process collector", () => {
    it("should have processes.go collector", () => {
      const path = resolve(agentDir, "internal/collector/processes.go");
      expect(existsSync(path)).toBe(true);

      const content = readFileSync(path, "utf8");
      expect(content).toContain("ProcessInfo");
      expect(content).toContain("ProcessList");
      expect(content).toContain("GetTopProcesses");
      expect(content).toContain("TopCPU");
      expect(content).toContain("TopMemory");
    });
  });

  describe("New actions", () => {
    it("should have package.install action", () => {
      const path = resolve(agentDir, "internal/actions/package_install.go");
      expect(existsSync(path)).toBe(true);

      const content = readFileSync(path, "utf8");
      expect(content).toContain('"package.install"');
      expect(content).toContain('"packages"');
      expect(content).toContain("apt-get");
    });

    it("should have package.remove action", () => {
      const path = resolve(agentDir, "internal/actions/package_remove.go");
      expect(existsSync(path)).toBe(true);

      const content = readFileSync(path, "utf8");
      expect(content).toContain('"package.remove"');
      expect(content).toContain("remove");
    });

    it("should have script.execute action", () => {
      const path = resolve(agentDir, "internal/actions/script_execute.go");
      expect(existsSync(path)).toBe(true);

      const content = readFileSync(path, "utf8");
      expect(content).toContain('"script.execute"');
      expect(content).toContain('"scripts"');
      expect(content).toContain("10240"); // max 10KB
      expect(content).toContain("timeout");
    });

    it("should have system.processes action", () => {
      const path = resolve(agentDir, "internal/actions/processes.go");
      expect(existsSync(path)).toBe(true);

      const content = readFileSync(path, "utf8");
      expect(content).toContain('"system.processes"');
      expect(content).toContain('"monitoring"');
    });
  });

  describe("Systemd deployment", () => {
    it("should have systemd service file with non-root user", () => {
      const path = resolve(agentDir, "deploy/nexus-agent.service");
      expect(existsSync(path)).toBe(true);

      const content = readFileSync(path, "utf8");
      expect(content).toContain("[Unit]");
      expect(content).toContain("[Service]");
      expect(content).toContain("[Install]");
      expect(content).toContain("User=nexus-agent");
      expect(content).toContain("Group=nexus-agent");
      expect(content).toContain("AmbientCapabilities=CAP_NET_RAW");
      expect(content).toContain("ProtectHome=true");
    });

    it("should have install script with sudoers setup", () => {
      const path = resolve(agentDir, "deploy/install.sh");
      expect(existsSync(path)).toBe(true);

      const content = readFileSync(path, "utf8");
      expect(content).toContain("--server");
      expect(content).toContain("--token");
      expect(content).toContain("--machine-id");
      expect(content).toContain("systemctl");
      expect(content).toContain("agent.env");
      expect(content).toContain("sudoers");
      expect(content).toContain("visudo -cf");
      expect(content).toContain("/etc/sudoers.d/nexus-agent");
    });
  });

  describe("Docker compose probe rename", () => {
    it("should have probe service instead of agent", () => {
      const path = resolve(__dirname, "../../../docker-compose.yml");
      const content = readFileSync(path, "utf8");
      expect(content).toContain("probe:");
      expect(content).toContain("NEXUS_AGENT_TYPE: probe");
      expect(content).toContain("nexus-probe-local");
      expect(content).not.toContain("nexus-agent-local");
    });
  });

  describe("Files browser (fs.list / fs.read / fs.upload)", () => {
    const filesGoPath = resolve(agentDir, "internal/actions/files.go");

    it("should have files.go with three registered actions", () => {
      expect(existsSync(filesGoPath)).toBe(true);
      const content = readFileSync(filesGoPath, "utf8");
      expect(content).toContain("Register(&FsListAction{})");
      expect(content).toContain("Register(&FsReadAction{})");
      expect(content).toContain("Register(&FsUploadAction{})");
      expect(content).toContain('fs.list');
      expect(content).toContain('fs.read');
      expect(content).toContain('fs.upload');
    });

    it("should enforce a hard size cap to keep WebSocket transport sane", () => {
      const content = readFileSync(filesGoPath, "utf8");
      // 50 MB cap aligné avec le frontend (FS_MAX_SIZE dans FilesTab.tsx)
      expect(content).toMatch(/fsMaxSize\s+int64\s*=\s*50\s*\*\s*1024\s*\*\s*1024/);
    });

    it("should deny reading critical secret paths and extensions", () => {
      const content = readFileSync(filesGoPath, "utf8");
      // Denylist par préfixe
      expect(content).toContain("/etc/shadow");
      expect(content).toContain("/etc/sudoers");
      expect(content).toContain("/root/.ssh/");
      expect(content).toContain("/var/lib/nexus-agent/keys/");
      // Denylist regex (clés SSH utilisateur)
      expect(content).toContain("/\\.ssh/id_");
      // Extensions sensibles
      expect(content).toContain('".pem"');
      expect(content).toContain('".key"');
      expect(content).toContain('".gpg"');
    });

    it("should refuse path traversal and require absolute paths", () => {
      const content = readFileSync(filesGoPath, "utf8");
      expect(content).toContain("path traversal refused");
      expect(content).toContain("path must be absolute");
    });

    it("should refuse following symlinks on fs.read", () => {
      const content = readFileSync(filesGoPath, "utf8");
      expect(content).toContain("symlink read refused");
      // Et fs.list doit utiliser Lstat (pas Stat) pour ne pas déréférencer
      expect(content).toContain("os.Lstat");
    });

    it("should auto-suffix on upload conflict (no silent overwrite)", () => {
      const content = readFileSync(filesGoPath, "utf8");
      // Boucle de tentatives avec suffixe -N
      expect(content).toContain("O_EXCL");
      expect(content).toContain("name collisions");
    });

    it("should write uploads to /var/lib/nexus-agent/inbox with mode 0640", () => {
      const content = readFileSync(filesGoPath, "utf8");
      expect(content).toContain("/var/lib/nexus-agent/inbox");
      expect(content).toContain("0o640");
    });

    it("should sanitize upload filenames to POSIX-safe charset", () => {
      const content = readFileSync(filesGoPath, "utf8");
      expect(content).toMatch(/A-Za-z0-9\._-/);
    });

    it("should TTL-cleanup the inbox after 7 days", () => {
      const content = readFileSync(filesGoPath, "utf8");
      expect(content).toContain("CleanupInbox");
      expect(content).toContain("7 * 24 * time.Hour");
    });

    it("should call CleanupInbox periodically from main loop", () => {
      const path = resolve(agentDir, "cmd/nexus-agent/main.go");
      const content = readFileSync(path, "utf8");
      expect(content).toContain("actions.CleanupInbox()");
    });

    it("should expose fs.list and fs.read in probe whitelist but NOT fs.upload", () => {
      const path = resolve(agentDir, "cmd/nexus-agent/main.go");
      const content = readFileSync(path, "utf8");
      // Extrait juste le bloc probeAllowedActions pour des assertions précises
      const block = content.match(/probeAllowedActions\s*=\s*map\[string\]bool\{([\s\S]*?)\}/);
      expect(block).not.toBeNull();
      const body = block![1];
      expect(body).toContain('"fs.list"');
      expect(body).toContain('"fs.read"');
      expect(body).not.toContain('"fs.upload"');
    });

    it("should mirror fs.list and fs.read (NOT fs.upload) in backend PROBE_ALLOWED_ACTIONS", () => {
      const path = resolve(__dirname, "../../../backend/src/services/machine-manager.ts");
      const content = readFileSync(path, "utf8");
      // Extrait le bloc PROBE_ALLOWED_ACTIONS = [ ... ]
      const block = content.match(/PROBE_ALLOWED_ACTIONS\s*=\s*\[([\s\S]*?)\]/);
      expect(block).not.toBeNull();
      const body = block![1];
      expect(body).toContain('"fs.list"');
      expect(body).toContain('"fs.read"');
      expect(body).not.toContain('"fs.upload"');
    });

    it("install-agent.sh should provision the inbox directory", () => {
      const path = resolve(__dirname, "../../../scripts/install-agent.sh");
      const content = readFileSync(path, "utf8");
      expect(content).toContain("/inbox");
      expect(content).toContain("chmod 0750");
    });
  });

  describe("FilesTab (frontend)", () => {
    const tabPath = resolve(__dirname, "../../../frontend/src/components/FilesTab.tsx");

    it("should exist and align its size cap with the agent", () => {
      expect(existsSync(tabPath)).toBe(true);
      const content = readFileSync(tabPath, "utf8");
      expect(content).toContain("FS_MAX_SIZE = 50 * 1024 * 1024");
    });

    it("should generate scp/rsync commands when files exceed the cap", () => {
      const content = readFileSync(tabPath, "utf8");
      expect(content).toContain("scpDownloadCmd");
      expect(content).toContain("rsyncDownloadCmd");
      expect(content).toContain("scpUploadCmd");
      expect(content).toContain("TooLargeModal");
    });

    it("should hide the upload zone outside of inbox and for PROBE machines", () => {
      const content = readFileSync(tabPath, "utf8");
      expect(content).toContain("showUpload = canUpload && isInbox");
    });

    it("should be wired in MachineDetail", () => {
      const detailPath = resolve(__dirname, "../../../frontend/src/pages/MachineDetail.tsx");
      const content = readFileSync(detailPath, "utf8");
      expect(content).toContain('import FilesTab from "../components/FilesTab"');
      expect(content).toContain('activeTab === "files"');
      expect(content).toContain('canUpload={isAgent}');
    });
  });
});
