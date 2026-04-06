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
    it("should have systemd service file", () => {
      const path = resolve(agentDir, "deploy/nexus-agent.service");
      expect(existsSync(path)).toBe(true);

      const content = readFileSync(path, "utf8");
      expect(content).toContain("[Unit]");
      expect(content).toContain("[Service]");
      expect(content).toContain("[Install]");
      expect(content).toContain("nexus-agent");
      expect(content).toContain("ProtectSystem=strict");
      expect(content).toContain("NoNewPrivileges=true");
    });

    it("should have install script", () => {
      const path = resolve(agentDir, "deploy/install.sh");
      expect(existsSync(path)).toBe(true);

      const content = readFileSync(path, "utf8");
      expect(content).toContain("--server");
      expect(content).toContain("--token");
      expect(content).toContain("--machine-id");
      expect(content).toContain("systemctl");
      expect(content).toContain("agent.env");
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
});
