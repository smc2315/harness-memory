import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { prepareAdapterHarnessDb } from "../src/adapters/test-harness";

describe("OpenCodeAdapter", () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const { createTestDb } = await import("./helpers/create-test-db");
    db = await createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test("initializes session metadata and default scope", () => {
    const { adapter, fixtures } = prepareAdapterHarnessDb(db);

    const session = adapter.initializeSession({
      sessionID: fixtures.sessionID,
      agent: "adapter-test",
      messageID: "message-001",
      variant: "local-harness",
    });

    expect(session.sessionID).toBe(fixtures.sessionID);
    expect(session.lastScopeRef).toBe(fixtures.scopeRef);
    expect(session.metadata).toEqual({
      agent: "adapter-test",
      messageID: "message-001",
      variant: "local-harness",
    });
    expect(session.lastBeforeModel).toBeNull();
    expect(adapter.getSession(fixtures.sessionID)).toBe(session);
  });

  test("injects bounded memory into before-model system text", () => {
    const { adapter, fixtures } = prepareAdapterHarnessDb(db);

    adapter.initializeSession({
      sessionID: fixtures.sessionID,
      agent: "adapter-test",
    });

    const result = adapter.beforeModel({
      sessionID: fixtures.sessionID,
      model: fixtures.model,
      scopeRef: fixtures.scopeRef,
      maxMemories: fixtures.beforeModelBudget.maxMemories,
      maxPayloadBytes: fixtures.beforeModelBudget.maxPayloadBytes,
    });

    expect(result.system).toHaveLength(1);
    expect(result.advisoryText).toContain("## Active Memories");
    expect(result.advisoryText).toContain("[POLICY]");
    expect(result.activation.activated.map((memory) => memory.id)).toEqual([
      fixtures.memoryIds.injected,
    ]);
    expect(result.activation.suppressed.map((entry) => entry.memory.id)).toContain(
      fixtures.memoryIds.suppressed
    );
    expect(result.activation.budget.usedMemories).toBe(1);
    expect(result.session?.lastBeforeModel?.scopeRef).toBe(fixtures.scopeRef);
  });

  test("returns before-tool warnings and records the policy check", () => {
    const { adapter, fixtures } = prepareAdapterHarnessDb(db);

    adapter.initializeSession({
      sessionID: fixtures.sessionID,
      agent: "adapter-test",
    });

    const result = adapter.beforeTool({
      sessionID: fixtures.sessionID,
      tool: fixtures.toolName,
      callID: fixtures.callID,
      scopeRef: fixtures.scopeRef,
    });

    expect(result.blocked).toBe(false);
    expect(result.warnings.map((warning) => warning.ruleCode)).toEqual([
      fixtures.ruleCode,
    ]);
    expect(result.warningText).toContain("## Tool Warnings");
    expect(result.session.toolPolicyChecks).toHaveLength(1);
    expect(result.session.toolPolicyChecks[0]?.callID).toBe(fixtures.callID);
  });

  test("captures after-tool evidence through the adapter", () => {
    const { adapter, dreamRepository, memoryRepository, fixtures } = prepareAdapterHarnessDb(db);

    adapter.initializeSession({
      sessionID: fixtures.sessionID,
      agent: "adapter-test",
    });

    const result = adapter.afterTool(
      {
        sessionID: fixtures.sessionID,
        tool: fixtures.toolName,
        callID: fixtures.callID,
        scopeRef: fixtures.scopeRef,
        args: fixtures.toolArgs,
      },
      fixtures.toolOutput
    );

    expect(result.relatedMemoryIds).toEqual([fixtures.memoryIds.evidence]);
    expect(result.createdEvidence).toHaveLength(1);
    expect(result.excerpt).toContain(`tool=${fixtures.toolName}`);
    expect(result.excerpt).toContain(`callID=${fixtures.callID}`);

    expect(
      memoryRepository.listEvidence(fixtures.memoryIds.evidence).map((evidence) => ({
        memoryId: evidence.memoryId,
        sourceKind: evidence.sourceKind,
        sourceRef: evidence.sourceRef,
        excerpt: evidence.excerpt,
      }))
    ).toEqual([
      {
        memoryId: fixtures.memoryIds.evidence,
        sourceKind: "session",
        sourceRef: fixtures.sourceRef,
        excerpt: result.excerpt,
      },
    ]);
    expect(dreamRepository.listEvidenceEvents({ status: "pending" })).toHaveLength(1);
    expect(adapter.getSession(fixtures.sessionID)?.toolEvidence).toHaveLength(1);
  });
});
