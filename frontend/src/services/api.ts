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

  async createMachine(name: string, capabilities: string[] = ["monitoring"]) {
    return this.request<import("../types").CreateMachineResponse>("/machines", {
      method: "POST",
      body: JSON.stringify({ name, capabilities }),
    });
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

  // Capabilities
  async getCapabilities() {
    return this.request<import("../types").Capability[]>("/capabilities");
  }

  async assignCapability(machineId: string, capabilityName: string) {
    return this.request<{ success: boolean }>(
      `/machines/${machineId}/capabilities`,
      {
        method: "POST",
        body: JSON.stringify({ capability_name: capabilityName }),
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
