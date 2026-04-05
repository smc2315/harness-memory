/**
 * LongMemEval Evaluation Harness for harness-memory
 *
 * Scaffold implementation. Downloads data from HuggingFace,
 * ingests sessions into harness-memory, queries the activation
 * engine, and evaluates answers.
 *
 * Usage:
 *   npx tsx eval/longmemeval/harness.ts [--variant=oracle|s|m] [--limit=10]
 *
 * Data download:
 *   wget https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";

import type {
  LongMemEvalQuestion,
  EvalResult,
  EvalSummary,
  Capability,
  QuestionType,
} from "./types.js";
import { questionTypeToCapability } from "./types.js";

// ── Configuration ──

const DATA_DIR = resolve("data/longmemeval");
const RESULTS_DIR = resolve("eval/longmemeval/results");

const VARIANTS = {
  oracle: "longmemeval_oracle.json",
  s: "longmemeval_s_cleaned.json",
  m: "longmemeval_m_cleaned.json",
} as const;

type Variant = keyof typeof VARIANTS;

const DOWNLOAD_BASE = "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main";

// ── Data Loading ──

export function loadDataset(variant: Variant = "oracle"): LongMemEvalQuestion[] {
  const filename = VARIANTS[variant];
  const filepath = join(DATA_DIR, filename);

  if (!existsSync(filepath)) {
    console.error(`Dataset not found: ${filepath}`);
    console.error(`Download with:`);
    console.error(`  mkdir -p ${DATA_DIR}`);
    console.error(`  wget ${DOWNLOAD_BASE}/${filename} -O ${filepath}`);
    throw new Error(`Dataset file not found: ${filepath}`);
  }

  const raw = readFileSync(filepath, "utf-8");
  const data: LongMemEvalQuestion[] = JSON.parse(raw);

  console.log(`Loaded ${data.length} questions from ${variant} variant`);
  return data;
}

// ── Question Classification ──

export function isAbstentionQuestion(q: LongMemEvalQuestion): boolean {
  return q.question_id.endsWith("_abs");
}

export function getCapability(q: LongMemEvalQuestion): Capability {
  return questionTypeToCapability(q.question_type, isAbstentionQuestion(q));
}

// ── Ingestion (placeholder) ──

export async function ingestSessions(
  _question: LongMemEvalQuestion,
): Promise<{ memoryCount: number; dbPath: string }> {
  // TODO: Phase 2 implementation
  // 1. Create temp DB
  // 2. For each session in haystack_sessions:
  //    - Convert ChatMessage[] to conversation text
  //    - Ingest as memories via MemoryRepository + EmbeddingService
  // 3. Return memory count and DB path
  throw new Error("Not implemented — Phase 2: ingest LongMemEval sessions into harness-memory");
}

// ── Retrieval + Answer Generation (placeholder) ──

export async function generateAnswer(
  _question: LongMemEvalQuestion,
  _dbPath: string,
): Promise<{ answer: string; retrievedSessionIds: string[] }> {
  // TODO: Phase 2 implementation
  // 1. Activate memories using question text as query
  // 2. Build context from activated memories
  // 3. Generate answer via LLM (opencode run)
  // 4. Track which sessions' memories were retrieved
  throw new Error("Not implemented — Phase 2: generate answers using harness-memory activation");
}

// ── LLM-as-Judge Evaluation (placeholder) ──

export async function judgeAnswer(
  _question: LongMemEvalQuestion,
  _hypothesis: string,
): Promise<"correct" | "incorrect" | "error"> {
  // TODO: Phase 2 implementation
  // Use type-specific grading prompts from LongMemEval:
  // - Default: contains correct answer?
  // - Temporal: off-by-one leniency
  // - Knowledge update: accepts previous info if updated answer present
  // - Preference: doesn't need all rubric points
  // - Abstention: correctly identifies as unanswerable?
  throw new Error("Not implemented — Phase 2: LLM-as-judge evaluation");
}

// ── Metrics Computation ──

export function computeSummary(results: EvalResult[]): EvalSummary {
  const correct = results.filter((r) => r.judgment === "correct").length;
  const total = results.length;

  const byCapability: EvalSummary["by_capability"] = {} as EvalSummary["by_capability"];
  const byType: EvalSummary["by_question_type"] = {} as EvalSummary["by_question_type"];

  const capabilities: Capability[] = [
    "information_extraction", "multi_session_reasoning",
    "temporal_reasoning", "knowledge_updates", "abstention",
  ];

  for (const cap of capabilities) {
    const capResults = results.filter((r) => r.capability === cap);
    byCapability[cap] = {
      total: capResults.length,
      correct: capResults.filter((r) => r.judgment === "correct").length,
      accuracy: capResults.length > 0
        ? capResults.filter((r) => r.judgment === "correct").length / capResults.length
        : 0,
    };
  }

  const questionTypes: QuestionType[] = [
    "single-session-user", "single-session-assistant", "single-session-preference",
    "temporal-reasoning", "knowledge-update", "multi-session",
  ];

  for (const qt of questionTypes) {
    const qtResults = results.filter((r) => r.question_type === qt);
    byType[qt] = {
      total: qtResults.length,
      correct: qtResults.filter((r) => r.judgment === "correct").length,
      accuracy: qtResults.length > 0
        ? qtResults.filter((r) => r.judgment === "correct").length / qtResults.length
        : 0,
    };
  }

  const abstentionResults = results.filter((r) => r.is_abstention);
  const abstentionCorrect = abstentionResults.filter((r) => r.judgment === "correct").length;

  return {
    total,
    correct,
    accuracy: total > 0 ? correct / total : 0,
    by_capability: byCapability,
    by_question_type: byType,
    abstention_accuracy: abstentionResults.length > 0
      ? abstentionCorrect / abstentionResults.length
      : 0,
  };
}

// ── Report ──

export function printReport(summary: EvalSummary): void {
  console.log("\n" + "=".repeat(60));
  console.log("LongMemEval Results for harness-memory");
  console.log("=".repeat(60));
  console.log(`Overall: ${summary.correct}/${summary.total} = ${(summary.accuracy * 100).toFixed(1)}%`);
  console.log(`Abstention: ${(summary.abstention_accuracy * 100).toFixed(1)}%`);
  console.log("\nBy Capability:");
  for (const [cap, stats] of Object.entries(summary.by_capability)) {
    if (stats.total > 0) {
      console.log(`  ${cap}: ${stats.correct}/${stats.total} = ${(stats.accuracy * 100).toFixed(1)}%`);
    }
  }
  console.log("\nBy Question Type:");
  for (const [qt, stats] of Object.entries(summary.by_question_type)) {
    if (stats.total > 0) {
      console.log(`  ${qt}: ${stats.correct}/${stats.total} = ${(stats.accuracy * 100).toFixed(1)}%`);
    }
  }

  console.log("\nComparison (external benchmarks):");
  console.log("  Mastra:     95.0% (LongMemEval, July 2025)");
  console.log("  Zep:        71.2% (LongMemEval, 2024)");
  console.log("  GPT-4o:     ~58%  (LongMemEval baseline)");
}
