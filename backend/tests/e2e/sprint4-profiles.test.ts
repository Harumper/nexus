import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const backendSrc = resolve(__dirname, "../../src");
const frontendSrc = resolve(__dirname, "../../../frontend/src");

describe("Phase 5 — Profile Routes", () => {
  it("should have profiles route with CRUD endpoints", () => {
    const content = readFileSync(resolve(backendSrc, "routes/profiles.ts"), "utf8");
    expect(content).toContain("profileRoutes");
    expect(content).toContain('"/api/profiles"');
    expect(content).toContain("requireAdmin");
    expect(content).toContain("execute");
    expect(content).toContain("executions");
  });

  it("should export profileRoutes function", async () => {
    const mod = await import("../../src/routes/profiles.js");
    expect(typeof mod.profileRoutes).toBe("function");
  });

  it("should be registered in index.ts", () => {
    const content = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(content).toContain("profileRoutes");
    expect(content).toContain("initProfileScheduler");
  });
});

describe("Phase 5 — Profile Engine", () => {
  it("should have profile-engine with resolve and execute functions", () => {
    const content = readFileSync(resolve(backendSrc, "services/profile-engine.ts"), "utf8");
    expect(content).toContain("resolveProfileMachines");
    expect(content).toContain("executeProfile");
    expect(content).toContain("initProfileScheduler");
    expect(content).toContain("tagFilters");
    expect(content).toContain("ONLINE");
  });

  it("should handle all profile types", () => {
    const content = readFileSync(resolve(backendSrc, "services/profile-engine.ts"), "utf8");
    expect(content).toContain("UPGRADE");
    expect(content).toContain("SCRIPT");
    expect(content).toContain("PACKAGE");
    expect(content).toContain("REBOOT");
  });

  it("should support staggered delivery", () => {
    const content = readFileSync(resolve(backendSrc, "services/profile-engine.ts"), "utf8");
    expect(content).toMatch(/delivery|stagger|random|delay/i);
  });

  it("should have action dispatcher service", () => {
    const path = resolve(backendSrc, "services/action-dispatcher.ts");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("dispatchAction");
  });

  it("should export functions", async () => {
    const mod = await import("../../src/services/profile-engine.js");
    expect(typeof mod.resolveProfileMachines).toBe("function");
    expect(typeof mod.executeProfile).toBe("function");
    expect(typeof mod.initProfileScheduler).toBe("function");
  });
});

describe("Phase 5 — Frontend Profiles", () => {
  it("should have Profile types", () => {
    const content = readFileSync(resolve(frontendSrc, "types/index.ts"), "utf8");
    expect(content).toContain("interface Profile");
    expect(content).toContain("interface ProfileExecution");
    expect(content).toContain("UPGRADE");
    expect(content).toContain("PACKAGE");
  });

  it("should have profile API methods", () => {
    const content = readFileSync(resolve(frontendSrc, "services/api.ts"), "utf8");
    expect(content).toContain("getProfiles");
    expect(content).toContain("createProfile");
    expect(content).toContain("executeProfile");
    expect(content).toContain("getProfileExecutions");
  });

  it("should have Profiles page", () => {
    const path = resolve(frontendSrc, "pages/Profiles.tsx");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("UPGRADE");
    expect(content).toContain("REBOOT");
    expect(content).toContain("SCRIPT");
    expect(content).toContain("PACKAGE");
    expect(content).toContain("tagFilters");
    expect(content).toContain("executeProfile");
  });

  it("should have Profiles route in App", () => {
    const content = readFileSync(resolve(frontendSrc, "App.tsx"), "utf8");
    expect(content).toContain("/profiles");
    expect(content).toContain("Profiles");
  });

  it("should have Profiles nav item in Layout", () => {
    const content = readFileSync(resolve(frontendSrc, "components/Layout.tsx"), "utf8");
    expect(content).toContain("/profiles");
    expect(content).toContain("Profil");
  });
});
