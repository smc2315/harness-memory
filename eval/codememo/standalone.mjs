#!/usr/bin/env node

/**
 * CodeMemo Benchmark — standalone runner (v2).
 *
 * Improvements over v1:
 * - Hybrid retrieval (dense + BM25 + RRF fusion)
 * - Question router (temporal / cross_session / default)
 * - Session-aware retrieval with diversity enforcement
 * - User+assistant pair ingest (reduced noise)
 * - Category-specific answer prompts
 *
 * Usage: node eval/codememo/standalone.mjs [--project=project_03_memory_system]
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { execFileSync } from "child_process";

// Use the full exe path to bypass shell escaping entirely
const OPENCODE_EXE = "C:\\Users\\choey\\.opencode\\bin\\opencode.exe";

const CATEGORY_NAMES = { 1: "Factual", 2: "Debug", 3: "Architecture", 4: "Temporal", 5: "Convention", 6: "Cross-Session" };

// ────────── Question Router ──────────

// Cross-session is higher specificity — check FIRST
const CROSS_SESSION_PATTERNS = /\b(across sessions?|evolve[ds]? across|how did .* (change|evolve|progress|develop)|recur across|persist across|from .* to .* (across|over)|over time|throughout the project|from (session|initial|first .* to final))\b/i;
// Temporal: require temporal QUESTION structure, not just any mention of time words
// "when was X" / "what order" / "progression" / "timeline" / "X before Y" / "renamed from"
const TEMPORAL_PATTERNS = /\b(when (was|did|were)|what order|in what sequence|progression of|timeline of|before .* (was|did)|after .* (was|did)|renamed from|switched from|moved from|went from|replaced by|started as|ended up)\b|\b(progression|timeline|chronolog)\b|언제|바뀐 시점|순서대로|진행 과정/i;

function classifyQuestion(question) {
  // Cross-session first (higher specificity, superset of temporal)
  if (CROSS_SESSION_PATTERNS.test(question)) return "cross_session";
  if (TEMPORAL_PATTERNS.test(question)) return "temporal";
  return "default";
}

// ────────── Session Turn Parser ──────────

function parseSessionTurns(sessionPath) {
  const content = readFileSync(sessionPath, "utf-8");
  return content.trim().split("\n").filter(l => l.length > 0).map((line, i) => {
    try {
      const turn = JSON.parse(line);
      const text = turn.message?.content?.filter(c => c.type === "text" && c.text).map(c => c.text).join("\n") || "";
      return { index: i, role: turn.type, text };
    } catch { return { index: i, role: "unknown", text: "" }; }
  }).filter(t => t.text.length > 10);
}

function loadProject(projectDir) {
  const manifest = JSON.parse(readFileSync(join(projectDir, "manifest.json"), "utf-8"));
  const questions = JSON.parse(readFileSync(join(projectDir, "questions.json"), "utf-8"));
  const sessionsDir = join(projectDir, "sessions");
  const sessions = new Map();
  for (const file of readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl")).sort()) {
    sessions.set(file.replace(".jsonl", ""), parseSessionTurns(join(sessionsDir, file)));
  }
  return { manifest, questions, sessions };
}

// ────────── Improved Ingest (User+Assistant Pairs) ──────────

async function ingestSessions(sessions, dbPath) {
  const { openSqlJsDatabase, saveSqlJsDatabase, runMigrations } = await import("../../dist/db/index.js");
  const { MemoryRepository } = await import("../../dist/memory/index.js");
  const { EmbeddingService } = await import("../../dist/activation/index.js");

  await runMigrations(dbPath);
  const db = await openSqlJsDatabase(dbPath);
  const repo = new MemoryRepository(db);
  const embedding = new EmbeddingService();
  await embedding.warmup();

  let count = 0;
  const sessionIds = Array.from(sessions.keys()).sort();

  for (let si = 0; si < sessionIds.length; si++) {
    const sessionId = sessionIds[si];
    const turns = sessions.get(sessionId);
    const sessionNum = si + 1;
    const totalSessions = sessionIds.length;
    const temporalPrefix = `[Session ${sessionNum}/${totalSessions}, ${sessionId}]`;

    // Build user+assistant pairs
    const pairs = [];
    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti];
      if (turn.role === "assistant" && turn.text.length >= 50) {
        // Find preceding user turn
        const prevUser = turns.slice(0, ti).reverse().find(t => t.role === "user");
        const userText = prevUser?.text || "";
        // Skip trivial user messages (just acks, images, interrupts)
        const isUserMeaningful = userText.length > 30 && !/^\[?(Image|Request interrupted|Tool loaded)/i.test(userText.trim());
        pairs.push({
          sessionId, sessionNum, totalSessions, turnIndex: ti,
          userText: isUserMeaningful ? userText : "",
          assistantText: turn.text,
        });
      }
    }

    // Merge consecutive assistant responses (same user context)
    const merged = [];
    for (const pair of pairs) {
      const last = merged[merged.length - 1];
      if (last && last.turnIndex === pair.turnIndex - 1 && !pair.userText) {
        // Merge into previous - extend assistant text
        last.assistantText += "\n\n" + pair.assistantText;
        last.turnIndex = pair.turnIndex;
      } else {
        merged.push({ ...pair });
      }
    }

    for (const pair of merged) {
      const userSnippet = pair.userText
        ? pair.userText.substring(0, 200).replace(/\n/g, " ").trim()
        : "";
      const assistantSnippet = pair.assistantText.substring(0, 300).replace(/\n/g, " ").trim();

      const summary = `${temporalPrefix} ${userSnippet ? "Q: " + userSnippet.substring(0, 120) + " → " : ""}${assistantSnippet}`.substring(0, 500);
      const details = [
        temporalPrefix,
        userSnippet ? `\nUser: ${pair.userText.substring(0, 500)}` : "",
        `\nAssistant:\n${pair.assistantText.substring(0, 3000)}`,
      ].join("");

      try {
        const memory = repo.create({
          type: "workflow", summary, details, scopeGlob: "**/*",
          lifecycleTriggers: ["before_model"], status: "active",
          activationClass: "scoped", confidence: 0.8, importance: 0.7,
        });
        // Passage text: combine user question + assistant key content for better embedding
        const passageText = [userSnippet, assistantSnippet, pair.assistantText.substring(0, 400)]
          .filter(Boolean).join(" ").substring(0, 500);
        const emb = await embedding.embedPassage(passageText);
        repo.updateEmbedding(memory.id, emb);
        count++;
      } catch { /* skip duplicates */ }
    }
  }

  saveSqlJsDatabase(db, dbPath);
  db.close();
  return count;
}

