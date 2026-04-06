import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

export class FileLogger {
  private readonly logPath: string;

  constructor(dbDir: string) {
    this.logPath = join(dbDir, "harness-memory.log");
    const dir = dirname(this.logPath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private normalize(value: string, maxChars: number): string {
    return value.trim().replace(/\s+/g, " ").slice(0, maxChars);
  }

  private write(line: string): void {
    try {
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
      const safeLine = line.replace(/\s+/g, " ").trim();
      appendFileSync(this.logPath, `[${timestamp}] ${safeLine}\n`, "utf-8");
    } catch {
      // Non-critical: file audit logging never blocks primary behavior.
    }
  }

  logActivation(opts: {
    mode: string;
    queryType: string;
    query?: string;
    toolName?: string;
    scopeRef: string;
    activatedCount: number;
    activatedSummaries: string[];
    suppressedCount: number;
    budgetUsedBytes: number;
    budgetMaxBytes: number;
    summariesUsed?: number;
  }): void {
    const queryPart =
      opts.query !== undefined && opts.query.trim().length > 0
        ? `query="${this.normalize(opts.query, 60)}"`
        : `tool=${this.normalize(opts.toolName ?? "unknown", 40)}`;
    const memPart = opts.activatedSummaries
      .slice(0, 5)
      .map((summary) => this.normalize(summary, 40))
      .join(", ");
    const summaryPart =
      opts.summariesUsed !== undefined && opts.summariesUsed > 0
        ? ` summaries_used=${opts.summariesUsed}`
        : "";

    this.write(
      `activation mode=${this.normalize(opts.mode, 20)} ` +
        `query_type=${this.normalize(opts.queryType, 24)} ` +
        `${queryPart} scope=${this.normalize(opts.scopeRef, 40)} ` +
        `activated=${opts.activatedCount} [${memPart}] ` +
        `suppressed=${opts.suppressedCount} budget=${opts.budgetUsedBytes}/${opts.budgetMaxBytes}B` +
        summaryPart,
    );
  }

  logDream(opts: {
    trigger: string;
    create: number;
    reinforce: number;
    supersede: number;
    stale: number;
    latent: number;
    skip: number;
    materialized: number;
  }): void {
    this.write(
      `dream trigger=${this.normalize(opts.trigger, 24)} ` +
        `create=${opts.create} reinforce=${opts.reinforce} supersede=${opts.supersede} ` +
        `stale=${opts.stale} latent=${opts.latent} skip=${opts.skip} materialized=${opts.materialized}`,
    );
  }

  logSummary(opts: {
    sessionId: string;
    eventCount: number;
    toolCount: number;
    generated: boolean;
    skipReason?: string;
  }): void {
    if (opts.generated) {
      this.write(
        `summary generated session=${this.normalize(opts.sessionId, 16)} ` +
          `events=${opts.eventCount} tools=${opts.toolCount}`,
      );
      return;
    }

    this.write(
      `summary skipped session=${this.normalize(opts.sessionId, 16)} ` +
        `reason=${this.normalize(opts.skipReason ?? "unknown", 40)}`,
    );
  }

  logPromotion(opts: {
    promoted: number;
    expired: number;
    skipped: number;
  }): void {
    if (opts.promoted > 0 || opts.expired > 0) {
      this.write(
        `promotion promoted=${opts.promoted} expired=${opts.expired} skipped=${opts.skipped}`,
      );
    }
  }

  getLogPath(): string {
    return this.logPath;
  }
}
