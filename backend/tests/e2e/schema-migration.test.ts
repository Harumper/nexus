import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const schemaPath = resolve(__dirname, "../../prisma/schema.prisma");
const schema = readFileSync(schemaPath, "utf8");

describe("Prisma Schema - Phase 2 Models", () => {
  describe("Tag model", () => {
    it("should have Tag model with required fields", () => {
      expect(schema).toContain("model Tag {");
      expect(schema).toContain('name      String       @unique');
      expect(schema).toContain('color     String');
      expect(schema).toContain("machines MachineTag[]");
    });
  });

  describe("MachineTag model", () => {
    it("should have MachineTag join table", () => {
      expect(schema).toContain("model MachineTag {");
      expect(schema).toContain("@@unique([machineId, tagId])");
      expect(schema).toContain("onDelete: Cascade");
    });
  });

  describe("MachineGroup model", () => {
    it("should have MachineGroup model", () => {
      expect(schema).toContain("model MachineGroup {");
      expect(schema).toContain("type        GroupType");
      expect(schema).toContain("filter      Json?");
      expect(schema).toContain("members MachineGroupMember[]");
    });
  });

  describe("MachineGroupMember model", () => {
    it("should have MachineGroupMember join table", () => {
      expect(schema).toContain("model MachineGroupMember {");
      expect(schema).toContain("@@unique([groupId, machineId])");
    });
  });

  describe("GroupType enum", () => {
    it("should have STATIC and DYNAMIC types", () => {
      expect(schema).toContain("enum GroupType {");
      expect(schema).toContain("STATIC");
      expect(schema).toContain("DYNAMIC");
    });
  });

  describe("Machine model updates", () => {
    it("should have new status values STALE and ARCHIVED", () => {
      expect(schema).toContain("STALE");
      expect(schema).toContain("ARCHIVED");
    });

    it("should have MachineType enum with AGENT and PROBE", () => {
      expect(schema).toContain("enum MachineType {");
      expect(schema).toContain("AGENT");
      expect(schema).toContain("PROBE");
    });

    it("should have rebootRequired field", () => {
      expect(schema).toContain("rebootRequired  Boolean");
    });

    it("should have archivedAt field", () => {
      expect(schema).toContain("archivedAt      DateTime?");
    });

    it("should have type field", () => {
      expect(schema).toContain("type            MachineType");
    });

    it("should have tags and groupMembers relations", () => {
      expect(schema).toMatch(/tags\s+MachineTag\[\]/);
      expect(schema).toMatch(/groupMembers\s+MachineGroupMember\[\]/);
    });

  });

  describe("Metric model updates", () => {
    it("should have processes Json field", () => {
      expect(schema).toContain("processes Json?");
    });
  });
});

describe("Frontend - Phase 2 Files", () => {
  const frontendDir = resolve(__dirname, "../../../frontend/src");

  it("should have Tags management card (integrated in Settings)", () => {
    // La page /tags dediee a ete supprimee : la gestion des tags est
    // maintenant integree dans Settings via TagsManagementCard.
    const content = readFileSync(resolve(frontendDir, "components/TagsManagementCard.tsx"), "utf8");
    expect(content).toContain("createTag");
    expect(content).toContain("deleteTag");
  });

  it("should have Tag type in types", () => {
    const content = readFileSync(resolve(frontendDir, "types/index.ts"), "utf8");
    expect(content).toContain("interface Tag");
    expect(content).toContain("interface MachineGroup");
    expect(content).toContain("interface Setting");
    expect(content).toContain("rebootRequired");
  });

  it("should have tag API methods", () => {
    const content = readFileSync(resolve(frontendDir, "services/api.ts"), "utf8");
    expect(content).toContain("getTags");
    expect(content).toContain("createTag");
    expect(content).toContain("assignTag");
    expect(content).toContain("getGroups");
    expect(content).toContain("getSettings");
  });

  it("should integrate Tags in Settings page (no dedicated /tags route)", () => {
    const settings = readFileSync(resolve(frontendDir, "pages/Settings.tsx"), "utf8");
    expect(settings).toContain("TagsManagementCard");
    // Plus de route /tags dans App.tsx
    const app = readFileSync(resolve(frontendDir, "App.tsx"), "utf8");
    expect(app).not.toMatch(/path="\/tags"/);
  });

  it("should display tags in MachineCard", () => {
    const content = readFileSync(resolve(frontendDir, "components/MachineCard.tsx"), "utf8");
    expect(content).toContain("tags");
    expect(content).toContain("tag.color");
  });
});
