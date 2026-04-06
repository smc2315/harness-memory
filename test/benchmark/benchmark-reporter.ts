/**
 * Benchmark reporter for per-layer diagnostic dashboards.
 *
 * Provides:
 * - BenchmarkLayerReport type for aggregating results by diagnostic layer
 * - formatLayerDashboard() for rendering consolidated tables
 * - printLayerDashboard() for console output
 * - Layer categorization (Retrieval, Extraction, Promotion, Safety, Product, Temporal, Scale)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LayerMetric {
  name: string;
  value: number;
  threshold?: number;
  aspirational?: boolean;
}

export interface BenchmarkLayerReport {
  layer: string;
  benchmark: string;
  metrics: LayerMetric[];
  status: "pass" | "fail" | "aspirational";
}

export interface DashboardConfig {
  title?: string;
  showAspirational?: boolean;
}

// ---------------------------------------------------------------------------
// Layer definitions
// ---------------------------------------------------------------------------

export const DIAGNOSTIC_LAYERS = {
  RETRIEVAL: "Retrieval",
  EXTRACTION: "Extraction",
  PROMOTION: "Promotion",
  SAFETY: "Safety",
  PRODUCT: "Product",
  TEMPORAL: "Temporal",
  SCALE: "Scale",
} as const;

export type DiagnosticLayer = (typeof DIAGNOSTIC_LAYERS)[keyof typeof DIAGNOSTIC_LAYERS];

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create a benchmark layer report.
 *
 * @param layer - Diagnostic layer name (e.g., "Retrieval", "Extraction")
 * @param benchmark - Benchmark name (e.g., "HM-Activation", "HM-Extract")
 * @param metrics - Array of LayerMetric objects
 * @param status - Pass/fail/aspirational status
 * @returns BenchmarkLayerReport
 */
export function createLayerReport(
  layer: string,
  benchmark: string,
  metrics: LayerMetric[],
  status: "pass" | "fail" | "aspirational",
): BenchmarkLayerReport {
  return {
    layer,
    benchmark,
    metrics,
    status,
  };
}

// ---------------------------------------------------------------------------
// Dashboard formatting
// ---------------------------------------------------------------------------

/**
 * Format benchmark layer reports as a consolidated table.
 *
 * Renders a box-drawing table with columns:
 * - Layer: Diagnostic layer name
 * - Benchmark: Benchmark name
 * - Metric: Individual metric name
 * - Value: Metric value (formatted to 4 decimals)
 * - Status: pass/fail/aspirational
 *
 * @param reports - Array of BenchmarkLayerReport objects
 * @param config - Optional dashboard configuration
 * @returns Formatted table string
 */
