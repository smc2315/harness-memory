export interface TierComparisonRow {
  metric: string;
  tier1: number | string;
  tier2: number | string;
  deltaPercent?: number;
  optimistic?: boolean;
}

function formatValue(value: number | string): string {
  return typeof value === "number" ? value.toFixed(4) : value;
}

export function computeDeltaPercent(tier1: number, tier2: number): number {
  if (tier1 === 0) {
    return tier2 === 0 ? 0 : 100;
  }

  return ((tier2 - tier1) / tier1) * 100;
}

export function isTier1Optimistic(tier1: number, tier2: number): boolean {
  return tier1 > tier2 * 1.2;
}

export function printTier2Report(title: string, rows: readonly TierComparisonRow[]): void {
  const metricWidth = Math.max(6, ...rows.map((row) => row.metric.length));
  const tier1Width = Math.max(8, ...rows.map((row) => formatValue(row.tier1).length));
  const tier2Width = Math.max(8, ...rows.map((row) => formatValue(row.tier2).length));
  const deltaWidth = Math.max(
    8,
    ...rows.map((row) => {
      if (row.deltaPercent === undefined) {
        return 3;
      }

      return `${row.deltaPercent >= 0 ? "+" : ""}${row.deltaPercent.toFixed(1)}%`.length;
    }),
  );
  const flagWidth = Math.max(4, ...rows.map((row) => (row.optimistic ? "OPTIMISTIC" : "").length));
  const header = [
    "Metric".padEnd(metricWidth),
    "Tier1".padStart(tier1Width),
    "Tier2".padStart(tier2Width),
    "Delta%".padStart(deltaWidth),
    "Flag".padEnd(flagWidth),
  ].join("  ");
  const width = Math.max(title.length, header.length);
  const border = "-".repeat(width + 4);

  console.log(`\n+${border}+`);
  console.log(`| ${title.padEnd(width + 2)} |`);
  console.log(`+${border}+`);
  console.log(`| ${header.padEnd(width + 2)} |`);
  console.log(`+${border}+`);

  for (const row of rows) {
    const delta =
      row.deltaPercent === undefined
        ? "N/A"
        : `${row.deltaPercent >= 0 ? "+" : ""}${row.deltaPercent.toFixed(1)}%`;
    const line = [
      row.metric.padEnd(metricWidth),
      formatValue(row.tier1).padStart(tier1Width),
      formatValue(row.tier2).padStart(tier2Width),
      delta.padStart(deltaWidth),
      (row.optimistic ? "OPTIMISTIC" : "").padEnd(flagWidth),
    ].join("  ");

    console.log(`| ${line.padEnd(width + 2)} |`);
  }

  console.log(`+${border}+\n`);
}

export function printSimpleReport(title: string, metrics: Record<string, number | string>): void {
  const keys = Object.keys(metrics);
  const keyWidth = Math.max(...keys.map((key) => key.length));
  const lines = keys.map((key) => {
    const value = metrics[key];
    return `${key.padEnd(keyWidth)}  ${formatValue(value)}`;
  });
  const width = Math.max(title.length, ...lines.map((line) => line.length));
  const border = "-".repeat(width + 4);

  console.log(`\n+${border}+`);
  console.log(`| ${title.padEnd(width + 2)} |`);
  console.log(`+${border}+`);
  for (const line of lines) {
    console.log(`| ${line.padEnd(width + 2)} |`);
  }
  console.log(`+${border}+\n`);
}