// ────────── Hybrid Retrieval (Dense + BM25 + RRF) ──────────

async function queryMemories(question, dbPath, questionType = "default", maxChunks = 20) {
  const { openSqlJsDatabase } = await import("../../dist/db/index.js");
  const { MemoryRepository } = await import("../../dist/memory/index.js");
  const { EmbeddingService, cosineSimilarity, LexicalIndex, rrfFusion } = await import("../../dist/activation/index.js");

  const db = await openSqlJsDatabase(dbPath);
  const repo = new MemoryRepository(db);
  const embedding = new EmbeddingService();
  if (!embedding.isReady) await embedding.warmup();

  const allMemories = repo.list({}).filter(m => m.embedding !== null);

  // --- Dense retrieval (top-40) ---
  const queryEmb = await embedding.embedQuery(question);
  const denseScored = allMemories
    .map(m => ({ id: m.id, score: cosineSimilarity(queryEmb, m.embedding), source: "vector", memory: m }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);

  // --- BM25 retrieval (top-40) ---
  const lexIndex = new LexicalIndex();
  lexIndex.rebuild(allMemories.map(m => ({ id: m.id, summary: m.summary, details: m.details || "" })));
  const bm25Results = lexIndex.search(question, 40);
  const memoryById = new Map(allMemories.map(m => [m.id, m]));
  const bm25Scored = bm25Results.map(r => ({
    id: r.id, score: r.score, source: "lexical", memory: memoryById.get(r.id),
  }));

  // --- RRF Fusion ---
  const fused = rrfFusion(
    [
      denseScored.map(s => ({ id: s.id, score: s.score, source: "vector" })),
      bm25Scored.map(s => ({ id: s.id, score: s.score, source: "lexical" })),
    ],
    60 // larger candidate pool before session processing
  );

  // Build scored memories with fused scores
  let candidates = fused.map(f => ({
    ...f,
    memory: memoryById.get(f.id),
    denseScore: denseScored.find(d => d.id === f.id)?.score ?? 0,
  })).filter(c => c.memory);

  // ────── Route by question type ──────

  let context;
  if (questionType === "temporal" || questionType === "cross_session") {
    context = buildSessionAwareContext(candidates, questionType, maxChunks);
  } else {
    // Default: top-K by fused score
    context = candidates.slice(0, maxChunks)
      .map((c, i) => `[${i + 1}] (rrf: ${c.score.toFixed(4)}, dense: ${c.denseScore.toFixed(3)}, src: ${c.source})\n${c.memory.details}`)
      .join("\n\n---\n\n");
  }

  db.close();
  return context;
}

// ────────── Session-Aware Retrieval ──────────

function buildSessionAwareContext(candidates, questionType, maxChunks) {
  // Step 1: Score sessions by aggregating their chunk scores
  const sessionScores = new Map(); // sessionId -> { maxScore, scores[], chunks[] }

  for (const c of candidates) {
    // Extract session info from memory details: [Session N/M, sessionId]
    const match = c.memory.details?.match(/\[Session (\d+)\/(\d+), ([^\]]+)\]/);
    if (!match) continue;

    const sessionNum = parseInt(match[1]);
    const sessionId = match[3];
    const key = sessionId;

    if (!sessionScores.has(key)) {
      sessionScores.set(key, { sessionNum, sessionId, maxScore: 0, scores: [], chunks: [] });
    }
    const entry = sessionScores.get(key);
    entry.scores.push(c.score);
    entry.maxScore = Math.max(entry.maxScore, c.score);
    entry.chunks.push(c);
  }

  // Step 2: Rank sessions by aggregate score
  const rankedSessions = [...sessionScores.values()]
    .map(s => {
      s.scores.sort((a, b) => b - a);
      s.aggScore = s.maxScore + (s.scores[1] ?? 0) * 0.5 + (s.scores[2] ?? 0) * 0.25;
      return s;
    })
    .sort((a, b) => b.aggScore - a.aggScore);

  // Step 3: Select top sessions with diversity
  const selectedSessions = rankedSessions.slice(0, questionType === "cross_session" ? 6 : 4);

  // Step 4: Sort selected sessions by session number (chronological)
  selectedSessions.sort((a, b) => a.sessionNum - b.sessionNum);

  // Step 5: Build context from each session's top chunks
  const chunksPerSession = Math.max(2, Math.floor(maxChunks / selectedSessions.length));
  const parts = [];

  for (const session of selectedSessions) {
    // Sort chunks by score within session
    session.chunks.sort((a, b) => b.score - a.score);
    const topChunks = session.chunks.slice(0, chunksPerSession);

    // Sort by turn order within session for readability
    topChunks.sort((a, b) => {
      const aIdx = a.memory.details?.match(/turn (\d+)/i)?.[1] ?? 0;
      const bIdx = b.memory.details?.match(/turn (\d+)/i)?.[1] ?? 0;
      return Number(aIdx) - Number(bIdx);
    });

    parts.push(`=== Session ${session.sessionNum} (${session.sessionId}) [relevance: ${session.aggScore.toFixed(4)}] ===`);
    for (const chunk of topChunks) {
      parts.push(chunk.memory.details);
    }
    parts.push(""); // blank line between sessions
  }

  return parts.join("\n\n");
}