export function formatLayerDashboard(
  reports: BenchmarkLayerReport[],
  config?: DashboardConfig,
): string {
  const title = config?.title ?? "Benchmark Dashboard";
  const showAspirational = config?.showAspirational ?? true;

  // Filter reports based on aspirational flag
  const filteredReports = showAspirational
    ? reports
    : reports.filter((r) => r.status !== "aspirational");

  if (filteredReports.length === 0) {
    return `┌─────────────────────────────────────────────────────────────────┐\n│ ${title.padEnd(63)} │\n│ (no reports)                                                    │\n└─────────────────────────────────────────────────────────────────┘`;
  }

  // Flatten reports into rows (one row per metric)
  interface Row {
    layer: string;
    benchmark: string;
    metricName: string;
    value: string;
    status: string;
  }

  const rows: Row[] = [];

  for (const report of filteredReports) {
    for (const metric of report.metrics) {
      rows.push({
        layer: report.layer,
        benchmark: report.benchmark,
        metricName: metric.name,
        value: metric.value.toFixed(4),
        status: report.status,
      });
    }
  }

  // Calculate column widths
  const layerWidth = Math.max(5, ...rows.map((r) => r.layer.length));
  const benchmarkWidth = Math.max(9, ...rows.map((r) => r.benchmark.length));
  const metricWidth = Math.max(6, ...rows.map((r) => r.metricName.length));
  const valueWidth = Math.max(5, ...rows.map((r) => r.value.length));
  const statusWidth = Math.max(6, ...rows.map((r) => r.status.length));

  // Build table
  const lines: string[] = [];

  // Top border
  const topBorder = `┌${"─".repeat(layerWidth + 2)}┬${"─".repeat(benchmarkWidth + 2)}┬${"─".repeat(metricWidth + 2)}┬${"─".repeat(valueWidth + 2)}┬${"─".repeat(statusWidth + 2)}┐`;
  lines.push(topBorder);

  // Title row
  const titleRow = `│ ${title.padEnd(layerWidth + benchmarkWidth + metricWidth + valueWidth + statusWidth + 8)} │`;
  lines.push(titleRow);

  // Header separator
  const headerSep = `├${"─".repeat(layerWidth + 2)}┼${"─".repeat(benchmarkWidth + 2)}┼${"─".repeat(metricWidth + 2)}┼${"─".repeat(valueWidth + 2)}┼${"─".repeat(statusWidth + 2)}┤`;
  lines.push(headerSep);

  // Header row
  const headerRow = `│ ${`Layer`.padEnd(layerWidth)} │ ${`Benchmark`.padEnd(benchmarkWidth)} │ ${`Metric`.padEnd(metricWidth)} │ ${`Value`.padEnd(valueWidth)} │ ${`Status`.padEnd(statusWidth)} │`;
  lines.push(headerRow);

  // Data separator
  const dataSep = `├${"─".repeat(layerWidth + 2)}┼${"─".repeat(benchmarkWidth + 2)}┼${"─".repeat(metricWidth + 2)}┼${"─".repeat(valueWidth + 2)}┼${"─".repeat(statusWidth + 2)}┤`;
  lines.push(dataSep);

  // Data rows
  for (const row of rows) {
    const dataRow = `│ ${row.layer.padEnd(layerWidth)} │ ${row.benchmark.padEnd(benchmarkWidth)} │ ${row.metricName.padEnd(metricWidth)} │ ${row.value.padEnd(valueWidth)} │ ${row.status.padEnd(statusWidth)} │`;
    lines.push(dataRow);
  }

  // Bottom border
  const bottomBorder = `└${"─".repeat(layerWidth + 2)}┴${"─".repeat(benchmarkWidth + 2)}┴${"─".repeat(metricWidth + 2)}┴${"─".repeat(valueWidth + 2)}┴${"─".repeat(statusWidth + 2)}┘`;
  lines.push(bottomBorder);

  return lines.join("\n");
}

/**
 * Print benchmark layer reports to console.
 *
 * @param reports - Array of BenchmarkLayerReport objects
 * @param config - Optional dashboard configuration
 */
export function printLayerDashboard(
  reports: BenchmarkLayerReport[],
  config?: DashboardConfig,
): void {
  const formatted = formatLayerDashboard(reports, config);
  console.log(`\n${formatted}\n`);
}

// ---------------------------------------------------------------------------
// Layer categorization helpers
// ---------------------------------------------------------------------------

/**
 * Categorize a benchmark name into a diagnostic layer.
 *
 * @param benchmarkName - Name of the benchmark (e.g., "HM-Activation", "HM-Extract")
 * @returns DiagnosticLayer or undefined if not recognized
 */
export function categorizeBenchmark(benchmarkName: string): DiagnosticLayer | undefined {
  const upper = benchmarkName.toUpperCase();

  if (upper.includes("ACTIVATION") || upper.includes("CANARY")) {
    return DIAGNOSTIC_LAYERS.RETRIEVAL;
  }

  if (upper.includes("EXTRACT")) {
    return DIAGNOSTIC_LAYERS.EXTRACTION;
  }

  if (upper.includes("PROMOTION")) {
    return DIAGNOSTIC_LAYERS.PROMOTION;
  }

  if (upper.includes("SAFETY")) {
    return DIAGNOSTIC_LAYERS.SAFETY;
  }

  if (upper.includes("PRODUCT")) {
    return DIAGNOSTIC_LAYERS.PRODUCT;
  }

  if (upper.includes("TIMELINE") || upper.includes("TEMPORAL")) {
    return DIAGNOSTIC_LAYERS.TEMPORAL;
  }

  if (upper.includes("SCALE")) {
    return DIAGNOSTIC_LAYERS.SCALE;
  }

  return undefined;
}

/**
 * Determine status based on metrics and thresholds.
 *
 * @param metrics - Array of LayerMetric objects
 * @returns "pass" if all metrics meet thresholds, "aspirational" if any are aspirational, "fail" otherwise
 */
export function determineStatus(metrics: LayerMetric[]): "pass" | "fail" | "aspirational" {
  let hasAspirational = false;

  for (const metric of metrics) {
    if (metric.aspirational) {
      hasAspirational = true;
    } else if (metric.threshold !== undefined && metric.value < metric.threshold) {
      return "fail";
    }
  }

  return hasAspirational ? "aspirational" : "pass";
}
