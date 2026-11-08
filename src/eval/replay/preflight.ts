/**
 * Preflight: contracts between the hooks, the prompt builder and the extraction schema that the replay
 * suite depends on. Each check reproduces one cross-module expectation with realistic inputs so a
 * failure names the module to fix instead of surfacing as a hundred failing scenario checks.
 */

import type { EpisodeDescriptor } from "../../core/episode-types";
import { EPISODE_SCHEMA } from "../../core/episode-types";
import type { PromptLine } from "../../core/ledger-types";
import { buildExtractionPrompt } from "../../dream/extract/prompt";
import { parseExtractionOutput } from "../../dream/extract/schema";
import { makeSeq } from "../../dream/ledger";

export interface PreflightCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/**
 * The hooks stamp `seq = Date.now() * 1000` (16 digits). The prompt must render event ids the extraction
 * schema accepts (`^e[0-9]{1,4}$`, i.e. `e1..eN` ordinals per plan §3 A3) or every real fact is rejected
 * as `schema` ("evidence_refs must contain at least one e<seq> reference").
 */
export function checkExtractionEventIds(nowMs: number = Date.now()): PreflightCheck {
  const seq = makeSeq(nowMs);
  const line: PromptLine = { kind: "prompt", ts: new Date(nowMs).toISOString(), seq, turn_key: "preflight", text: "Don't use npm test here; run pnpm test.", correction: 1, remember: 0, prompt_id: "preflight" };
  const descriptor: EpisodeDescriptor = {
    schema: EPISODE_SCHEMA,
    id: "preflight-episode",
    host: "claude-code",
    session_id: "preflight",
    session_key: "preflight",
    turn_key: "preflight",
    segment: 0,
    started_at: line.ts,
    closed_at: line.ts,
    close_reason: "stop",
    ledger_ref: "ledger/preflight.jsonl#0-1",
    correction_for: null,
    context_ref: null,
    scope_refs: [],
    tools: [],
    failure_signatures: [],
    flags: { correction: 1 },
    fired: [],
    evidence_weight: 2,
    event_count: 1,
    prompt_text: line.text,
    last_assistant_message: null,
  };
  const built = buildExtractionPrompt({ descriptor, lines: [line], existingMemories: [] });
  const ref = [...built.seqMap.keys()][0] ?? null;
  if (ref === null) return { id: "extraction_event_ids", ok: false, detail: "the prompt builder rendered no citable event" };
  const parsed = parseExtractionOutput({
    episode_summary: "preflight",
    nothing_to_learn: false,
    facts: [
      {
        action: "create",
        target_memory_id: null,
        type: "pitfall",
        summary: "Run the test suite with pnpm test instead of npm test in this repository.",
        details: "",
        scope_glob: "**/*",
        relevant_tools: ["bash"],
        trigger_signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "npm test" },
        lifecycle_triggers: ["before_tool"],
        confidence: 0.9,
        evidence_refs: [ref],
        knowledge_kind: "correction",
        rationale: "preflight",
        aliases: [],
      },
    ],
  });
  const accepted = parsed.ok && parsed.output.facts.length === 1;
  return {
    id: "extraction_event_ids",
    ok: accepted,
    detail: accepted
      ? `prompt event id ${ref} is accepted by the extraction schema`
      : `the prompt renders event ids like ${ref} (raw ledger seq) but the extraction schema / V1 only accept ^e[0-9]{1,4}$ — every real fact is rejected as schema; fix: src/dream/extract/prompt.ts must number rendered events e1..eN (seqMap keyed by the rendered id) and src/dream/reconcile.ts must take provenance event_seq from seqMap.get(ref).seq`,
  };
}

export function runPreflight(): PreflightCheck[] {
  return [checkExtractionEventIds()];
}