// ────────── LLM Calls ──────────

function llmJudge(question, goldAnswer, generatedAnswer) {
  const prompt = `You are a benchmark judge comparing a generated answer against a gold (reference) answer.

Question: ${question}

Gold answer: ${goldAnswer}

Generated answer: ${generatedAnswer}

Judging criteria:
- CORRECT if the generated answer captures the CORE facts and concepts from the gold answer, even if:
  - Wording differs
  - Minor details are missing (e.g., exact format specifiers, minor version numbers)
  - The generated answer contains additional correct information
  - Different terminology is used for the same concept
- WRONG if:
  - The core concept is incorrect or contradicts the gold answer
  - Key facts are completely missing (not just minor details)
  - The answer is empty, "insufficient context", or an error
  - The answer describes a completely different aspect than what was asked

Reply with EXACTLY one word: CORRECT or WRONG`;
  try {
    const result = execFileSync(OPENCODE_EXE, ["run", prompt], {
      timeout: 120000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"]
    });
    return result.toUpperCase().includes("CORRECT") ? "CORRECT" : "WRONG";
  } catch (e) {
    console.error(`  Judge error: ${e.message?.substring(0, 100)}`);
    return "ERROR";
  }
}

function llmAnswer(question, context, questionType = "default") {
  let systemInstruction;

  if (questionType === "temporal") {
    systemInstruction = `You are answering TEMPORAL questions about a software project. The context below is organized chronologically by session.
Your task: Identify the earliest event, any changes over time, and the final state.
Be specific about WHEN things happened (cite session numbers). Answer as a timeline if multiple events are involved.
Include exact version numbers, dates, or session references when available.`;
  } else if (questionType === "cross_session") {
    systemInstruction = `You are answering CROSS-SESSION questions about a software project. The context includes evidence from multiple sessions.
Your task: Synthesize information across sessions. Compare what stayed consistent vs what changed.
Trace the evolution from earliest to latest session. Cite specific sessions for each claim.
Include exact technical details (names, numbers, versions) when available.`;
  } else {
    systemInstruction = `You are answering questions about a software project based on retrieved conversation context.
Answer concisely and specifically. Include exact numbers, names, and technical details when available.
If the context doesn't contain enough information, say "Insufficient context."`;
  }

  const prompt = `${systemInstruction}

Context:
${context.substring(0, 10000)}

Question: ${question}

Answer concisely:`;
  try {
    const result = execFileSync(OPENCODE_EXE, ["run", prompt], {
      timeout: 120000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"]
    });
    return result.trim();
  } catch (e) {
    console.error(`  Answer error: ${e.message?.substring(0, 100)}`);
    return "Error generating answer";
  }
}

