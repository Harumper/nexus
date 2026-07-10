import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const agentDir = resolve(__dirname, "../../../agent");

describe("Agent Go Files - Phase 4", () => {
  describe("Single agent type (PROBE removed)", () => {
    it("config.go has no agent-type concept anymore", () => {
      const path = resolve(agentDir, "internal/config/config.go");
      const content = readFileSync(path, "utf8");
      expect(content).not.toContain("AgentType");
      expect(content).not.toContain("NEXUS_AGENT_TYPE");
    });

    it("should have ProcessInterval in config.go", () => {
      const path = resolve(agentDir, "internal/config/config.go");
      const content = readFileSync(path, "utf8");
      expect(content).toContain("ProcessInterval");
      expect(content).toContain("NEXUS_PROCESS_INTERVAL");
    });

    it("main.go has no agent-side probe whitelist/gate", () => {
      const path = resolve(agentDir, "cmd/nexus-agent/main.go");
      const content = readFileSync(path, "utf8");
      expect(content).not.toContain("probeAllowedActions");
      expect(content).not.toContain("action not allowed in probe mode");
    });
  });

  describe("Reboot detection", () => {
    it("should check reboot-required in heartbeat", () => {
      const path = resolve(agentDir, "cmd/nexus-agent/main.go");
      const content = readFileSync(path, "utf8");
      expect(content).toContain("reboot-required");
      expect(content).toContain("reboot_required");
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
      // Install routes through the compiled privhelper (validated names, fixed
      // argv), not a raw `sudo apt-get install *` (NEXUS-AGENT-010).
      expect(content).toContain('"privhelper", "pkg", "install"');
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
    // Script actually served to agents (route /api/agents/install-script) and
    // read by sudoers-version.ts. The systemd unit is embedded in it (heredoc).
    const installScript = resolve(agentDir, "../scripts/install-agent.sh");

    it("should have systemd service (embedded in install script) with non-root user", () => {
      expect(existsSync(installScript)).toBe(true);

      const content = readFileSync(installScript, "utf8");
      expect(content).toContain("[Unit]");
      expect(content).toContain("[Service]");
      expect(content).toContain("[Install]");
      expect(content).toContain("User=nexus-agent");
      expect(content).toContain("Group=nexus-agent");
      // NEXUS-AGENT-002: ambient cleared + bounding set negated (drift-guard).
      expect(content).toContain("AmbientCapabilities=");
      expect(content).toContain("CapabilityBoundingSet=~CAP_DAC_READ_SEARCH CAP_SYS_PTRACE");
      expect(content).toContain("ProtectHome=true");
    });

    it("should have install script with sudoers setup", () => {
      expect(existsSync(installScript)).toBe(true);

      const content = readFileSync(installScript, "utf8");
      expect(content).toContain("--server-url");
      expect(content).toContain("--enrollment-token");
      expect(content).toContain("--machine-id");
      expect(content).toContain("systemctl");
      expect(content).toContain("agent.env");
      expect(content).toContain("sudoers");
      expect(content).toContain("visudo -cf");
      expect(content).toContain("/etc/sudoers.d/nexus-agent");
    });

    it("should support clean uninstall and re-enroll modes (clean slate)", () => {
      const content = readFileSync(installScript, "utf8");
      expect(content).toContain("--uninstall");
      expect(content).toContain("--reenroll");
      expect(content).toContain("do_uninstall");
      // Re-enrollment = full wipe (sudoers/user/binary) while keeping the logs.
      expect(content).toContain("wipe_agent");
      expect(content).toContain("wipe_agent keep-logs");
    });
  });

  describe("Docker compose — no probe service (PROBE removed)", () => {
    it("should not define a probe service or agent-type env", () => {
      const path = resolve(__dirname, "../../../docker-compose.yml");
      const content = readFileSync(path, "utf8");
      expect(content).not.toContain("NEXUS_AGENT_TYPE");
      expect(content).not.toContain("nexus-probe-local");
      expect(content).not.toMatch(/^\s*probe:/m);
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
      // 50 MB cap aligned with the frontend (FS_MAX_SIZE in FilesTab.tsx)
      expect(content).toMatch(/fsMaxSize\s+int64\s*=\s*50\s*\*\s*1024\s*\*\s*1024/);
    });

    it("should deny reading critical secret paths and extensions", () => {
      const content = readFileSync(filesGoPath, "utf8");
      // Denylist by prefix
      expect(content).toContain("/etc/shadow");
      expect(content).toContain("/etc/sudoers");
      expect(content).toContain("/root/.ssh/");
      expect(content).toContain("/var/lib/nexus-agent/keys/");
      // Denylist regex (user SSH keys)
      expect(content).toContain("/\\.ssh/id_");
      // Sensitive extensions
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
      // And fs.list must use Lstat (not Stat) to avoid dereferencing
      expect(content).toContain("os.Lstat");
    });

    it("should auto-suffix on upload conflict (no silent overwrite)", () => {
      const content = readFileSync(filesGoPath, "utf8");
      // Retry loop with -N suffix
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

    it("should register fs.list / fs.read / fs.upload agent actions", () => {
      const path = resolve(agentDir, "internal/actions/files.go");
      const content = readFileSync(path, "utf8");
      expect(content).toContain('return "fs.list"');
      expect(content).toContain('return "fs.read"');
      expect(content).toContain('return "fs.upload"');
    });

    it("should classify fs.list and fs.read as read-only (NOT fs.upload) in READ_ONLY_ACTIONS", () => {
      const path = resolve(__dirname, "../../../backend/src/services/machine-manager.ts");
      const content = readFileSync(path, "utf8");
      // Extract the READ_ONLY_ACTIONS = [ ... ] block
      const block = content.match(/READ_ONLY_ACTIONS\s*=\s*\[([\s\S]*?)\]/);
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

    it("should hide the upload zone outside of the inbox", () => {
      const content = readFileSync(tabPath, "utf8");
      expect(content).toContain("showUpload = isInbox");
    });

    it("should be wired in MachineDetail", () => {
      const detailPath = resolve(__dirname, "../../../frontend/src/pages/MachineDetail.tsx");
      const content = readFileSync(detailPath, "utf8");
      expect(content).toContain('import FilesTab from "../components/FilesTab"');
      expect(content).toContain('activeTab === "files"');
    });

    it("should preview images and text in-place before downloading", () => {
      const content = readFileSync(tabPath, "utf8");
      // Extension selection
      expect(content).toContain("IMAGE_EXTS");
      expect(content).toContain("TEXT_EXTS");
      // Preview caps independent of the DL cap
      expect(content).toContain("PREVIEW_IMAGE_MAX");
      expect(content).toContain("PREVIEW_TEXT_MAX");
      // Preview modal with DL/scp actions
      expect(content).toContain("PreviewModal");
      expect(content).toContain('kind === "image"');
      // Image served via data: URL (no leaking temporary blob)
      expect(content).toContain("data:");
      expect(content).toContain("mimeFor");
    });
  });
});
