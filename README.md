# harness-memory

[![npm version](https://img.shields.io/npm/v/harness-memory.svg)](https://www.npmjs.com/package/harness-memory)
[![license](https://img.shields.io/npm/l/harness-memory.svg)](https://github.com/smc2315/harness-memory/blob/master/LICENSE)

**Local-first project memory for AI coding assistants.**

harness-memory is an [OpenCode](https://opencode.ai) plugin that gives AI coding assistants persistent, reviewable project memory. It captures evidence from tool interactions and materializes memories through a multi-gate pipeline with human review.

**Evidence is not memory.** Conversation signals are captured automatically, but memories are curated through a deliberate lifecycle: Evidence → Signal Tags → Dream Consolidation → Candidate → Human Review → Active Memory.

## Quick Start

```bash
npx harness-memory install
```

This single command creates the database, registers the plugin in `opencode.json`, installs slash commands, and imports existing `CLAUDE.md` / `.cursorrules` as baseline memories.

Restart OpenCode and you're ready.

## How It Works

### 1. Use Normally

Code with OpenCode as usual. The plugin silently injects relevant memories into the system prompt via a 4-layer activation engine.

### 2. Evidence Capture (Automatic)

Every tool interaction generates evidence signals:
- Conversation is buffered and flushed to evidence storage
- Signal tags classify evidence (failure, decision, architecture, etc.)
- Tier classification separates high-signal from low-signal evidence

### 3. Dream Consolidation

When the session goes idle, the plugin runs background consolidation:
- Reconciler checks existing memories first (reinforce > supersede > stale > create)
- LLM extraction proposes structured knowledge via OpenCode SDK
- Evidence flows through 7 states: `pending → retained → grouped → materialized/latent → consumed → discarded`

### 4. Human Review

Extracted memories become candidates. Review them:

```bash
npx harness-memory memory:review
```

Or batch operations:

```bash
npx harness-memory memory:promote --all --min-confidence 0.85
npx harness-memory memory:reject --all --max-confidence 0.5
```

### 5. Memory Injection

Approved memories are injected into every AI turn. The 4-layer activation engine selects the right memories for the right context:

| Layer | Purpose |
|-------|---------|
| **A: Baseline** | Always inject project fundamentals |
| **B: Startup** | First-turn boost via vector + lexical search |
| **C: Scoped** | File/path matching for current context |
| **D: Diversity** | Type balance + random discovery |

4 activation modes route queries appropriately: `startup`, `default`, `temporal`, `cross_session`.

## Why Not Just CLAUDE.md?

| | CLAUDE.md | harness-memory |
|--|-----------|----------------|
| **Storage** | Single file, manual edit | SQLite (WASM, zero native deps) |
| **Activation** | Dump everything every turn | 4-layer engine: right memory, right time |
| **Search** | None | Vector + lexical hybrid |
| **Lifecycle** | Edit the file yourself | Evidence → Dream → Human Review |
| **Token Cost** | Full dump every turn | 73% savings via selective injection |
| **Scaling** | Gets messy past 50 lines | Structured DB, handles hundreds |

## Benchmark Results

Internal benchmarks using mock embeddings. Results indicate relative improvement direction, not absolute production performance.

### Head-to-Head vs CLAUDE.md

30 project rules across 12 coding tasks:

| Metric | CLAUDE.md | harness-memory |
|--------|-----------|----------------|
| Relevance Precision | 11.4% | 21.5% (1.9x) |
| Coverage | 100% | 48.6% |
| Tokens per task | 731 | 197 (73% savings) |
| Signal-to-Noise | 0.12 | 0.34 (2.7x) |

CLAUDE.md dumps everything (100% coverage, 11% relevant). harness-memory selectively injects (49% coverage, 22% relevant, 73% fewer tokens).

### Stress Benchmarks (Realistic)

Adversarial tests exposing actual system limitations:

| Metric | Score | What it measures |
|--------|-------|-----------------|
| False Positive Rate | 29% | Irrelevant memories in results |
| Topic Precision | 53% | Correct-topic memories in top results |
| Disambiguation | 50% | Distinguishing similar memories |
| Signal-to-Noise | 33% | Meaningful candidates from noisy evidence |
| Tag Accuracy | 57% | Regex signal tag correctness |

These scores reflect mock embedding limitations. Real embeddings are expected to improve retrieval metrics significantly.

### Known Limitations

- **Early stage** (v0.5.0) — real-world validation in progress
- **Best for** compact-to-mid projects (up to 20 sessions)
- **Temporal reasoning** improved but not yet production-proven
- **Mock embeddings** in benchmarks; real performance will differ

## Memory Types

| Type | Purpose |
|------|---------|
| `policy` | Rules and standards |
| `workflow` | Processes and conventions |
| `pitfall` | Known issues and gotchas |
| `architecture_constraint` | Design decisions and constraints |
| `decision` | Explicit choices and their rationale |

## CLI Reference

| Command | Description |
|---------|-------------|
| `npx harness-memory install` | Auto-setup (DB + plugin + slash commands + CLAUDE.md import) |
| `npx harness-memory memory:add --type <type> --summary "..."` | Add memory manually |
| `npx harness-memory memory:list` | List all memories |
| `npx harness-memory memory:promote --memory <id>` | Promote candidate to active |
| `npx harness-memory memory:reject --memory <id>` | Reject candidate |
| `npx harness-memory memory:review` | Interactive review session |
| `npx harness-memory memory:stats` | Usage statistics |
| `npx harness-memory memory:why` | Explain memory activation |
| `npx harness-memory memory:health-check` | System health diagnostics |
| `npx harness-memory dream:run` | Run dream consolidation |
| `npx harness-memory dream:extract` | LLM-based extraction |

## Configuration

```json
{
  "plugin": ["harness-memory/plugin"]
}
```

No additional configuration needed. Database auto-created at `.harness-memory/memory.sqlite`.

## Tech Stack

- **TypeScript** (strict mode, ESM only)
- **sql.js** (SQLite via WASM, zero native dependencies)
- **@xenova/transformers** + e5-small (384d embeddings)
- **MiniSearch** (BM25 lexical search)
- **@opencode-ai/sdk** (LLM extraction)
- **vitest** (316 tests)

## Contributing

Contributions and feedback welcome. Open an issue or PR on [GitHub](https://github.com/smc2315/harness-memory).

```bash
# Full test suite
npx vitest run

# Benchmark suite
npx vitest run test/benchmark/hm-*.test.ts

# Stress benchmarks
npx vitest run test/benchmark/hm-stress.test.ts
```

### Architecture

| Directory | Purpose |
|-----------|---------|
| `src/activation/` | 4-layer activation engine, 4-mode routing |
| `src/dream/` | Evidence pipeline, signal tags, tier classification, reconciliation |
| `src/retrieval/` | Session summaries, query routing, hierarchical retrieval |
| `src/promotion/` | 5-gate auto-promoter, TTL, contradiction demotion |
| `src/security/` | Security scanner (Base64, Unicode confusable, injection detection) |
| `src/adapters/` | OpenCode adapter |
| `src/plugin/` | OpenCode plugin lifecycle hooks |

## License

MIT