// ────────── Retrieval Oracle Metric ──────────
// Checks if gold answer evidence EXISTS in retrieved context,
// independent of LLM answer quality. Separates "retrieval problem"
// from "generation problem".

function computeRetrievalOracle(goldAnswer, context) {
  if (!goldAnswer || !context) return { hit: false, matchedKeywords: 0, totalKeywords: 0 };

  // Extract key phrases from gold answer (words 4+ chars, excluding common words)
  const stopWords = new Set(["that", "this", "with", "from", "have", "been", "were", "they",
    "their", "about", "which", "when", "what", "than", "also", "into", "only", "some",
    "such", "each", "more", "used", "using", "based", "after", "before", "between"]);

  const goldKeywords = goldAnswer
    .toLowerCase()
    .replace(/[^\w\s\-_.]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !stopWords.has(w));

  // Deduplicate
  const uniqueKeywords = [...new Set(goldKeywords)];
  if (uniqueKeywords.length === 0) return { hit: false, matchedKeywords: 0, totalKeywords: 0 };

  const contextLower = context.toLowerCase();
  const matched = uniqueKeywords.filter(kw => contextLower.includes(kw));
  const matchRatio = matched.length / uniqueKeywords.length;

  // Oracle "hit" if >= 40% of key terms are in the context
  return {
    hit: matchRatio >= 0.4,
    matchedKeywords: matched.length,
    totalKeywords: uniqueKeywords.length,
    matchRatio: Math.round(matchRatio * 1000) / 1000,
  };
}

// ────────── Main ──────────

const args = process.argv.slice(2);
const projectFilter = args.find(a => a.startsWith("--project="))?.split("=")[1];
const numRuns = parseInt(args.find(a => a.startsWith("--runs="))?.split("=")[1] || "1");
const dataDir = resolve("data/codememo");
const outputDir = resolve("eval/codememo/results");
mkdirSync(outputDir, { recursive: true });

if (numRuns > 1) console.log(`\n*** ${numRuns}-run median mode ***\n`);

const projects = readdirSync(dataDir).filter(d => d.startsWith("project_"))
  .filter(d => !projectFilter || d === projectFilter);

