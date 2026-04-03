import type { Tier2QueryFixture } from "../fixtures/tier2.types";
import type { Tier2SeededFixture } from "./fixture-seeder";

export interface Tier2QueryRunResult {
  queryId: string;
  activatedFixtureIds: string[];
  suppressedCount: number;
  usedPayloadBytes: number;
  usedMemories: number;
  maxMemories: number;
}

export async function runTier2Query(
  fixture: Tier2SeededFixture,
  query: Tier2QueryFixture,
): Promise<Tier2QueryRunResult> {
  const result = await fixture.engine.activate({
    lifecycleTrigger: query.lifecycleTrigger,
    scopeRef: query.scopeRef,
    queryTokens: [query.text],
    maxMemories: 10,
    maxPayloadBytes: 8192,
  });

  const activatedFixtureIds = result.activated
    .map((memory) => fixture.reverseIdMap.get(memory.id))
    .filter((fixtureId): fixtureId is string => fixtureId !== undefined);

  return {
    queryId: query.id,
    activatedFixtureIds,
    suppressedCount: result.suppressed.length,
    usedPayloadBytes: result.budget.usedPayloadBytes,
    usedMemories: result.budget.usedMemories,
    maxMemories: result.budget.maxMemories,
  };
}

export async function runAllTier2Queries(
  fixture: Tier2SeededFixture,
  queries: readonly Tier2QueryFixture[],
): Promise<Tier2QueryRunResult[]> {
  const results: Tier2QueryRunResult[] = [];

  for (const query of queries) {
    results.push(await runTier2Query(fixture, query));
  }

  return results;
}
