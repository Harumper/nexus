const API_BASE = "/api";

class ApiClient {
  private token: string | null = null;
  private onUnauthorized: (() => void) | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  /** Register a callback triggered on 401 responses (token expired/invalid) */
  setOnUnauthorized(callback: () => void) {
    this.onUnauthorized = callback;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...((options.headers as Record<string, string>) || {}),
    };

    // Ne pas envoyer Content-Type si pas de body (ex: DELETE, GET)
    // Fastify rejette les requetes avec Content-Type: application/json + body vide
    if (options.body != null) {
      headers["Content-Type"] = "application/json";
    }

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      // Si 401 sur un endpoint protégé (pas login), forcer la déconnexion
      if (response.status === 401 && !path.includes("/auth/login")) {
        this.onUnauthorized?.();
      }
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new ApiError(response.status, error.error || "Unknown error");
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json();
  }

  // Auth
  async login(username: string, password: string) {
    return this.request<{ token: string; user: import("../types").User }>(
      "/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ username, password }),
      }
    );
  }

  async me() {
    return this.request<import("../types").User>("/auth/me");
  }

  // Machines
  async getMachines() {
    return this.request<import("../types").Machine[]>("/machines");
  }

  async getMachine(id: string) {
    return this.request<import("../types").Machine>(`/machines/${id}`);
  }

  async createMachine(name: string, type: "AGENT" | "PROBE" = "AGENT") {
    return this.request<import("../types").CreateMachineResponse>("/machines", {
      method: "POST",
      body: JSON.stringify({ name, type }),
    });
  }

  async updateMachine(id: string, fields: { name?: string; sshUser?: string | null }) {
    return this.request<{ id: string; name: string; sshUser: string | null; type: string }>(
      `/machines/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify(fields),
      }
    );
  }

  async deleteMachine(id: string) {
    return this.request<void>(`/machines/${id}`, { method: "DELETE" });
  }

  async regenerateBootstrap(id: string) {
    return this.request<import("../types").BootstrapArtifacts>(
      `/machines/${id}/bootstrap/regenerate`,
      { method: "POST" }
    );
  }

  async upgradeAgent(id: string) {
    return this.request<{ success: boolean; message: string; request_id?: string }>(
      `/machines/${id}/agent/upgrade`,
      { method: "POST" }
    );
  }

  // System control (reboot, services)
  async rebootMachine(id: string) {
    return this.request<{ success: boolean; request_id: string }>(
      `/machines/${id}/actions`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "system.reboot", params: {} }),
      }
    );
  }

  async listServices(id: string) {
    return this.request<{ success: boolean; data: { services: any[]; count: number } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: "system.services_list",
          params: {},
          timeout: 15000,
        }),
      }
    );
  }

  async serviceAction(id: string, service: string, action: "start" | "stop" | "restart" | "status") {
    return this.request<{ success: boolean; data: any }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: `system.service_${action}`,
          params: { service },
          timeout: 15000,
        }),
      }
    );
  }

  async getServiceLogs(id: string, service: string, lines = 100, since?: string) {
    const params: Record<string, unknown> = { service, lines };
    if (since) params.since = since;
    return this.request<{ success: boolean; data: { lines: string[]; count: number; truncated: boolean } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: "system.logs",
          params,
          timeout: 20000,
        }),
      }
    );
  }

  // Firewall
  async firewallStatus(id: string) {
    return this.request<{ success: boolean; data: { enabled: boolean; raw: string; pending: any[] } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "firewall.status", params: {}, timeout: 15000 }),
      }
    );
  }

  async firewallAllow(id: string, rule: string) {
    return this.request<{ success: boolean; data: { request_id: string; watchdog_expires_at: string } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "firewall.allow", params: { rule }, timeout: 20000 }),
      }
    );
  }

  async firewallDeny(id: string, rule: string) {
    return this.request<{ success: boolean; data: { request_id: string; watchdog_expires_at: string } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "firewall.deny", params: { rule }, timeout: 20000 }),
      }
    );
  }

  async firewallRuleRemove(id: string, number: number) {
    return this.request<{ success: boolean; data: { request_id: string; watchdog_expires_at: string } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "firewall.rule_remove", params: { number }, timeout: 20000 }),
      }
    );
  }

  async firewallEnable(id: string) {
    return this.request<{ success: boolean; data: { request_id: string; watchdog_expires_at: string } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "firewall.enable", params: {}, timeout: 20000 }),
      }
    );
  }

  async firewallDisable(id: string) {
    return this.request<{ success: boolean; data: { request_id: string; watchdog_expires_at: string } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "firewall.disable", params: {}, timeout: 20000 }),
      }
    );
  }

  async firewallConfirm(id: string, requestId: string) {
    return this.request<{ success: boolean; message: string }>(
      `/machines/${id}/firewall/confirm`,
      {
        method: "POST",
        body: JSON.stringify({ request_id: requestId }),
      }
    );
  }

  // Storage
  async storageLvmList(id: string) {
    return this.request<{
      success: boolean;
      data: { pvs: any[]; vgs: any[]; lvs: any[]; available: boolean };
    }>(`/machines/${id}/actions/sync`, {
      method: "POST",
      body: JSON.stringify({ action_id: "storage.lvm_list", params: {}, timeout: 15000 }),
    });
  }

  async storageBlockDevices(id: string) {
    return this.request<{ success: boolean; data: { devices: any[] } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "storage.block_devices", params: {}, timeout: 15000 }),
      }
    );
  }

  async storageFilesystemUsage(id: string) {
    return this.request<{ success: boolean; data: { filesystems: any[] } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "storage.filesystem_usage", params: {}, timeout: 15000 }),
      }
    );
  }

  // Scheduling (cron + timers)
  async cronList(id: string) {
    return this.request<{ success: boolean; data: { jobs: any[]; count: number } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "cron.list", params: {}, timeout: 15000 }),
      }
    );
  }

  async timerList(id: string) {
    return this.request<{ success: boolean; data: { timers: any[]; count: number } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "timer.list", params: {}, timeout: 15000 }),
      }
    );
  }

  async timerEnable(id: string, name: string) {
    return this.request<{ success: boolean; data: any }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "timer.enable", params: { name }, timeout: 15000 }),
      }
    );
  }

  async timerDisable(id: string, name: string) {
    return this.request<{ success: boolean; data: any }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "timer.disable", params: { name }, timeout: 15000 }),
      }
    );
  }

  // Users Linux
  async listUsers(id: string) {
    return this.request<{ success: boolean; data: { users: any[]; count: number } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "user.list", params: {}, timeout: 15000 }),
      }
    );
  }

  async createUser(id: string, username: string, opts: { gecos?: string; sudo?: boolean } = {}) {
    return this.request<{ success: boolean; data: any }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: "user.create",
          params: { username, gecos: opts.gecos, sudo: opts.sudo || false },
          timeout: 15000,
        }),
      }
    );
  }

  async deleteUser(id: string, username: string) {
    return this.request<{ success: boolean; data: any }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: "user.delete",
          params: { username },
          timeout: 15000,
        }),
      }
    );
  }

  async updateUserSudo(id: string, username: string, sudo: boolean) {
    return this.request<{ success: boolean; data: any }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: "user.update_sudo",
          params: { username, sudo },
          timeout: 15000,
        }),
      }
    );
  }

  async listSshKeys(id: string, username: string) {
    return this.request<{ success: boolean; data: { keys: any[]; count: number } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: "sshkey.list",
          params: { username },
          timeout: 15000,
        }),
      }
    );
  }

  async addSshKey(id: string, username: string, key: string) {
    return this.request<{ success: boolean; data: any }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: "sshkey.add",
          params: { username, key },
          timeout: 15000,
        }),
      }
    );
  }

  async removeSshKey(id: string, username: string, fingerprint: string) {
    return this.request<{ success: boolean; data: any }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: "sshkey.remove",
          params: { username, fingerprint },
          timeout: 15000,
        }),
      }
    );
  }

  // Network / netplan
  async networkStatus(id: string) {
    return this.request<{ success: boolean; data: { addresses: any[]; routes: any[]; pending: any[] } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "network.status", params: {}, timeout: 15000 }),
      }
    );
  }

  async networkInterfaces(id: string) {
    return this.request<{ success: boolean; data: { interfaces: any[] } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "network.interfaces", params: {}, timeout: 15000 }),
      }
    );
  }

  async netplanGet(id: string) {
    return this.request<{ success: boolean; data: { dir: string; files: any[]; target_file: string } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "netplan.get", params: {}, timeout: 15000 }),
      }
    );
  }

  async netplanApply(id: string, content: string) {
    return this.request<{ success: boolean; data: { request_id: string; watchdog_expires_at: string } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: "netplan.apply",
          params: { content },
          timeout: 30000,
        }),
      }
    );
  }

  async netplanConfirm(id: string, requestId: string) {
    return this.request<{ success: boolean; message: string }>(
      `/machines/${id}/netplan/confirm`,
      {
        method: "POST",
        body: JSON.stringify({ request_id: requestId }),
      }
    );
  }

  // Package holds (apt-mark)
  async packageHoldsList(id: string) {
    return this.request<{ success: boolean; data: { holds: string[]; count: number } }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "package.holds_list", params: {}, timeout: 15000 }),
      }
    );
  }

  async packageHold(id: string, name: string) {
    return this.request<{ success: boolean; data: any }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "package.hold", params: { name }, timeout: 15000 }),
      }
    );
  }

  async packageUnhold(id: string, name: string) {
    return this.request<{ success: boolean; data: any }>(
      `/machines/${id}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: "package.unhold", params: { name }, timeout: 15000 }),
      }
    );
  }

  // Packages catalog
  async searchPackages(q: string, suite = "noble", arch = "amd64", limit = 50) {
    const params = new URLSearchParams({ q, suite, arch, limit: String(limit) });
    return this.request<{ query: string; count: number; results: any[] }>(
      `/packages/search?${params}`
    );
  }

  async installPackage(machineId: string, name: string) {
    return this.request<{ success: boolean; data: any }>(
      `/machines/${machineId}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: "package.install",
          params: { packages: [name] },
          timeout: 120000,
        }),
      }
    );
  }

  async removePackage(machineId: string, name: string) {
    return this.request<{ success: boolean; data: any }>(
      `/machines/${machineId}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: "package.remove",
          params: { packages: [name] },
          timeout: 60000,
        }),
      }
    );
  }

  async revokeMachine(id: string, reason?: string) {
    return this.request<{ success: boolean }>(`/machines/${id}/revoke`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }

  async reEnrollMachine(id: string) {
    return this.request<{
      enrollmentToken: string;
      backendPublicKey: string;
      expiresAt: string;
    }>(`/machines/${id}/re-enroll`, { method: "POST" });
  }

  // Metrics
  async getMetrics(machineId: string, range: string = "1h") {
    return this.request<import("../types").MetricsResponse>(
      `/machines/${machineId}/metrics?range=${range}`
    );
  }

  async getLatestMetrics(machineId: string) {
    return this.request<import("../types").Metric>(
      `/machines/${machineId}/metrics/latest`
    );
  }

  // Actions
  async dispatchAction(
    machineId: string,
    actionId: string,
    params?: Record<string, unknown>
  ) {
    return this.request<{ success: boolean; request_id: string }>(
      `/machines/${machineId}/actions`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: actionId, params }),
      }
    );
  }

  // Action synchrone (attend la réponse de l'agent)
  async dispatchActionSync<T = any>(
    machineId: string,
    actionId: string,
    params?: Record<string, unknown>,
    timeout?: number
  ) {
    return this.request<{ success: boolean; data: T }>(
      `/machines/${machineId}/actions/sync`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: actionId, params, timeout }),
      }
    );
  }

  // Tags
  async getTags() {
    return this.request<import("../types").Tag[]>("/tags");
  }

  async createTag(name: string, color: string) {
    return this.request<import("../types").Tag>("/tags", {
      method: "POST",
      body: JSON.stringify({ name, color }),
    });
  }

  async updateTag(id: string, data: { name?: string; color?: string }) {
    return this.request<import("../types").Tag>(`/tags/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteTag(id: string) {
    return this.request<void>(`/tags/${id}`, { method: "DELETE" });
  }

  async assignTag(machineId: string, tagId: string) {
    return this.request<void>(`/machines/${machineId}/tags`, {
      method: "POST",
      body: JSON.stringify({ tagId }),
    });
  }

  async removeTag(machineId: string, tagId: string) {
    return this.request<void>(`/machines/${machineId}/tags/${tagId}`, {
      method: "DELETE",
    });
  }

  // Groups
  async getGroups() {
    return this.request<import("../types").MachineGroup[]>("/groups");
  }

  async createGroup(data: {
    name: string;
    description?: string;
    type: string;
    filter?: any;
  }) {
    return this.request<import("../types").MachineGroup>("/groups", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async deleteGroup(id: string) {
    return this.request<void>(`/groups/${id}`, { method: "DELETE" });
  }

  async getGroupMachines(id: string) {
    return this.request<import("../types").Machine[]>(
      `/groups/${id}/machines`
    );
  }

  // SSL scan
  async sslScan(id: string) {
    return this.request<{
      success: boolean;
      data: {
        certs: any[];
        count: number;
        min_days: number;
        expiring_soon: any[];
      };
    }>(`/machines/${id}/actions/sync`, {
      method: "POST",
      body: JSON.stringify({ action_id: "ssl.scan", params: {}, timeout: 30000 }),
    });
  }

  // Bulk dispatch
  async bulkDispatch(opts: {
    action_id: string;
    params?: Record<string, unknown>;
    machineIds?: string[];
    groupId?: string;
    mode?: "sync" | "fire";
    timeout?: number;
  }) {
    return this.request<{
      success: boolean;
      action_id: string;
      mode: string;
      summary: { total: number; success: number; failed: number; skipped: number };
      results: Array<{
        machineId: string;
        machineName: string;
        success: boolean;
        error?: string;
        data?: any;
        skipped?: boolean;
        async?: boolean;
      }>;
    }>("/bulk/dispatch", {
      method: "POST",
      body: JSON.stringify(opts),
    });
  }

  // Fleet
  async getFleetSummary() {
    return this.request<any>("/fleet/summary");
  }

  async getFleetTrends(range: string = "1h") {
    return this.request<{ buckets: any[] }>(`/fleet/trends?range=${range}`);
  }

  // Profiles
  async getProfiles() {
    return this.request<import("../types").Profile[]>("/profiles");
  }

  async getProfile(id: string) {
    return this.request<
      import("../types").Profile & {
        executions: import("../types").ProfileExecution[];
      }
    >(`/profiles/${id}`);
  }

  async createProfile(data: {
    name: string;
    type: string;
    description?: string;
    config: any;
    tagFilters?: string[];
  }) {
    return this.request<import("../types").Profile>("/profiles", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateProfile(id: string, data: Partial<import("../types").Profile>) {
    return this.request<import("../types").Profile>(`/profiles/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteProfile(id: string) {
    return this.request<void>(`/profiles/${id}`, { method: "DELETE" });
  }

  async executeProfile(id: string) {
    return this.request<{ executed: number }>(`/profiles/${id}/execute`, {
      method: "POST",
    });
  }

  async getProfileExecutions(id: string, page = 1) {
    return this.request<{
      executions: import("../types").ProfileExecution[];
      total: number;
    }>(`/profiles/${id}/executions?page=${page}&limit=20`);
  }

  // Settings
  async getSettings() {
    return this.request<import("../types").Setting[]>("/settings");
  }

  async updateSetting(key: string, value: any) {
    return this.request<import("../types").Setting>(`/settings/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const api = new ApiClient();
