/**
 * Replay provider (spec §5.4 "replay: recorded responses"): answers from `raw/<run_id>.json` or from
 * an injected map keyed by episode id / run id. Used by the write-path tests (§13.2) and `eval:replay`;
 * no process is spawned and the probe always succeeds.
 */

import { existsSync, readFileSync } from "node:fs";

import type { ExtractionOutput } from "../../../core/extraction-types";
import { rawFile, type HarnessPaths } from "../../../core/paths";
import type { ProbeResult } from "../../../core/vocabulary";
import type { ExtractOptions, ExtractionProvider, ProviderResult } from "./types";

export type ReplayAnswer = ExtractionOutput | string | ProviderResult;

export interface ReplayProviderOptions {
  /** Recorded answers by episode id (preferred) or run id. */
  answers?: ReadonlyMap<string, ReplayAnswer> | Record<string, ReplayAnswer>;
  /** Directory holding `<run_id>.json`; defaults to `options.paths.rawDir` at call time. */
  paths?: HarnessPaths;
  /** Status returned when no recording exists (default `no_provider`). */
  missingStatus?: Exclude<ProviderResult["status"], "ok">;
  /** Counts calls (tests assert the provider is not invoked for cached runs). */
  onExtract?: (options: ExtractOptions) => void;
}

function toResult(answer: ReplayAnswer): ProviderResult {
  if (typeof answer === "string") return { status: "ok", raw: answer, model: "replay" };
  if ("status" in answer && "raw" in answer) return answer;
  return { status: "ok", raw: JSON.stringify(answer), structured: answer, model: "replay" };
}

export function createReplayProvider(options: ReplayProviderOptions = {}): ExtractionProvider {
  const answers: Map<string, ReplayAnswer> =
    options.answers === undefined
      ? new Map()
      : options.answers instanceof Map
        ? new Map(options.answers)
        : new Map(Object.entries(options.answers as Record<string, ReplayAnswer>));

  return {
    name: "replay",
    probe(): Promise<ProbeResult> {
      return Promise.resolve("ok");
    },
    extract(_prompt: string, _schemaJson: string, extractOptions: ExtractOptions): Promise<ProviderResult> {
      options.onExtract?.(extractOptions);
      const byEpisode = extractOptions.episodeId === undefined ? undefined : answers.get(extractOptions.episodeId);
      if (byEpisode !== undefined) return Promise.resolve(toResult(byEpisode));
      const byRun = extractOptions.runId === undefined ? undefined : answers.get(extractOptions.runId);
      if (byRun !== undefined) return Promise.resolve(toResult(byRun));
      const paths = extractOptions.paths ?? options.paths;
      if (paths !== undefined && extractOptions.runId !== undefined) {
        const file = rawFile(paths, extractOptions.runId);
        if (existsSync(file)) {
          try {
            return Promise.resolve({ status: "ok", raw: readFileSync(file, "utf8"), model: "replay" });
          } catch (error) {
            return Promise.resolve({ status: "provider_error", raw: "", error: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
      }
      return Promise.resolve({
        status: options.missingStatus ?? "no_provider",
        raw: "",
        error: `no recorded answer for ${extractOptions.episodeId ?? extractOptions.runId ?? "unknown episode"}`,
      });
    },
  };
}