for (const projectName of projects) {
  console.log(`\n${"=".repeat(60)}\nProject: ${projectName}\n${"=".repeat(60)}`);
  const { manifest, questions, sessions } = loadProject(join(dataDir, projectName));
  console.log(`Sessions: ${sessions.size} | Questions: ${questions.length}`);

  const dbPath = join(outputDir, `${projectName}.sqlite`);
  if (!existsSync(dbPath)) {
    console.log("Ingesting...");
    const count = await ingestSessions(sessions, dbPath);
    console.log(`Ingested: ${count} memories`);
  }

  const progressPath = join(outputDir, `${projectName}.progress.json`);
  let results = [];
  try { results = JSON.parse(readFileSync(progressPath, "utf-8")); } catch {}
  const doneIds = new Set(results.filter(r => r.judgment !== "ERROR").map(r => r.questionId));

  for (const q of questions) {
    if (doneIds.has(q.id)) {
      console.log(`  [${q.id}] ${CATEGORY_NAMES[q.category]} ... ${results.find(r => r.questionId === q.id)?.judgment} (cached)`);
      continue;
    }

    const questionType = classifyQuestion(q.question);
    process.stdout.write(`  [${q.id}] ${CATEGORY_NAMES[q.category]} [${questionType}] ... `);

    const context = await queryMemories(q.question, dbPath, questionType, 30);

    // Retrieval oracle: check if gold answer evidence exists in context
    const oracle = computeRetrievalOracle(q.answer_short, context);

    // Multi-run: generate answer+judge N times, take majority vote
    const judgments = [];
    let bestAnswer = "";
    for (let run = 0; run < numRuns; run++) {
      const answer = llmAnswer(q.question, context, questionType);
      const judgment = llmJudge(q.question, q.answer_short, answer);
      judgments.push(judgment);
      if (run === 0) bestAnswer = answer;
      if (numRuns > 1) process.stdout.write(`${judgment[0]}`);
    }

    // Majority vote: CORRECT wins if >= ceil(N/2) votes
    const correctCount = judgments.filter(j => j === "CORRECT").length;
    const finalJudgment = correctCount >= Math.ceil(numRuns / 2) ? "CORRECT" : "WRONG";
    if (numRuns > 1) process.stdout.write(` → `);
    console.log(finalJudgment);

    results.push({
      questionId: q.id, category: q.category, question: q.question,
      goldAnswer: q.answer_short, generatedAnswer: bestAnswer, judgment: finalJudgment,
      questionType, contextChunks: context.split("---").length,
      retrievalOracle: oracle.hit, oracleMatchRatio: oracle.matchRatio,
      ...(numRuns > 1 ? { runs: judgments, runCount: numRuns } : {}),
    });
    writeFileSync(progressPath, JSON.stringify(results, null, 2));
  }

  // Report
  const evaluated = results.filter(r => r.judgment !== "ERROR");
  const correct = evaluated.filter(r => r.judgment === "CORRECT");
  console.log(`\nOverall: ${correct.length}/${evaluated.length} = ${evaluated.length > 0 ? (correct.length / evaluated.length * 100).toFixed(1) : "N/A"}%`);
  for (const [cat, name] of Object.entries(CATEGORY_NAMES)) {
    const cr = evaluated.filter(r => r.category === Number(cat));
    const cc = cr.filter(r => r.judgment === "CORRECT");
    if (cr.length > 0) console.log(`  ${name}: ${cc.length}/${cr.length} = ${(cc.length / cr.length * 100).toFixed(1)}%`);
  }

  // Show routing stats
  const typeStats = {};
  for (const r of evaluated) {
    const t = r.questionType || "default";
    if (!typeStats[t]) typeStats[t] = { total: 0, correct: 0 };
    typeStats[t].total++;
    if (r.judgment === "CORRECT") typeStats[t].correct++;
  }
  console.log("\nBy question type:");
  for (const [t, s] of Object.entries(typeStats)) {
    console.log(`  ${t}: ${s.correct}/${s.total} = ${(s.correct / s.total * 100).toFixed(1)}%`);
  }

  // Retrieval Oracle Report — separates retrieval quality from LLM answer quality
  const oracleHits = evaluated.filter(r => r.retrievalOracle === true).length;
  const oracleTotal = evaluated.filter(r => r.retrievalOracle !== undefined).length;
  if (oracleTotal > 0) {
    console.log(`\n--- Retrieval Oracle (upper bound) ---`);
    console.log(`Overall: ${oracleHits}/${oracleTotal} = ${(oracleHits / oracleTotal * 100).toFixed(1)}% of questions have evidence in context`);
    const answerAccuracy = correct.length / evaluated.length;
    const oracleAccuracy = oracleHits / oracleTotal;
    const gap = oracleAccuracy - answerAccuracy;
    console.log(`Answer accuracy: ${(answerAccuracy * 100).toFixed(1)}% | Oracle: ${(oracleAccuracy * 100).toFixed(1)}% | Gap: ${(gap * 100).toFixed(1)}pp`);
    console.log(`(Gap = evidence exists but LLM failed to extract the answer)`);

    // Per-category oracle
    for (const [cat, name] of Object.entries(CATEGORY_NAMES)) {
      const catResults = evaluated.filter(r => r.category === Number(cat) && r.retrievalOracle !== undefined);
      if (catResults.length > 0) {
        const catOracleHits = catResults.filter(r => r.retrievalOracle === true).length;
        const catCorrect = catResults.filter(r => r.judgment === "CORRECT").length;
        const catGap = (catOracleHits / catResults.length) - (catCorrect / catResults.length);
        console.log(`  ${name}: oracle ${catOracleHits}/${catResults.length} (${(catOracleHits / catResults.length * 100).toFixed(0)}%) | answer ${catCorrect}/${catResults.length} (${(catCorrect / catResults.length * 100).toFixed(0)}%) | gap ${(catGap * 100).toFixed(0)}pp`);
      }
    }
  }
}

console.log("\n--- Comparison ---");
console.log("synapt v0.6.2      | 90.51%");
console.log("Mem0 v1.0.5        | 76.00%");
console.log("harness-memory     | (see above)");
