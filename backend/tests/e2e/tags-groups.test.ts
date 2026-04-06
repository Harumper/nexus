import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const JWT_SECRET = "test-secret-for-e2e";

describe("Tags & Groups API - File Structure", () => {
  const backendDir = resolve(__dirname, "../../src");

  it("should have tags route file", () => {
    const path = resolve(backendDir, "routes/tags.ts");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("tagRoutes");
    expect(content).toContain('"/api/tags"');
    expect(content).toContain("requireAdmin");
    expect(content).toContain("prisma.tag");
  });

  it("should have groups route file", () => {
    const path = resolve(backendDir, "routes/groups.ts");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("groupRoutes");
    expect(content).toContain('"/api/groups"');
    expect(content).toContain("STATIC");
    expect(content).toContain("DYNAMIC");
  });

  it("should have settings route file", () => {
    const path = resolve(backendDir, "routes/settings.ts");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("settingsRoutes");
    expect(content).toContain('"/api/settings"');
    expect(content).toContain("upsert");
  });

  it("should have machine-lifecycle service", () => {
    const path = resolve(backendDir, "services/machine-lifecycle.ts");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("checkMachineLifecycle");
    expect(content).toContain("stale_after_days");
    expect(content).toContain("archive_after_days");
    expect(content).toContain("delete_after_days");
    expect(content).toContain("STALE");
    expect(content).toContain("ARCHIVED");
  });

  it("should register new routes in index.ts", () => {
    const path = resolve(backendDir, "index.ts");
    const content = readFileSync(path, "utf8");
    expect(content).toContain("tagRoutes");
    expect(content).toContain("groupRoutes");
    expect(content).toContain("settingsRoutes");
    expect(content).toContain("checkMachineLifecycle");
    expect(content).toContain("lifecycleInterval");
  });

  it("should include tags in machines route response", () => {
    const path = resolve(backendDir, "routes/machines.ts");
    const content = readFileSync(path, "utf8");
    expect(content).toContain("tags");
    expect(content).toContain("tag: true");
  });
});

describe("Tags API - Route Validation", () => {
  it("tags route should export async function", async () => {
    const tagsModule = await import("../../src/routes/tags.js");
    expect(typeof tagsModule.tagRoutes).toBe("function");
  });

  it("groups route should export async function", async () => {
    const groupsModule = await import("../../src/routes/groups.js");
    expect(typeof groupsModule.groupRoutes).toBe("function");
  });

  it("settings route should export async function", async () => {
    const settingsModule = await import("../../src/routes/settings.js");
    expect(typeof settingsModule.settingsRoutes).toBe("function");
  });

  it("lifecycle service should export checkMachineLifecycle function", async () => {
    const lifecycleModule = await import("../../src/services/machine-lifecycle.js");
    expect(typeof lifecycleModule.checkMachineLifecycle).toBe("function");
  });
});
