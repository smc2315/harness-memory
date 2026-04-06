# harness-memory

[![npm version](https://img.shields.io/npm/v/harness-memory.svg)](https://www.npmjs.com/package/harness-memory)
[![license](https://img.shields.io/npm/l/harness-memory.svg)](https://github.com/smc2315/harness-memory/blob/master/LICENSE)
[![downloads](https://img.shields.io/npm/dm/harness-memory.svg)](https://www.npmjs.com/package/harness-memory)

**Local-first, evidence-backed project memory for AI coding assistants**

harness-memory is an OpenCode plugin that gives AI coding assistants persistent, reviewable project memory. It auto-captures evidence signals from every tool interaction, but only materializes memories through a multi-gate pipeline with human review.

**Evidence is not memory.** The system captures conversation signals automatically, but memories are curated through a deliberate lifecycle: Evidence → Signal Tags → Tier Classification → Dream Consolidation → Candidate → Human Review → Active Memory. This prevents the "auto-save everything" problem while maintaining traceability from every memory back to its source evidence.

## Quick Start

```bash
npx harness-memory install
```

This single command:
- Creates the SQLite database (`.harness-memory/memory.sqlite`)
- Registers the plugin in `opencode.json`
- Installs 8 OpenCode slash commands (`/harness-memory-*`)
- Imports existing `CLAUDE.md` / `.cursorrules` as baseline memories

Restart OpenCode and you're ready.

## Why harness-memory?

### 1. Local-First
sql.js WASM database. No cloud dependency. Your project knowledge stays on your machine. Zero native dependencies, runs anywhere Node.js runs.

### 2. Evidence-Backed
Every memory is traceable to conversation evidence with signal tags. You can audit why a memory exists and what evidence supports it.

### 3. Small Prompt Packs
10 memories max per turn, 8KB budget. 73% token savings vs dumping all context. The 4-layer activation engine (Baseline → Startup → Scoped → Diversity) ensures the right memories are injected at the right time.

### 4. Reviewable
Human-in-the-loop lifecycle: Evidence → Dream → Candidate → Review → Active. Not auto-save-everything. You approve what becomes memory.

### 5. Cross-Language
Korean ↔ English query/memory matching via multilingual-e5-small embeddings. Korean queries match English memories and vice versa.

### Best For
Compact-to-mid projects (≤20 sessions). Scaling to larger projects via hierarchical retrieval (session summaries, topic evolution) is in progress.

## Benchmark Results

### harness-memory vs CLAUDE.md (Head-to-Head)

Internal benchmarks using mock embeddings and 30 identical project rules across 12 coding tasks. Results indicate relative improvement direction, not absolute production performance:

| Metric | CLAUDE.md | harness-memory | Winner |
|--------|-----------|----------------|--------|
| **Relevance Precision** | 11.4% | 21.5% | harness-memory (**1.9×**) |
| **Coverage** | 100% | 48.6% | CLAUDE.md |
| **Tokens per task** | 731 | 197 | harness-memory (**73% savings**) |
| **Signal-to-Noise** | 0.12 | 0.34 | harness-memory (**2.7×**) |

CLAUDE.md dumps everything every time (100% coverage, 11% relevant). harness-memory selectively injects (49% coverage, 22% relevant, 73% less token cost).

### Internal Benchmark Suite (304+ tests, deterministic)

7 benchmark layers covering retrieval, extraction, promotion, safety, product, temporal, and scale:

| Benchmark | Tests | Key Metric |
|-----------|-------|------------|
| HM-Activation | 24 | Recall@5: 0.67, MRR: 0.66 |
| HM-Product | 8 | 2× precision vs CLAUDE.md |
| HM-Promotion | 20 | All 5 gates correct |
| HM-Extract | 16 | Parser/action accuracy: 100% |
| HM-Timeline | 16 | Latest-state: 100%, temporal reasoning: improved |
| HM-Safety | 20 | Block rate: 100%, 3 known evasion vectors |
| HM-Scale | 12 | Stable recall 50→500 memories |

**Note:** These benchmarks use mock embeddings for deterministic testing. Real embeddings (multilingual-e5-small) are expected to improve retrieval metrics significantly in production.

### Known Limitations

After P0+P1 structural improvements:

- **Temporal reasoning**: Improved via session summaries and 4-mode activation (was 14.3%, targeting 40-60%). The system correctly filters superseded memories and can now reconstruct event ordering within sessions. Cross-session temporal reasoning is in progress.
- **Cross-session synthesis**: Improved via session diversity enforcement (was 0-43%, targeting 30-50%). Top-k retrieval now balances session diversity, but multi-session queries still benefit from session-level pre-filtering.
- **Scale**: Hierarchical retrieval foundation in place. Works well for compact-to-mid projects (≤20 sessions). Larger projects benefit from hybrid retrieval (dense + BM25 + RRF), with full topic evolution coming in P2.
- **Mock embeddings**: Current benchmarks use mock embeddings for deterministic testing. Real embeddings (multilingual-e5-small) are expected to improve IR metrics significantly in production.

## Architecture

### 4-Layer Activation Engine

```
┌─────────────────────────────────────────────────────────────┐
│ Layer A: Baseline                                           │
│ Always inject — project fundamentals                        │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer B: Startup Priors                                     │
│ First-turn boost — lexical + vector search                  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer C: Scoped                                             │
│ File/path matching — relevant to current context            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer D: Diversity + Exploration                            │
│ Type balance + random discovery                             │
└─────────────────────────────────────────────────────────────┘
```

### Dream Pipeline

Evidence lifecycle (7 states):

```
Conversation → Buffer (5 entries) → Evidence (pending)
                                         ↓
                         Tool interactions → Signal Tags
                                         ↓
                         Tier Classification (retained/latent)
                                         ↓
                         session.idle / session.compacted
                                         ↓
                         4-gate check:
                           evidence ≥ 3 batches
                           hours since last ≥ 1
                           sessions since last ≥ 2
                           lock acquired
                                         ↓
                         LLM extraction via OpenCode SDK
                         (create/reinforce/supersede/stale)
                                         ↓
                         Evidence: grouped → materialized
                                         ↓
                         Candidate → Human Review → Active
                                         ↓
                         Evidence: consumed / discarded
```

## Memory Lifecycle

harness-memory uses a deliberate lifecycle to ensure quality:

1. **Evidence**: Conversation events are buffered and analyzed
2. **Dream**: LLM extracts structured knowledge (create/reinforce/supersede/stale)
3. **Candidate**: Extracted memories await human review
4. **Human Review**: You approve or reject candidates
5. **Active**: Approved memories are injected into AI context

This prevents the "auto-save everything" problem where AI assistants get confused by outdated or irrelevant information.

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
| `npx harness-memory install` | Auto-setup (DB + opencode.json + slash commands + CLAUDE.md import) |
| `npx harness-memory memory:add --type <type> --summary "..."` | Add memory (default scope `**/*`, status `candidate`) |
| `npx harness-memory memory:list` | List all memories |
| `npx harness-memory memory:promote --memory <id>` | Promote candidate → active |
| `npx harness-memory memory:reject --memory <id>` | Reject candidate |
| `npx harness-memory memory:review` | Interactive review session |
| `npx harness-memory memory:stats` | Usage statistics |
| `npx harness-memory memory:why` | Explain why memories activate for a scope |
| `npx harness-memory dream:run` | Run dream consolidation (heuristic) |
| `npx harness-memory dream:extract` | LLM-based memory extraction via OpenCode SDK |
| `npx harness-memory dream:evidence:list` | List evidence events |
| `npx harness-memory db:migrate` | Run database migrations |

## OpenCode Slash Commands

After `install`, these commands are available inside OpenCode:

| Command | Description |
|---------|-------------|
| `/harness-memory-add` | Add a memory (LLM infers type/summary/details) |
| `/harness-memory-list` | List memories grouped by status |
| `/harness-memory-review` | Review and approve/reject candidates |
| `/harness-memory-stats` | Show usage statistics |
| `/harness-memory-why` | Explain memory activation |
| `/harness-memory-extract` | LLM-based extraction from conversations |
| `/harness-memory-dream` | Run dream consolidation |

## Configuration

The `install` command creates `opencode.json` automatically:

```json
{
  "plugin": ["harness-memory/plugin"]
}
```

No additional configuration needed. The plugin auto-detects the database at `.harness-memory/memory.sqlite`.

## Why Not Just CLAUDE.md?

| | CLAUDE.md | harness-memory |
|--|-----------|----------------|
| **Storage** | Single file, manual edit | SQLite (WASM, zero native deps) |
| **Activation** | Dump everything every turn | 4-layer engine: right memory, right time |
| **Search** | None | Vector + lexical (multilingual) |
| **Cross-Language** | ❌ | ✅ Korean ↔ English |
| **Lifecycle** | Edit the file yourself | Evidence → Dream → Human Review (7-state pipeline) |
| **Token Cost** | Full dump every turn | 73% savings via selective injection |
| **Quality** | Whatever you wrote | Curated, evidence-backed, auditable |
| **Scaling** | Gets messy past 50 lines | Structured DB, handles hundreds |

## Contributing

Contributions are welcome! Here's how to get started:

### Running Tests

```bash
# Run all tests (304+ tests)
npx vitest run

# Run specific benchmark layers
npx vitest run test/benchmark/hm-activation.test.ts
npx vitest run test/benchmark/hm-product.test.ts
npx vitest run test/benchmark/hm-timeline.test.ts

# Run all benchmarks
npx vitest run test/benchmark/hm-*.test.ts

# Watch mode
npm run dev
```

### Architecture Overview

Three core systems:

1. **Activation Engine** (`src/activation/`): 4-layer memory injection (Baseline → Startup → Scoped → Diversity). Handles vector + lexical search, session diversity, and token budgeting.

2. **Dream Pipeline** (`src/dream/`): Evidence lifecycle management. Captures signals, classifies tiers, triggers LLM extraction, manages candidate review.

3. **Evidence Lifecycle** (`src/evidence/`): 7-state evidence tracking (pending → retained → grouped → materialized/latent → consumed → discarded). Signal tagging and tier classification.

### Reporting Issues

Open an issue on [GitHub](https://github.com/smc2315/harness-memory) with:
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs from `.harness-memory/audit.log`
- Output of `npx harness-memory memory:stats`

## Tech Stack

- **TypeScript** (strict mode, ESM only)
- **sql.js** (SQLite via WASM, zero native dependencies)
- **@xenova/transformers** + multilingual-e5-small (384d embeddings)
- **MiniSearch** (BM25 lexical fallback)
- **@opencode-ai/sdk** (LLM extraction)
- **vitest** (testing)

## How It Works

### 1. Install Once

```bash
npx harness-memory install
```

Creates DB, registers plugin, installs slash commands. Done.

### 2. Use Normally

Just code with OpenCode as usual. The plugin silently injects relevant memories into the system prompt via the 4-layer activation engine (Baseline → Startup → Scoped → Diversity).

You don't do anything different.

### 3. Evidence Capture (Automatic)

The plugin silently captures evidence from every tool interaction:
- Buffers conversation (user messages + tool outputs)
- Flushes to evidence storage every 5 entries
- Tags signals (file paths, actions, entities)
- Classifies tiers (retained vs latent)

When the session becomes idle or compacted, the plugin checks 4 gates:
- Enough evidence accumulated (≥ 3 batches)
- Enough time passed (≥ 1 hour since last extraction)
- Enough sessions passed (≥ 2 sessions)
- No other extraction running (lock)

If all gates pass, it calls the LLM via OpenCode SDK in the background. The LLM extracts structured knowledge:

- **create**: New memories to add
- **reinforce**: Strengthen existing memories
- **supersede**: Replace outdated memories
- **stale**: Mark memories as no longer relevant

### 4. Human Review

Extracted memories become candidates. The plugin asks you to review:

```
📋 Memory candidates:
  1. [policy]   TypeScript strict mode 사용 필수
  2. [policy]   Vitest 사용, Jest 금지
  3. [workflow]  배포는 Vercel

Approve? (all / 1,3 / later)
```

Or review manually anytime:

```
/harness-memory-review
```

### 5. Memory Takes Effect

Approved memories are injected into the system prompt on every turn:

```
You: "테스트 프레임워크 뭘 써야해?"
AI: "Vitest를 사용해야 합니다. 프로젝트 정책에 따르면 jest 사용은 금지입니다."
```

Before harness-memory, the same question got "Vitest or Jest, your choice."

## How It Works: Evidence vs Memory

### Evidence Capture (Automatic)
Every tool interaction generates evidence signals:
- User messages and tool outputs are buffered (5 entries)
- Flushed to evidence storage with signal tags (file paths, actions, entities)
- Tier classification: retained (high signal) or latent (low signal)
- Evidence states: pending → retained → grouped → materialized/latent → consumed → discarded

### Memory Materialization (Curated)
Evidence becomes memory through a multi-gate pipeline:
1. **Dream trigger**: 4 gates (evidence ≥ 3 batches, time ≥ 1 hour, sessions ≥ 2, lock acquired)
2. **LLM extraction**: OpenCode SDK analyzes evidence, proposes create/reinforce/supersede/stale actions
3. **Candidate review**: You approve or reject proposed memories
4. **Active memory**: Approved memories are injected via 4-layer activation engine

This separation ensures traceability (every memory links to source evidence) while preventing noise (not every evidence becomes memory).

## Examples

### Add a Memory Manually

```bash
npx harness-memory memory:add \
  --type policy \
  --summary "Use Vitest for all tests" \
  --details "We standardized on Vitest for better ESM support and faster execution"
```

### Review Candidates

```bash
npx harness-memory memory:review
```

Interactive prompt walks you through each candidate:

```
Candidate #1 (policy)
Summary: Use Vitest for all tests
Details: We standardized on Vitest for better ESM support...

[A]pprove / [R]eject / [S]kip?
```

### Check Statistics

```bash
npx harness-memory memory:stats
```

Output:

```
Memory Statistics
─────────────────
Total memories: 42
Active: 38
Candidates: 4
Stale: 0

By Type:
  policy: 12
  workflow: 8
  pitfall: 6
  architecture_constraint: 10
  decision: 6

Activation Rate (last 30 days):
  Layer A (Baseline): 100%
  Layer B (Startup): 85%
  Layer C (Scoped): 62%
  Layer D (Diversity): 23%
```

### Explain Activation

```bash
npx harness-memory memory:why 42
```

Output:

```
Memory #42: "Use Vitest for all tests"

Activated in session abc123 at 2026-04-01T10:30:00Z

Reason: Layer B (Startup Prior)
  - Vector similarity: 0.89 (query: "how do we run tests?")
  - Lexical match: "vitest" in user message
  - First turn: true

Token cost: 45 tokens
```

## Migration from CLAUDE.md

Already have a CLAUDE.md? Import it:

```bash
npx harness-memory install
```

The installer detects CLAUDE.md and imports bullet points as baseline memories automatically.

## API Reference

### TypeScript API

```ts
import {
  ActivationEngine,
  MemoryRepository,
  OpenCodeAdapter,
  PolicyEngine,
  PolicyRuleRepository,
  openSqlJsDatabase,
} from "harness-memory";
```

Subpath imports are also available:

```ts
import { MemoryRepository } from "harness-memory/memory";
import { ActivationEngine } from "harness-memory/activation";
import { OpenCodeAdapter } from "harness-memory/adapters";
import { AuditLogger } from "harness-memory/audit";
import { DreamRepository } from "harness-memory/dream";
```

## Contributing

Contributions are welcome! Please open an issue or PR on [GitHub](https://github.com/smc2315/harness-memory).

### Running Tests

```bash
# Full test suite (304+ tests)
npx vitest run

# Benchmark suite only (7 HM layers)
npx vitest run test/benchmark/hm-*.test.ts

# Specific benchmark
npx vitest run test/benchmark/hm-activation.test.ts
```

### Architecture for Contributors

- `src/activation/` — 4-layer activation engine with 4-mode routing (startup/default/temporal/cross-session)
- `src/dream/` — Evidence pipeline: signal tags, tier classification, structural grouping, reconciliation
- `src/retrieval/` — Session summaries, query routing, hierarchical retrieval infrastructure
- `src/promotion/` — 5-gate auto-promoter with TTL, contradiction demotion, candidate expiry
- `src/security/` — Security scanner (Base64, Unicode confusable, cross-field injection)
- `src/adapters/` — OpenCode adapter with progressive disclosure
- `src/plugin/` — OpenCode plugin lifecycle hooks

Evidence lifecycle: `pending → retained → grouped → materialized/latent → consumed → discarded`

## License

MIT License. See [LICENSE](LICENSE) for details.

## Links

- [npm package](https://www.npmjs.com/package/harness-memory)
- [GitHub repository](https://github.com/smc2315/harness-memory)
- [OpenCode documentation](https://opencode.ai)

---

Built with ❤️ for AI-assisted development.
