# harness-memory

Project memory layer for coding harnesses.

It provides:
- structured memory storage on local SQLite via `sql.js`
- deterministic activation with bounded payload budgets
- warning-only policy surfacing before tool use
- stale/conflict-aware memory handling
- local eval runners for baseline and memory-layer replay

## Install

This package is intended for Node.js consumers.

Fastest start, no permanent install required:

```bash
npx harness-memory init
```

That creates a local SQLite database under `.harness-memory/` and generates OpenCode command wrappers under `.opencode/commands/`.

From a local path:

```bash
npm install ../harness-memory
```

From a packed tarball:

```bash
npm pack
npm install ./harness-memory-0.2.1.tgz
```

GitHub repository:

```text
https://github.com/smc2315/harness-memory
```

## Import

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
import { runMemoryEval } from "harness-memory/eval";
```

## CLI

The installed package exposes a single bin:

```bash
harness-memory <command> [args]
```

Examples:

```bash
harness-memory init --db ./.harness-memory/memory.sqlite
harness-memory memory:add --db ./.harness-memory/memory.sqlite --type policy --scope "src/**/*.ts" --summary "Prefer explicit adapters" --details "Keep harness integration thin." --triggers before_model --status active
harness-memory dream:run --db ./.harness-memory/memory.sqlite --trigger manual --json
harness-memory memory:review --db ./.harness-memory/memory.sqlite --json
harness-memory memory:promote --db ./.harness-memory/memory.sqlite --memory <candidate-id>
harness-memory memory:list --db ./.harness-memory/memory.sqlite --json
harness-memory policy:check --db ./.harness-memory/memory.sqlite --scope src/core/repo.ts --trigger before_tool --tool edit
harness-memory eval:baseline --output-dir ./artifacts/baseline
harness-memory eval:memory --output-dir ./artifacts/memory
```

## OpenCode-friendly setup

`init` writes lightweight OpenCode command wrappers into `.opencode/commands/`.

After initialization, you can use project commands like:

- `/harness-memory-init`
- `/harness-memory-dream`
- `/harness-memory-why`

These wrappers call the underlying `npx harness-memory ...` commands so you can stay inside OpenCode instead of remembering raw CLI syntax.

## Notes

- Bundled migration and eval input assets are resolved from inside the installed package.
- Eval outputs default to the caller's current working directory under `research/eval/output` unless `--output-dir` is provided.
- The package does not require the original repo layout once installed.
- Runtime target: Node.js 18+
- `dream:run` creates or refreshes `candidate` memories only. It does not auto-promote directly to `active`.
- Manual review loop: `dream:run` -> `memory:review` -> `memory:promote` or `memory:reject`
