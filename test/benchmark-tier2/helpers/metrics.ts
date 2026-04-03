import type { Tier2GroundTruthLabel } from "../fixtures/tier2.types";
import type { Tier2QueryRunResult } from "./query-runner";

export interface IrMetrics {
  precisionAt5: number;
  recallAt5: number;
  mrr: number;
  ndcgAt5: number;
}

export function scoreQueryRun(
  run: Tier2QueryRunResult,
  label: Tier2GroundTruthLabel,
): IrMetrics {
  const retrieved = run.activatedFixtureIds;
  const relevant = new Set(label.relevantMemoryIds);
  const top5 = retrieved.slice(0, 5);
  const hitsAt5 = top5.filter((memoryId) => relevant.has(memoryId)).length;

  const precisionAt5 = top5.length > 0 ? hitsAt5 / top5.length : 0;
  const recallAt5 = relevant.size > 0 ? hitsAt5 / relevant.size : 1;

  let mrr = 0;
  for (let index = 0; index < retrieved.length; index += 1) {
    if (relevant.has(retrieved[index])) {
      mrr = 1 / (index + 1);
      break;
    }
  }

  let dcg = 0;
  for (let index = 0; index < top5.length; index += 1) {
    const relevance = relevant.has(top5[index]) ? 1 : 0;
    dcg += relevance / Math.log2(index + 2);
  }

  let idcg = 0;
  for (let index = 0; index < Math.min(relevant.size, 5); index += 1) {
    idcg += 1 / Math.log2(index + 2);
  }

  const ndcgAt5 = idcg > 0 ? dcg / idcg : 0;

  return {
    precisionAt5,
    recallAt5,
    mrr,
    ndcgAt5,
  };
}

export function computeAggregateMetrics(
  runs: readonly Tier2QueryRunResult[],
  labels: ReadonlyMap<string, Tier2GroundTruthLabel>,
): {
  mean: IrMetrics;
  perQuery: Array<{ queryId: string } & IrMetrics>;
} {
  const perQuery: Array<{ queryId: string } & IrMetrics> = [];
  let totalPrecision = 0;
  let totalRecall = 0;
  let totalMrr = 0;
  let totalNdcg = 0;

  for (const run of runs) {
    const label = labels.get(run.queryId);
    if (label === undefined) {
      continue;
    }

    const metrics = scoreQueryRun(run, label);
    perQuery.push({
      queryId: run.queryId,
      ...metrics,
    });
    totalPrecision += metrics.precisionAt5;
    totalRecall += metrics.recallAt5;
    totalMrr += metrics.mrr;
    totalNdcg += metrics.ndcgAt5;
  }

  const count = perQuery.length;

  return {
    mean: {
      precisionAt5: count > 0 ? totalPrecision / count : 0,
      recallAt5: count > 0 ? totalRecall / count : 0,
      mrr: count > 0 ? totalMrr / count : 0,
      ndcgAt5: count > 0 ? totalNdcg / count : 0,
    },
    perQuery,
  };
}
