import { describe, expect, it } from "vitest";

import {
  FEISHU_FIELD_TYPE_BY_KIND,
  V5_HUB_SCHEMA_VERSION,
  V5_HUB_TABLES,
  FEISHU_HUB_FIELD_BINDING_MODE,
  mapHubFieldsToFeishuDisplayNames,
  validateV5HubSchema,
  validateV5HubRemoteSchema,
} from "./v5HubSchema";

describe("V5 Feishu Intelligence Hub schema contract", () => {
  it("declares six uniquely identified logical tables with valid key fields", () => {
    expect(V5_HUB_TABLES.map(({ id }) => id)).toEqual(["T01", "T02", "T03", "T04", "T05", "T06"]);
    expect(validateV5HubSchema()).toEqual([]);
  });

  it("keeps packet, fact, and evidence hashes independent in the packet contract", () => {
    const packet = V5_HUB_TABLES.find(({ id }) => id === "T02");
    const hashes = packet?.fields
      .filter(({ name }) => ["packetHash", "factHash", "evidenceHash"].includes(name))
      .map(({ name }) => name);
    expect(hashes).toEqual(["factHash", "evidenceHash", "packetHash"]);
    expect(new Set(hashes).size).toBe(3);
    expect(packet?.logicalUniqueKey).toEqual(["packetHash"]);
  });

  it("keeps English machine keys stable while exposing unique Chinese table and field labels", () => {
    expect(V5_HUB_TABLES.map(({ displayName }) => displayName)).toEqual([
      "T01 商品主表",
      "T02 研究数据包",
      "T03 买家声音",
      "T04 关键词情报",
      "T05 产品概念",
      "T06 监控事件",
    ]);
    for (const table of V5_HUB_TABLES) {
      expect(/[\u4e00-\u9fff]/.test(table.displayName)).toBe(true);
      expect(new Set(table.fields.map(({ displayName }) => displayName)).size).toBe(table.fields.length);
      expect(table.fields.every(({ name, displayName }) =>
        name !== displayName && displayName.trim().length > 0 && (/[\u4e00-\u9fff]/.test(displayName) || displayName === "ASIN"),
      )).toBe(true);
    }
    expect(mapHubFieldsToFeishuDisplayNames("T02", {
      subjectKey: "subject-1",
      asin: "B000000000",
      packetHash: "sha256:example",
    })).toEqual({
      主体键: "subject-1",
      ASIN: "B000000000",
      研究包哈希: "sha256:example",
    });
    expect(() => mapHubFieldsToFeishuDisplayNames("T02", { unknownMachineKey: 1 })).toThrow(
      "T02: field is not in schema contract: unknownMachineKey",
    );
    expect(mapHubFieldsToFeishuDisplayNames("T05", { humanDecision: "APPROVE", expectedPacketHash: "hash" }))
      .toEqual({ "人工决策状态": "APPROVE", "预期研究包哈希": "hash" });
  });

  it("binds remote records by localized field name, not mutable field ID", () => {
    const table = V5_HUB_TABLES.find(({ id }) => id === "T02");
    const remoteFields = [
      { fieldId: "primary", fieldName: "记录名称", type: 1, uiType: "Text", isPrimary: true },
      ...(table?.fields ?? []).map((field, index) => ({
        fieldId: `remote-${index}`,
        fieldName: field.displayName,
        type: FEISHU_FIELD_TYPE_BY_KIND[field.kind],
        uiType: field.kind,
      })),
    ];

    expect(FEISHU_HUB_FIELD_BINDING_MODE).toBe("FIELD_NAME");
    expect(validateV5HubRemoteSchema("T02", remoteFields).isValid).toBe(true);

    const changedIds = remoteFields.map((field) => ({ ...field, fieldId: `new-${field.fieldId}` }));
    expect(validateV5HubRemoteSchema("T02", changedIds).isValid).toBe(true);
    const duplicated = [...remoteFields, remoteFields[1]];
    expect(validateV5HubRemoteSchema("T02", duplicated).duplicateFields).toContain("结构版本");
    expect(validateV5HubRemoteSchema("T02", duplicated).isValid).toBe(false);

    const renamed = remoteFields.map((field) =>
      field.fieldName === "研究包哈希" ? { ...field, fieldName: "报告哈希" } : field,
    );
    const renamedResult = validateV5HubRemoteSchema("T02", renamed);
    expect(renamedResult.isValid).toBe(false);
    expect(renamedResult.missingFields).toContain("研究包哈希");
    expect(renamedResult.unexpectedFields).toContain("报告哈希");

    const mistyped = remoteFields.map((field) =>
      field.fieldName === "研究包哈希" ? { ...field, type: 2 } : field,
    );
    expect(validateV5HubRemoteSchema("T02", mistyped).incompatibleFields).toEqual([
      { fieldName: "研究包哈希", expectedType: 1, actualType: 2 },
    ]);
  });

  it("stores structured JSON as text and limits writable T05 fields to the CAS decision allowlist", () => {
    expect(V5_HUB_SCHEMA_VERSION).toBe("v5-feishu-hub.v1");
    expect(FEISHU_FIELD_TYPE_BY_KIND.json).toBe(FEISHU_FIELD_TYPE_BY_KIND.text);
    const concept = V5_HUB_TABLES.find(({ id }) => id === "T05");
    // P1-HUB-03：personalReview（个人复盘）= 飞书端可写的备注字段，回读仅作 advisory 文本，不改决策
    expect(concept?.fields.filter(({ writableBy }) => writableBy === "decision-pull").map(({ name }) => name))
      .toEqual(["decision", "decisionNotes", "personalReview", "reviewerIdentity", "reviewedAt"]);
    expect(concept?.fields.find(({ name }) => name === "expectedPacketHash")?.writableBy).toBe("projection-seed");
    expect(concept?.fields.find(({ name }) => name === "humanDecision")?.writableBy).toBe("projection");
    expect(concept?.fields.find(({ name }) => name === "factHash")?.writableBy).toBe("projection");
  });

  it("P1-HUB-02/03: personal dashboard fields exist with Chinese labels and no team-model fields anywhere", () => {
    const master = V5_HUB_TABLES.find(({ id }) => id === "T01");
    expect(master?.fields.find(({ name }) => name === "nextAction")).toMatchObject({ displayName: "下一步动作", kind: "text" });
    const concept = V5_HUB_TABLES.find(({ id }) => id === "T05");
    expect(concept?.fields.find(({ name }) => name === "personalReview")).toMatchObject({ displayName: "个人复盘" });
    // 禁止清单（硬约束）：负责人/权限/成员/审批/任务分配/角色字段不得存在
    const banned = ["assignee", "owner", "负责人", "审批", "approver", "approval", "member", "成员", "permission", "权限", "role", "角色", "taskAssignment"];
    for (const table of V5_HUB_TABLES) {
      for (const field of table.fields) {
        expect(banned.some((word) => field.name.toLowerCase().includes(word))).toBe(false);
      }
    }
  });
});
