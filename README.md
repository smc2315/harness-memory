# harness-memory

[![npm version](https://img.shields.io/npm/v/harness-memory.svg)](https://www.npmjs.com/package/harness-memory)
[![license](https://img.shields.io/npm/l/harness-memory.svg)](https://github.com/smc2315/harness-memory/blob/master/LICENSE)
[![downloads](https://img.shields.io/npm/dm/harness-memory.svg)](https://www.npmjs.com/package/harness-memory)

**High-precision project memory for AI coding assistants**

harness-memory is an OpenCode plugin that gives AI coding assistants persistent, high-precision project memory. Instead of dumping everything into CLAUDE.md, it compiles project knowledge into small, targeted prompt packs that are injected automatically based on context.

**Not an auto-collector** — a system that compiles project knowledge into small, high-precision prompt packs.

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

## Features

| Feature | Description |
|---------|-------------|
| 🎯 **4-Layer Activation** | Baseline → Startup → Scoped → Diversity engine for context-aware injection |
| 🌐 **Cross-Language Search** | Korean ↔ English vector matching via multilingual-e5-small |
| 🔄 **Memory Lifecycle** | Evidence → Dream → Candidate → Human Review → Active |
| 📊 **Structured Audit Logging** | Track activation patterns and quality metrics |
| 🚀 **Zero Native Dependencies** | SQLite via WASM, runs anywhere Node.js runs |
| 🧠 **LLM-Based Extraction** | OpenCode SDK integration for intelligent memory extraction |
| 📈 **Token Efficiency** | 41% savings vs full CLAUDE.md dump |

## Benchmark Results

Real numbers from our test suite:

| Metric | Result | Improvement |
|--------|--------|-------------|
| First-turn hit rate | 90% | +125% vs no vector search (40%) |
| Cross-language matching | 80% | Korean ↔ English |
| Token efficiency | 41% savings | vs full CLAUDE.md dump |
| Stale filtering | 100% accuracy | Prevents outdated info |
| Embed latency | 2.1ms avg | 362 texts/sec throughput |
| Long-session F1 | 0.89 | Precision 0.80, Recall 1.00 |

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

```
Conversation → Buffer (5 entries) → Evidence (auto)
                                        ↓
                        session.idle / session.compacted
                                        ↓
                        4-gate check:
                          evidence ≥ 3
                          hours since last ≥ 1
                          sessions since last ≥ 2
                          lock acquired
                                        ↓
                        LLM extraction via OpenCode SDK
                        (create/reinforce/supersede/stale)
                                        ↓
                        Candidate → Human Review → Active
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
| **Lifecycle** | Edit the file yourself | Evidence → Dream → Human Review |
| **Token Cost** | Full dump every turn | 41% savings via selective injection |
| **Quality** | Whatever you wrote | Curated, evidence-backed, auditable |
| **Scaling** | Gets messy past 50 lines | Structured DB, handles hundreds |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Test embedding performance
npm run test:embedding

# Watch mode
npm run dev
```

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

Just code with OpenCode as usual. The plugin silently:
- Injects relevant memories into the system prompt (4-layer activation)
- Buffers your conversation (user messages + tool outputs)
- Flushes to evidence every 5 entries

You don't do anything different.

### 3. Automatic Extraction

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

## Why harness-memory?

### Problem: CLAUDE.md Gets Messy

You start with a clean CLAUDE.md. Six months later, it's 10,000 lines of conflicting information. Your AI assistant gets confused. You spend hours manually pruning.

### Problem: Auto-Collectors Are Noisy

Tools that auto-save everything create noise. Your AI assistant sees outdated decisions, abandoned experiments, and irrelevant context.

### Solution: High-Precision Memory

harness-memory uses a human-in-loop lifecycle. Evidence is collected, dreams are extracted, candidates are reviewed. Only high-quality, relevant memories make it to production.

The 4-layer activation engine ensures the right memories are injected at the right time. Cross-language vector search means Korean queries match English memories (and vice versa).

Result: 90% first-turn hit rate, 41% token savings, zero manual pruning.

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

## License

MIT License. See [LICENSE](LICENSE) for details.

## Links

- [npm package](https://www.npmjs.com/package/harness-memory)
- [GitHub repository](https://github.com/smc2315/harness-memory)
- [OpenCode documentation](https://opencode.ai)

---

Built with ❤️ for AI-assisted development.
