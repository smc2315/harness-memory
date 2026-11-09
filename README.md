# harness-memory

[![npm version](https://img.shields.io/npm/v/harness-memory.svg)](https://www.npmjs.com/package/harness-memory)
[![license](https://img.shields.io/npm/l/harness-memory.svg)](https://github.com/smc2315/harness-memory/blob/master/LICENSE)

**Trigger-aware project memory for Claude Code.** harness-memory learns policies and pitfalls from your own sessions — a correction you typed, a command that failed and was then fixed — and surfaces them *before the tool runs*, at the `PreToolUse` boundary, instead of dumping a handbook into the system prompt.

It is complementary to [claude-mem](https://github.com/thedotmack/claude-mem): claude-mem remembers what happened; harness-memory stops the agent at the moment it is about to repeat a known mistake. No account, no telemetry, no daemon, no LLM call per tool call — the hot path reads one precomputed JSON file.

> **0.6.0-rc.1 — Claude Code only.** Codex hooks arrive in 0.6.1 and OpenCode (V2 plugin) in 0.6.2. v0.5 was an OpenCode plugin; read [Upgrading from 0.5](#upgrading-from-05) before installing 0.6 over an existing `.harness-memory/`. Not on npm yet: install the pre-release tarball, see [Install](#install).

- [How it works in one turn](#how-it-works-in-one-turn)
- [Requirements](#requirements)
- [Install](#install)
- [How memory is captured and saved](#how-memory-is-captured-and-saved)
- [The authority model](#the-authority-model)
- [What gets injected, when](#what-gets-injected-when)
- [Embeddings (optional)](#embeddings-optional)
- [Configuration](#configuration)
- [CLI reference](#cli-reference)
- [Troubleshooting](#troubleshooting)
- [Privacy and security](#privacy-and-security)
- [Upgrading from 0.5](#upgrading-from-05)
- [Roadmap](#roadmap)
- [Development](#development)

## How it works in one turn

```text
you:     don't run `npm test` here, run `pnpm test` from packages/api
         └─ UserPromptSubmit hook: correction detected (the previous tool call failed) → ledger line
claude:  (fixes it, runs pnpm test) … Stop
         └─ Stop hook: closes the turn as an episode (evidence weight 2), writes queue/<id>.json,
            spawns the detached worker
worker:  your own `claude -p` (headless, no tools) extracts one fact:
         pitfall · signature bash/cmd "npm test" · scope packages/api → validated →
         active (authority auto, enforcement advise, TTL 30 d) → snapshot rebuilt
next session:
claude:  Bash: npm test
         └─ PreToolUse hook (≈ 50 ms, no SQLite): signature matches — `npm test`, `npm run test` and
            `& npm.cmd test` canonicalize the same way; `pnpm test` never matches it → additionalContext:
            "[harness-memory] PITFALL (auto, provisional): Run pnpm test from packages/api …"
            An auto rule is born at advise. When a second session confirms the correction it climbs to
            soft_deny, and the same call is denied: "… If this does not apply, call the tool again to proceed."
claude:  Bash: pnpm test
```

Three ideas carry the design:

1. **Timing.** Knowledge has four lifecycle triggers — `session_start`, `before_model`, `before_tool`, `after_tool` — and the one that matters most is `before_tool`: Claude Code's only pre-execution channel is `permissionDecision: ask | deny`, so every memory carries an **enforcement** level (`advise`, `confirm`, `soft_deny`, `deny`) that maps onto it.
2. **Evidence is not memory.** Hooks only append raw events to a per-session ledger. Memories are structured facts (type, scope glob, trigger signature, triggers, confidence, provenance) produced by one write path: episode → extraction → validation → deterministic reconcile.
3. **Governed autonomy.** The LLM extracts; **authority** stays explicit. A pitfall learned from one correction activates on its own (`authority = auto`, with a TTL and a lower trust multiplier). Human memories can never be demoted, superseded or rejected by the automatic path — it may only *propose*, and you decide in `hm review`.

## Requirements

- **Node.js ≥ 20** (developed on 24). Hooks are plain `node` processes; the worker runs SQLite through sql.js (WASM) — no native dependencies.
- **Claude Code ≥ 2.1.139** for exec-form hooks (`{"command": "<node>", "args": [...]}`). Older versions get shell-form hooks automatically when `claude --version` can be detected; with no `claude` binary found the version is unknown and exec form is assumed — if Claude Code then reports a hook error on every call, re-run `hm install --host claude --hook-form shell`.
- **An extraction CLI, logged in from a terminal, for learning**: `claude` (preferred) or `codex`. Extraction runs through your own headless CLI and subscription — no API key. The login is optional for enforcement: the hooks fire every rule already in the snapshot (`hm memory:add`, imported rows) without it; turning new `hm import` bullets into typed rows and learning from your sessions — including what you ask it to remember — start after `claude auth login` (older CLIs: `claude`, then `/login`; the desktop app's login does not apply to `claude -p`). Until then bullets and episodes wait in the queue and nothing is lost.
- Windows, macOS, Linux. On Windows, Git Bash is optional (see [below](#node-path-npx-and-windows-shells)).

## Install

### Install the release candidate

0.6.0-rc.1 is not on npm yet: `npm install -g harness-memory` still installs **0.5.1, the OpenCode plugin**, which has no `hm` binary. Install the tarball attached to the GitHub pre-release instead:

```bash
node --version                      # ≥ 20; with nvm, the version you will keep (nvm alias default <v>)
npm uninstall -g harness-memory     # removes a leftover 0.5.1; harmless when nothing is installed
npm install -g https://github.com/smc2315/harness-memory/releases/download/v0.6.0-rc.1/harness-memory-0.6.0-rc.1.tgz
hm --version                        # 0.6.0-rc.1
cd <your project>
hm install --host claude            # from a plain terminal, not from a shell inside a Claude Code session
hm status
```

- **`hm` not found.** The npm global prefix (`npm prefix -g`; Windows default `%APPDATA%\npm`) is not on PATH, or the terminal predates the Node install — open a new one. Meanwhile `node "$(npm root -g)/harness-memory/dist/bin/harness-memory.js" --version` works. `harness-memory --version` printing `0.5.1` means another Node's global directory wins: `npm ls -g harness-memory` under each Node.
- **Windows PowerShell:** `hm.ps1 cannot be loaded because running scripts is disabled` is npm's PowerShell shim under the default execution policy (npm's own `npm.ps1` fails the same way). Once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or run `hm.cmd` / use Git Bash. The hooks never use the shim: they run `node.exe` directly.
- **Per project instead of global:** `npm install -D <same URL>`, then `npx hm install --host claude`; the hooks then point at `node_modules/harness-memory/dist/hook.js`. Not `npx harness-memory …` while npm's `latest` is 0.5.1 (that runs the old plugin's `install`), and not from git (`github:smc2315/harness-memory#redesign/v0.6` has no `dist/`; the build runs only in `prepack`).
- **Later:** `npm install -g harness-memory@next` once the rc is published under the `next` tag, plain `harness-memory` once 0.6.0 is `latest`. After any update run `hm install --host claude` again in each project: it migrates the database (backup first), replaces the hook entries, re-probes and re-runs the self-test. A global install keeps its hook path, so nothing breaks in between.
- **Learning needs the `claude` CLI logged in from a terminal:** `claude auth login` (older CLIs: `claude`, then `/login`). The desktop app's login does not count, and the desktop app alone puts no `claude` on your PATH — install the CLI; without it `hm install` reports `provider none found` and still succeeds. Enforcement of imported and hand-added rules works without the login; `probe not_logged_in` / `queue N (waiting: not_logged_in)` are expected until then, and `hm install --host claude` re-probes at once afterwards.
- **Moving to another machine:** nothing to copy. `.harness-memory/` is per project and git-ignored, so a fresh clone starts empty; to carry memories, copy that project's `memory.sqlite` (and `config.json`) with Claude Code closed and run `hm install --host claude` there. Never copy `.claude/settings.local.json` or `install-manifest.json`: they hold the other machine's node and hook paths. Korean step-by-step checklist: [docs/setup-new-machine.ko.md](docs/setup-new-machine.ko.md).

Abridged output of `hm install --host claude` on a new project:

```text
harness-memory 0.6.0-rc.1 installed for Claude Code
  project     C:\src\my-app
  hooks       9 events → C:\src\my-app\.claude\settings.local.json (exec form)
  node        C:\Program Files\nodejs\node.exe  (claude 2.1.172)
  hook script C:\Users\me\AppData\Roaming\npm\node_modules\harness-memory\dist\hook.js
  database    C:\src\my-app\.harness-memory\memory.sqlite v22 (created)
  snapshot    built (active 0, candidates 0)
  config      C:\src\my-app\.harness-memory\config.json (created); embeddings off
  git         .claude/settings.local.json added to C:\src\my-app\.git\info\exclude
  git         C:\src\my-app\.harness-memory\.gitignore written (nothing under .harness-memory/ is ever committed)
  provider    claude — probe not_logged_in (Not logged in · Please run /login); the hooks enforce rules without the login — …; learning from sessions … starts after `claude auth login` …
  self-test   session-start ok (105ms, hook status ok)
  manifest    C:\src\my-app\.harness-memory\install-manifest.json
Open Claude Code in this project; `hm status` shows what the hooks learn.
```

A project that already has a v0.5 database shows `v22 (migrated from v9, backup …\memory.sqlite.bak-v9)` instead; read [Upgrading from 0.5](#upgrading-from-05) first.

No restart is needed: Claude Code's file watcher picks up the new hook entries (if `hm doctor` → `hooks.calls` still says `never` after your first prompt, start a new session). Open the project in Claude Code, work normally, and watch `hm status`. If the project has a `CLAUDE.md` or `AGENTS.md`, the install output also suggests `hm import --from CLAUDE.md`, which turns its bullets into human memories after a confirmation table.

Claude Code's own **auto memory** (`~/.claude/projects/<slug>/memory/`, notes with `type: feedback`) is a second import source: `hm import --from auto-memory` turns those notes into human rules through the same confirmation table, so a correction Claude already wrote down starts being enforced at the tool boundary. The install output mentions it when such notes exist.

### What `hm install` writes

| Path | What |
|---|---|
| `.claude/settings.local.json` | Nine hook entries (table below). Existing hooks are untouched; re-running `hm install` replaces only entries whose `args` point at a harness-memory `hook.js`. `--user` targets `~/.claude/settings.json` instead (`CLAUDE_CONFIG_DIR` is honoured). |
| `.git/info/exclude` | Gains the line `.claude/settings.local.json` (project scope only). When `.git` is a worktree or submodule pointer file, the real `info/exclude` is resolved through it; when it cannot be resolved, install warns instead of staying silent. |
| `.harness-memory/.gitignore` | Contains `*`, so the ledgers, the database, the snapshot and the logs never reach git. An edited file is kept; `hm doctor` warns when git already tracks files under the directory and prints the git command that untracks them. |
| `.harness-memory/` | Created with `config.json` defaults, `memory.sqlite` (created, or migrated with a `memory.sqlite.bak-v<N>` backup when upgrading), the `snapshot/` files and empty `ledger/ state/ queue/ raw/ locks/ logs/`. |
| `.harness-memory/install-manifest.json` | Files touched with sha256, node path, hook form, version. `hm uninstall` and `hm doctor --fix` work from it. |
| `~/.harness-memory/` | User-level, created on first use rather than by `install`: `worker/<repo_hash>/` (an empty cwd for the headless extraction CLI, outside any git repository), `models/` (embedding model cache). A v0.5 `global.sqlite` there is left alone. |

Each registered hook is an exec-form command — the absolute Node binary that ran `hm install` plus the absolute `dist/hook.js` and the event name:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|WebFetch|mcp__.*",
        "hooks": [
          {
            "type": "command",
            "command": "C:\\Program Files\\nodejs\\node.exe",
            "args": ["C:\\...\\harness-memory\\dist\\hook.js", "pre-tool"],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

| Claude Code event | matcher | hook argv | timeout |
|---|---|---|---|
| `SessionStart` | — | `session-start` | 10 s |
| `UserPromptSubmit` | — | `prompt` | 10 s |
| `PreToolUse` | `Bash\|PowerShell\|Edit\|MultiEdit\|Write\|NotebookEdit\|WebFetch\|mcp__.*` | `pre-tool` | 5 s |
| `PostToolUse` | `.*` | `post-tool` | 5 s |
| `PostToolUseFailure` | `.*` | `post-tool-failure` | 5 s |
| `Stop` | — | `stop` | 10 s |
| `StopFailure` | — | `stop-failure` | 10 s |
| `PreCompact` | `manual\|auto` | `precompact` | 10 s |
| `SessionEnd` | — | `session-end` | 1 s |

`Read`, `Grep`, `Glob` and `Task` are deliberately *not* registered on `PreToolUse` (no 50 ms process on the most frequent tools); a memory whose signature names one of them is re-labelled to `before_model` by the validator.

### Node path, npx, and Windows shells

- **Node path.** Hooks record the exact `node` binary that ran `hm install` (`process.execPath`, resolved through symlinks and Windows junctions, so fnm, nvm-windows and Scoop links pin the real version) and the exact `dist/hook.js` of that package. That makes them immune to PATH, nvm and volta switches — but if that Node version goes away or the package moves, the hooks stop silently: `brew upgrade node` removes the old `Cellar/node/<version>` (install warns), `nvm uninstall` does the same, and a reinstall under pnpm / yarn / npx changes the path. `hm doctor` reports it (`install.node`, `install.hook_script`) and `hm doctor --fix` rewrites the entries to the current binary and script; with nvm, `nvm alias default <v>` before `hm install` keeps the pinned version around. The CLI itself needs `node` on PATH (`hm` is a `#!/usr/bin/env node` script); the hooks do not.
- **npx, pnpm, yarn.** Do not run `npx harness-memory …` while npm's `latest` is 0.5.1: it fetches the old OpenCode plugin and runs its `install`. pnpm and npx (and yarn when the package lands under `.yarn/`) keep one directory per version, so the registered `dist/hook.js` dies with the next upgrade (install warns; run `hm install --host claude` again afterwards). npm installs — global or project `devDependency` — keep the same path across upgrades.
- **Git Bash / PowerShell (Windows).** Claude Code runs `Bash` through Git Bash and exposes a `PowerShell` tool when Git Bash is absent. harness-memory maps both to the canonical tool `bash` and records the dialect, so a pitfall learned under one shell fires under the other (`pnpm test; git status` and `& npm test` canonicalize the same way). Exec-form hooks involve no shell at all. If shell form is needed (old Claude Code), install picks `"shell": "bash"` when Git Bash is found (`CLAUDE_CODE_GIT_BASH_PATH`, `Program Files\Git`, `%LOCALAPPDATA%\Programs\Git`, `PATH`) and `"powershell"` otherwise. The detached worker runs with `windowsHide`, so no console window flashes. Shell-form entries for PowerShell carry the call operator (`& "<node>" "<hook.js>" <event>`); without it PowerShell prints the quoted command instead of running it.
- **WSL.** Install the package and run `hm install` inside the environment that runs Claude Code: a WSL session needs the Linux `node` and a Linux `dist/hook.js` path in `.claude/settings.local.json`, and a checkout under `/mnt/c` holds one settings file, so pick one side. With a user-space Node (nvm, a tarball under `$HOME`) source its environment in the shell that runs `hm`, and keep the prefix out of `/tmp`, which systemd clears at every WSL boot.

### Verify and remove

```bash
hm status              # one line: active N (auto M) | candidates | proposals | queue | last extraction | probe | snapshot | p95
hm doctor              # every check with OK / WARN / FAIL; --self-test runs the session-start hook once
hm uninstall           # removes the hook entries, the git exclude line and the manifest; keeps .harness-memory/
hm uninstall --purge   # also deletes .harness-memory/ except memory.sqlite.bak-v<N> backups
```

## How memory is captured and saved

```text
hooks (no DB)          ledger/*.jsonl ──► queue/<episode>.json ──► worker extract ──► memory.sqlite ──► snapshot/*.v1.*
                       state/*.json        (turn segment)           claude -p +         (one lock,        read by every hook
                                                                    V1–V12 + reconcile   write_ops)
```

### 1. Ledger — what the hooks write

Every hook appends **one JSON line** (≤ 32 KB, a single `appendFileSync`, credentials redacted first) to `.harness-memory/ledger/claude-code-<session_key>.jsonl`, where `session_key = sha1("claude-code:" + session_id).slice(0, 16)`. Hooks never open SQLite; the only other hook-written files are `state/claude-code-<session_key>.json` (open turn: `turn_key`, `turn_start_offset`, `segment`, `correction_for`) and `queue/*.json`.

| line | written by | fields (caps) |
|---|---|---|
| `prompt` | `prompt` | `text` (4,000 chars), `correction`, `remember` |
| `fired` | `pre-tool` | `memory_ids`, `rule_codes`, `tool`, `target_digest` (120), `delivery`, `decision`, `enforcement`, `signature_keys` |
| `tool_ok` | `post-tool` | `tool` (canonical), `host_tool`, `shell_dialect`, `input_digest` (500), `scope_refs`, `program_token`, `output_head` (2,000) / `output_tail` (1,000), `resolution_of` |
| `tool_fail` | `post-tool-failure` | the `tool_ok` fields + `error` (1,500), `exit_code`, `is_interrupt`, `failure_class` (`exit_N`, `enoent`, `eacces`, `timeout`, `interrupt`, `other`), `failure_sig` |
| `assistant` | `stop` | `text` = last assistant message (2,000) |
| `marker` | `session-start`, `precompact`, `session-end`, `stop-failure`, idle sweep | `marker`, `detail` |

Regexes are used **only** to set flags — they never produce memory text (the v0.5 "template candidate" defect). Signals:

- **correction** — the previous turn's last tool call failed, or the prompt matches correction vocabulary (`don't`, `instead`, `wrong`, `revert`, `아니`, `하지 마`, `말고`, `대신`, `틀렸`, …).
- **remember** — `remember`, `from now on`, `기억`, `앞으로`, `절대`; `always` / `항상` only at a sentence start or together with another cue. The flag weights the episode (3). The human path of §7.3 additionally needs an explicit request in the prompt itself (`remember this`, `기억해`, `from now on` followed by a rule); `I don't remember whether …` never counts.
- **failure → resolution** — a `tool_ok` for the same tool and the same path (or the same canonical program token, e.g. `pm test`) as an earlier unresolved `tool_fail`. A failing `npm test` followed by a successful `ls` is *not* a resolution; a successful `pnpm test` is.
- **decision marker** — `decided`, `we'll use`, `switch to`, `결정`, `이제부터`, `전환`, … in the last assistant message.

### 2. Episode — the turn segment is the queue

`Stop`, `PreCompact` and `SessionEnd` close the open segment (`[turn_start_offset, EOF)`, ≤ 4 MB) into `queue/<episode_id>.json`: scope refs, tools used, failure signatures with their resolutions, flags, which memories fired and whether the agent **overrode** or **heeded** a `soft_deny`, and

```text
evidence_weight = correction 2 + remember 3 + (resolution 2 | unresolved failure 1 per failure)   (cap 10)
```

Only episodes with `evidence_weight ≥ 1` or a decision marker go to the LLM; read-only turns are skipped as `no_signal`. The next `UserPromptSubmit` closes a turn the host never finished (`interrupted`); the `SessionStart` hook and `hm dream` sweep turns idle for more than an hour (`idle`). Episode ids are deterministic (`host:session:turn_key:segment`), so re-closing the same segment is a no-op and a turn compacted mid-way yields two episodes.

### 3. Extraction — a detached worker and your own CLI

The hook spawns `node dist/worker.js <root> extract` detached (`stdio: ignore`, `windowsHide`), so the hook returns in milliseconds. The worker, under `locks/worker.lock`:

1. inserts the queued episodes (`INSERT OR IGNORE`), rolls `fire_count` / `override_count` up from the fired lists, leases ≤ 3 episodes — corrections first — and applies the daily cap (`extraction.max_runs_per_day`, default 40; correction episodes are exempt);
2. renders the prompt: episode header, the previous turn's last ≤ 12 tool lines as *non-citable* context when this is a correction, every ledger line numbered `e<seq>` (failures and resolutions in full, the rest summarized), the last assistant message, up to 40 existing memories whose scope intersects, the canonical tool vocabulary and the type boundary rules — capped at 24,000 chars;
3. calls the provider (`extraction.provider`: `auto` → `claude` if found, else `codex`):

   ```text
   claude -p --output-format json --json-schema <schema> --tools "" --disallowedTools "mcp__*" \
     --strict-mcp-config --no-session-persistence \
     --settings '{"disableAllHooks":true,"autoMemoryEnabled":false}' --model <extraction.model, default sonnet>
   ```

   with the prompt on stdin, cwd `~/.harness-memory/worker/<repo_hash>/` (outside every repository, so no `CLAUDE.md`, project hooks or auto-memory load), an **allowlisted environment** (no `CLAUDECODE`, `CLAUDE_CODE_*`; `HARNESS_MEMORY_DISABLE=1` so hooks inside the child exit immediately), a 120 s wall clock and the raw answer cached 24 h in `raw/<run_id>.json`. The binary is resolved from `HARNESS_MEMORY_CLAUDE_BIN`, then `CLAUDE_CODE_EXECPATH`, then `PATH`, then the winget package directory. A **probe** (a one-field schema call) classifies the provider as `ok`, `not_logged_in`, `missing`, `nested_refusal`, `probe_timeout` or `invalid_output`; an `ok` is trusted for a day, a failure is retried after ten minutes, and unavailable providers leave episodes `queued` without burning an attempt.

The extractor answers a fixed JSON schema: `episode_summary`, `nothing_to_learn` and ≤ 8 `facts`, each with `action` (`create` | `reinforce` | `propose_supersede` | `propose_stale`), `type`, `summary` (12–160 chars), `details`, `scope_glob`, `relevant_tools`, `trigger_signature` (`{tool, target, pattern_kind, pattern}`), `lifecycle_triggers`, `confidence`, `evidence_refs` (`e<seq>` citations), `knowledge_kind`, `rationale` and `aliases` (≤ 8 synonyms, including the user's language). There is no `delete` and no `edit`: the LLM can only create, reinforce or propose.

### 4. Validation — V1 to V12

Each fact passes a deterministic validator before it touches the database: schema shape (V1); every `evidence_refs` entry resolves to a line of this episode (V2); the scope is a repository-relative glob that intersects the episode's files unless a signature carries the precision (V3); the signature's tool was actually used in the episode (V4); regexes compile, have no nested quantifiers and sweep 4 KB samples within the budget — 2 ms, or 2.5× a reference pattern of the same shape measured alongside on a slower machine (V5); the security scanner passes and the text does not talk about harness-memory itself (V6); `reinforce` / `propose_*` targets exist (V7); the fact is not a restatement of the prompt (V8); no duplicate `semantic_key` within the batch (V9); signatures are specific — `cmd` ≥ 2 tokens, `substring` ≥ 8 chars, globs with a path fragment (V10); `before_tool` is kept only where a hook can deliver it (V11); and a signature is rejected when it also matches the command that resolved the cited failure while that command differs from the failing one — `pm test` would fire on the `pnpm test` that fixed `npm test` (V12). A run that is not JSON, has more than 8 facts or more than 50 % hallucinated citations is marked `suspect` and skipped whole; otherwise rejected facts are counted and the rest are applied.

### 5. Reconcile — one transaction, then the snapshot

Under `locks/db.lock` (held for seconds, never around the LLM call) the worker applies the facts fact-by-fact (`SAVEPOINT` each): `create` becomes a new row with `authority = 'auto'`, `status = 'candidate'`, `source_ref = 'episode:<id>'`; an identical or near-identical live row (`semantic_key`, or Jaccard ≥ 0.6 on the normalized summary) is **reinforced** instead; `propose_*` opens or supports a **proposal**. Every fact records `memory_provenance` (episode, cited line, confidence); derived counters (`evidence_count`, `evidence_score` = Σ episode weights, `distinct_session_count`, auto `confidence`) are recomputed immediately, then `decideTier` decides `active` or `candidate` (see [auto tier](#auto-tier--when-a-memory-activates-on-its-own)). The run id is written to `write_ops`, so replaying the same run is a no-op; `policy_rules` are re-derived from active policy memories; `db_generation` increments; the database is saved atomically (`.tmp-<pid>` → fsync → `.prev` → rename) and `snapshot/*.v1.*` is rebuilt. A corrupted main file is recovered from `.prev`.

**Consolidation** (`worker dream`; spawned at `SessionEnd` when the last run is older than `dream.interval_hours` = 6, or `hm dream`) never invents memories: TTL expiry (correction/failure-derived rows get a `revalidate` proposal first), auto candidates older than 45 d → `rejected`, proposals past 30 d → `expired`, TTL extension for rows that fired recently, **override downgrade** (an auto row overridden ≥ 3 times with `evidence_score < 3` drops to `advise`), `merge` proposals for auto near-duplicates, embedding backfill, the idle-turn sweep and garbage collection (ledger segments 14 d, `raw/` 24 h, tmp files 10 min, audit log 30 d).

### `.harness-memory/` layout — what to back up

| Path | Content | Back up? |
|---|---|---|
| `memory.sqlite` | **Source of truth**: memories, episodes, runs, proposals, provenance, transitions, policy rules, `write_ops`, `meta` | **Yes** |
| `memory.sqlite.prev`, `memory.sqlite.bak-v<N>`, `memory.sqlite.corrupt-<ts>`, `memory.sqlite.rollback-<ts>` | Last good copy; pre-migration backup per schema version; damaged file kept aside; file replaced by `db:rollback` | keep `.bak-v<N>` until you trust the upgrade |
| `config.json` | Your settings (see [Configuration](#configuration)) | Yes |
| `install-manifest.json` | What `hm install` touched | no (re-run `hm install`) |
| `snapshot/active.v1.json`, `lexical.v1.json`, `recall.v1.json`, `dense.v1.bin`, `.reindex-requested` | Read model for the hooks: active memories with precompiled scope regexes and signatures, derived rules, failure index, counts; serialized MiniSearch index; per-episode recall summaries with their own index (when `recall.enabled`); optional embedding matrix | no (derived; `hm snapshot:rebuild`) |
| `ledger/*.jsonl`, `state/*.json`, `state/*.notify.json` | Per-session raw events (14 d), open-turn cursor, worker → next-prompt notices | no |
| `queue/*.json`, `raw/*.json` | Episodes waiting for extraction; provider raw output cache (24 h; invalid or suspect answers are kept as `<run>.<attempt>.json` for the same time) | no |
| `locks/db.lock/`, `locks/worker.lock/`, `*.pid`, `embed-helper.spawn` | `mkdir`-based locks with `owner.json` heartbeats; pid files; spawn throttle | no |
| `logs/hooks.log`, `logs/worker.log`, `logs/audit.log` | One line per hook call (5 MB × 3 rotation); worker events; audit events | no |

`hm install` writes `.harness-memory/.gitignore` (`*`), so nothing in the directory reaches git; `hm doctor` warns if files there were committed earlier. `hm memory:export` writes a deterministic SQL dump for backups that should live in version control.

## The authority model

### Two axes on every memory

- **`authority ∈ {human, auto}`** — who may change its status. `human` rows come from `hm memory:add`, `hm import` (a file you wrote), `hm memory:promote`, accepted `activate_*` proposals, replacement rows you accept, and *any* human edit (`memory:enforce`, scope changes). They have **no TTL**, a trust multiplier of 1.0, and the automatic path can never demote, supersede, stale or reject them — `transitionMemory` throws `AuthorityViolationError` and writes nothing. `auto` rows are born from extraction; they carry a TTL, a trust multiplier of 0.65 → 0.8 → 0.95 as validations accumulate, and they can be demoted by 2-session contradicting evidence or by repeated overrides.
- **`enforcement ∈ {advise, confirm, soft_deny, deny}`** — how a `before_tool` hit is delivered. `deny` can only be set by a human; the LLM never raises enforcement.

### The delivery ladder (Claude Code)

| enforcement | what Claude Code receives | timing |
|---|---|---|
| `advise` | `hookSpecificOutput.additionalContext` | with the tool result |
| `confirm` | `permissionDecision: "ask"` + reason; downgraded to `soft_deny` under `permission_mode` `bypassPermissions` / `dontAsk` (`delivery = before_downgraded`) | before execution |
| `soft_deny` | `permissionDecision: "deny"` + reason ending in *"If this does not apply, call the tool again to proceed."* — only the **first** attempt of a `(memory, tool)` pair in a turn is denied; the retry passes and the override is recorded | before execution |
| `deny` | `permissionDecision: "deny"` every time (*"This action is blocked by a human-set policy."*) | before execution |

`confirm`, `soft_deny` and `deny` also emit one `systemMessage` line for you (`harness-memory: pitfall 3f9a… fired (soft_deny)`); `advise` is silent. The injected text looks like `[harness-memory] PITFALL (auto, provisional): <summary> — <details>`; labels are `human`, `human, unconfirmed import` or `auto, provisional`, plus `, contested` on a human advise row that two sessions have argued against. Reasons are ≤ 600 chars; the hook never emits `allow`.

### Default enforcement (`enforcementDefault`, always overridable with `hm memory:enforce`)

| memory | authority | default |
|---|---|---|
| hard `policy` with a signature; a **confirmed** import rule with `never` / `must not` / `always` / `do not` / `절대` / `반드시` / `항상` and a signature | human | `confirm` (`before_tool.hard_policy`) |
| soft policy, policy without a signature, `hm import --yes` rows (`import_unconfirmed = 1`), other imports | human | `advise` |
| auto `pitfall` with a specific signature and `knowledge_kind ∈ {correction, failure_resolution}` | auto | `advise` (`before_tool.auto_enforcement`); climbs to `soft_deny` when a second session reinforces it (`before_tool.auto_escalation`, default `{ enabled: true, sessions: 2 }`; `autonomy_level: shadow` never climbs; a row downgraded by overrides climbs again only after a new session reinforces it). Shown in `hm memory:history` as `active (enforcement) by auto_rule` |
| a rule from a turn with an explicit remember request (`remember this`, `기억해`, `from now on` + a rule) whose fact cites that prompt line | human (`status_reason remember`, active at once, at most 2 per turn) | policy with a signature → `confirm` (`before_tool.hard_policy`); pitfall with a signature → `soft_deny`; everything else → `advise`. Named at `SessionStart` for 24 h with its undo (`hm memory:demote <id>`); the automatic path never touches it afterwards |
| every other auto row (`pitfall` without signature, `workflow`, `decision`, `architecture_constraint`) | auto | `advise` |

### Auto tier — when a memory activates on its own

`decideTier` runs for every created or reinforced auto candidate, right after its counters are recomputed:

- **active** when all hold: `type ∈ {pitfall, workflow}`, a valid repository-relative scope, a trigger signature or `relevant_tools`, a trigger a hook can reach, `confidence ≥ 0.7`, `evidence_score ≥ 2`, the scanner is clean, the row is not a replacement row of an open proposal, the caps are not hit (`extraction.max_auto_activations_per_episode` = 3, `max_auto_activations_per_day` = 10) and `autonomy_level = standard`. The row gets `ttl_expires_at = now + 30 d` for correction / failure-resolution knowledge (7 d for conventions), `revalidate_after` at half that, `validation_count = evidence_count − 1`.
- **candidate** otherwise — with a reason (`evidence`, `cap`, `confidence`, `type`, `replacement`, `autonomy`, …) and, for `policy`, an `activate_policy` proposal; for a signature-less global row, an `activate_global` proposal. `decision` and `architecture_constraint` always wait for you.

"Enough evidence" is a **weight sum, not an episode count**: one correction (2) or one failure → resolution pair (2) activates immediately. The cost side is the TTL, the 0.65 trust multiplier at first activation, the 2-session rule for demotion, V10 specificity, the override downgrade and the daily cap. Reinforcement never shrinks a TTL (`ttl = max(existing, now + max(7·2^validations, base))`, capped at 90 d); a fired memory is extended by 14 d.

### Proposals and review

Eight proposal kinds: `supersede`, `stale`, `activate_policy`, `activate_global`, `fix_scope` (from the v0.5 migration), `fix_signature`, `revalidate`, `merge`. One open proposal per (kind, target, candidate); repeated claims only raise `support_count` / `support_sessions`. The extractor's `propose_stale` / `propose_supersede` against a **human** row only opens a proposal and marks the row `contested`; against an **auto** active row it is applied automatically only with support from ≥ 2 sessions, at least one of which carries a human signal (a correction or *remember*) or a deterministic observation — an agent cannot erase your correction in two of its own turns. Rejecting a proposal suppresses the same claim for 30 days; proposals expire after 30 days (`fix_scope`: 90).

Review is exception handling, with a budget (≤ 3 items per active day is the dogfood gate): `hm review` walks proposals on human memories → `revalidate` → policy candidates → global candidates → `fix_scope` / `fix_signature` → `merge` → unconfirmed imports → human candidates, with keys `a`ccept, `r`eject, `s`kip, `t`race, `p`romote. Accepting a `supersede` makes the replacement row `human`; accepting `activate_*` promotes the row as `hm memory:promote` would. The `SessionStart` hook shows a one-line `systemMessage` digest once a day (`harness-memory: N proposal(s) open, M expiring within 7 days — run hm review`). No review text ever reaches the model's context.

### `autonomy_level`

`standard` (default) — the table above. `shadow` — decisions are only logged to `audit_log` (`auto_activation_shadow`); nothing activates. `off` — `decideTier` never activates anything.

## What gets injected, when

| trigger | Claude Code hook | what | budget |
|---|---|---|---|
| `session_start` | `SessionStart` | active rows with `session_start` in their triggers and type baseline / `decision` / `architecture_constraint` / `workflow`; plus the daily digest `systemMessage` | 5 items / 3 KB |
| `before_model` | `UserPromptSubmit` (once per user turn) | baseline rows always; other rows when their scope intersects path tokens in the prompt (or the last touched file) **and** BM25 over summary / details / aliases ≥ `before_model.min_score` — or, with the embedding helper, cosine ≥ 0.80; then, when `recall.enabled` is on, up to `before_model.recall.max_items` summaries of past episodes from other sessions (`[harness-memory] RECALL <date>: …`, BM25 over `snapshot/recall.v1.json` ≥ `before_model.recall.min_score`, plain context, never enforced) | 5 items / 3 KB (+ 2 items / 1 KB recall) |
| `before_tool` | `PreToolUse` | the ladder above | 3 items / 2 KB |
| `after_tool` | `PostToolUseFailure` | `failure_index[failure_class]` hints (e.g. memories about `enoent` on this tool) as `additionalContext` | 2 items / 1 KB |

`before_tool` in detail: the hook canonicalizes the tool (`Bash` / `PowerShell` → `bash`, `Edit` / `MultiEdit` / `NotebookEdit` → `edit`, `WebFetch` → `fetch`, `mcp__server__tool` → `mcp:server/tool`), picks the target (`command`, `file_path`, `url` or the MCP input JSON) and the path-like tokens in it, reads the ledger tail to learn what already fired this turn, then filters the snapshot: status and TTL → trigger → `relevant_tools` → signature match (`cmd` patterns match on the canonical command form: `npm test` ≡ `npm run test` ≡ `& npm.cmd test`, while the family forms `pm test` / `bin vitest` cover every package manager / runner; `glob` / `regex` / `substring` on the target) or, for signature-less `policy` / `pitfall` rows, scope regex × path tokens → derived policy rules → ranking by enforcement, signature match, human first, score → quotas (policy 2, pitfall 2, workflow 1) → budget. Rows imported from a file the host already loads (`CLAUDE.md`, `CLAUDE.local.md`) are skipped at `session_start` / `before_model` so nothing is said twice. `hm memory:why --tool bash --target "npm test"` runs exactly this function and prints every activation and suppression reason.

## Embeddings (optional)

Dense retrieval is **off by default** and never on the `PreToolUse` path. When you want it for `before_model`:

```bash
hm install --host claude --with-embeddings   # npm install @xenova/transformers in the package root, embeddings.enabled = true
```

`--with-embeddings` runs `npm install @xenova/transformers` inside the installed package directory (for a global install `$(npm root -g)/harness-memory`), which also pulls that manifest's devDependencies: about 350 MB and 17 s on a fast machine, measured on the rc tarball. It needs write access there — a `sudo`-installed prefix refuses (`installed with problems`; the hooks are registered all the same); then install the dependency next to the package instead, `npm install -g @xenova/transformers` (with `sudo` if that prefix needs it; Node resolves it from the parent `node_modules`), and set `embeddings.enabled: true` in `config.json`. Never run `hm install` itself with `sudo`: it would leave root-owned files in the project. The next package upgrade drops the in-package copy, so run `hm install --host claude --with-embeddings` again afterwards. A leaner, upgrade-proof location under `~/.harness-memory/` is planned for 0.6.1.

- A small **helper process** (`dist/embed-helper.js <root>`) serves top-k queries over a Windows named pipe (`\\.\pipe\harness-memory-embed-<repo_hash>`) or a Unix socket `harness-memory-embed-<repo_hash>.sock` in `$XDG_RUNTIME_DIR` (else the temp directory) — never under the repository, so a deep checkout stays below the Unix socket path limit; `hm doctor` prints the path. The `prompt` hook asks it with a `before_model.dense_timeout_ms` (80 ms) budget and falls back to lexical-only when it does not answer; the first miss spawns the helper detached (throttled to once per 60 s). It loads `snapshot/dense.v1.bin`, reloads when that file changes, and **exits by itself** after `embeddings.idle_exit_minutes` (15) of inactivity or on SIGTERM. There is no installed service and no fixed port.
- Model: `Xenova/multilingual-e5-small` (quantized), cached under `~/.harness-memory/models` (`embeddings.cache_dir`). The download happens once, only when embeddings are enabled and the model is absent; it is the only network access besides your own extraction CLI.
- The worker embeds new rows right after extraction (`passage:` prefix) and `hm dream` backfills the rest; `dense.v1.bin` is only written when at least one row has an embedding.
- **Korean and other aliases need no embeddings:** the extractor emits up to eight `aliases` per fact (in the user's language when the prompt was not English), and the lexical snapshot indexes them with a code-aware, Hangul-particle-stripping tokenizer, so a Korean prompt reaches an English memory through BM25.

## Configuration

`.harness-memory/config.json` (schema `config.v1`). Unknown keys are ignored and invalid values fall back to the defaults, so a bad config never breaks a hook.

| key | default | meaning |
|---|---|---|
| `autonomy_level` | `standard` | `off` / `shadow` / `standard` (see above) |
| `before_tool.max_items` / `max_bytes` | 3 / 2048 | injection budget at `PreToolUse` |
| `before_tool.auto_enforcement` | `advise` | where correction / failure-derived auto pitfalls with a signature are born (`advise` or `soft_deny`) |
| `before_tool.auto_escalation.enabled` / `sessions` | true / 2 | the autonomy ladder: an auto `advise` pitfall becomes `soft_deny` once its evidence spans this many sessions |
| `before_tool.hard_policy` | `confirm` | default for hard human policies with a signature (`confirm`, `advise`, `deny`) |
| `before_model.max_items` / `max_bytes` | 5 / 3072 | injection budget at `UserPromptSubmit` |
| `before_model.min_score` | 0.35 | normalized BM25 threshold (`s / (s + 1)`) for non-baseline rows |
| `before_model.dense` | `helper` | `helper` (use the embedding helper when `embeddings.enabled`) or `off` |
| `before_model.dense_timeout_ms` | 80 | how long the prompt hook waits for the helper |
| `before_model.recall.max_items` / `max_bytes` / `min_score` | 2 / 1024 / 0.5 | recall items appended after the memory items at `UserPromptSubmit` |
| `recall.enabled` / `keep_episodes` | false / 300 | the recall layer (episode summaries, `snapshot/recall.v1.json`, `hm recall`); off by default until it proves useful |
| `session_start.max_items` / `max_bytes` | 5 / 3072 | startup budget |
| `after_tool.max_items` / `max_bytes` | 2 / 1024 | failure-hint budget |
| `extraction.provider` | `auto` | `auto`, `claude`, `codex`, `replay` (`HARNESS_MEMORY_PROVIDER` overrides) |
| `extraction.model` | `null` | `--model` for the headless CLI. `null` makes the claude provider pass the `sonnet` alias (your interactive default in `~/.claude/settings.json` may be a gateway id the headless first-party call cannot reach) and lets codex use its own default |
| `extraction.max_runs_per_day` | 40 | LLM calls per day; correction episodes are exempt |
| `extraction.max_auto_activations_per_day` / `_per_episode` | 10 / 3 | auto activation caps |
| `extraction.timeout_ms` / `probe_timeout_ms` / `lease_seconds` | 120000 / 20000 / 180 | provider wall clock, probe wall clock, episode lease |
| `embeddings.enabled` / `model` / `idle_exit_minutes` / `cache_dir` | false / `Xenova/multilingual-e5-small` / 15 / `null` (= `~/.harness-memory/models`) | embedding helper |
| `dream.interval_hours` | 6 | consolidation cadence (checked at `SessionEnd`) |
| `retention.ledger_days` / `raw_hours` / `audit_days` / `candidate_days` / `proposal_days` | 14 / 24 / 30 / 45 / 30 | garbage collection and expiry |
| `log.debug` / `max_bytes` / `rotations` | false / 5 MiB / 3 | hooks.log verbosity and rotation |

Environment variables: `HARNESS_MEMORY_DISABLE=1` makes every hook exit before reading anything; `HARNESS_MEMORY_DEBUG=1` adds a full JSON detail line per hook call to `logs/hooks.log`; `HARNESS_MEMORY_HOME` relocates `~/.harness-memory`; `HARNESS_MEMORY_CLAUDE_BIN` / `HARNESS_MEMORY_CODEX_BIN` pin the extraction binaries; `HARNESS_MEMORY_PROVIDER` forces a provider.

## CLI reference

Binary `harness-memory`, alias `hm`. Every command accepts `--json` (machine-readable output), `--db <path>` (database file; `<x>/.harness-memory/memory.sqlite` also selects project `<x>`) and `--root <dir>` (project root; default: the nearest ancestor holding `.harness-memory/`, else `.git/`, else the cwd). `hm <command> --help` lists a command's options; `hm --version` prints the version.

Exit codes: `0` ok · `1` error · `2` usage error, unknown command, or a command not in this build · `75` the database lock is busy (another writer holds `locks/db.lock`; retry).

> `hm eval:live` (the live three-arm evaluation) is the only command `hm --help` still marks `(not in this build)`; it prints a one-line explanation and exits 2.

<!-- cli-reference:start -->
| Command | What it does |
|---|---|
| **Install** | |
| `hm install --host claude [--user] [--with-embeddings] [--hook-form auto\|exec\|shell] [--hook-script <path>] [--skip-probe] [--skip-self-test]` | Register the hooks, migrate the database (backup first), build the snapshot, probe the extraction provider and run the hook self-test. `--user` writes `~/.claude/settings.json`; `--with-embeddings` installs `@xenova/transformers` and enables dense retrieval. |
| `hm uninstall [--purge] [--user]` | Remove the hook entries the manifest points at, the `.git/info/exclude` line and the manifest; `--purge` also deletes `.harness-memory/` except `memory.sqlite.bak-v<N>`; `--user` (without a manifest) also strips `~/.claude/settings.json`. |
| `hm doctor [--fix] [--host-debug <path>] [--self-test] [--hook-script <path>]` | Cross-check manifest vs registered hooks, node path, last call per event and p95 from `hooks.log`, database (`quick_check`, `user_version`), snapshot freshness, unreachable memories, queue depth, last extraction, probe, locks, embeddings, Git Bash. `--fix` rewrites moved node / hook paths and rebuilds the snapshot; `--self-test` runs the `session-start` hook once; `--host-debug` counts `finished with status N` lines in a Claude Code debug log. |
| `hm db:migrate` | Apply pending schema migrations under the lock (copies `memory.sqlite` to `.bak-v<N>` first) and rebuild the snapshot. |
| `hm db:rollback [--to <version>] [--yes]` | Restore `memory.sqlite.bak-v<N>` (newest by default) after a y/N confirmation (`--yes` / `-y` when there is no TTY); keeps the replaced file as `memory.sqlite.rollback-<ts>` and removes `.prev` and the snapshot. The next writer migrates forward again — downgrade or `hm uninstall` first. |
| `hm snapshot:rebuild` | Rebuild `snapshot/active.v1.json`, `lexical.v1.json`, `recall.v1.json` when `recall.enabled` (and `dense.v1.bin`) from the database; migrates first when needed. |
| **Status** | |
| `hm status` | One line: `active N (auto M) \| candidates C \| proposals P (E expiring) \| queue Q (waiting: reason) \| last extraction <ago> <status> \| probe <result> \| snapshot fresh\|stale\|missing \| p95 <ms>`, plus a `probe:` hint line when the provider needs attention. Exit 1 when not installed. |
| **Review** | |
| `hm review [--json] [--list] [--keys <a,r,s,p,q>] [--accept-all-kind <kind>]` | Interactive review of proposals, candidates and unconfirmed imports in the order described above (keys `a` / `r` / `s` / `t` / `p` / `q`). Non-interactive paths: `--list` prints the queue without prompting, `--keys` replays a comma-separated key sequence over the queue (scripts, tests), `--accept-all-kind <kind>` accepts every open proposal of one kind (or `import` to confirm all unconfirmed imports), `--json` prints the queue as JSON. |
| `hm proposals:list [--kind <kind>]` | List open proposals. |
| `hm proposals:accept <id> \| --kind <kind> --all` | Accept one proposal, or every open proposal of a kind. |
| `hm proposals:reject <id>` | Reject a proposal (the same claim is skipped for 30 days). |
| **Memory** | |
| `hm memory:list [--status <s>] [--type <t>] [--authority <a>] [--source <k>] [--scope <glob>] [--unconfirmed] [--contested] [--limit <n>]` | List memories — live ones (`candidate`, `active`, `stale`) by default, `--status all` for every status — filtered by type, authority, source kind, exact scope, unconfirmed imports or contested rows (200 rows max by default). |
| `hm memory:show <id>` | Show one memory with its signature, scope, authority, enforcement, counters and TTL. |
| `hm memory:add --type <t> --summary <text> [--scope <glob>] [--details <text>] [--triggers <a,b>] [--signature <spec>] [--tools <a,b>] [--enforce <level>] [--aliases <a,b>] [--policy-subtype <s>] [--confidence <n>] [--importance <n>] [--active]` | Add a human memory (`authority = human`, `source_kind = manual`) — a human candidate for `hm review`, or active right away with `--active`. `--signature` is `tool:target:kind:pattern` (e.g. `bash:command:cmd:npm test`; prefix `!` to negate); triggers, tools and enforcement default from the type and signature. |
| `hm memory:promote <id>` | Promote a candidate (or stale row) to active as a human — the row becomes `human` and loses its TTL. |
| `hm memory:demote <id>` | Demote an active memory. |
| `hm memory:reject <id> [--note <text>]` | Reject a memory, optionally keeping a note. |
| `hm memory:restore <id>` | Restore a rejected / stale / superseded memory to active. |
| `hm memory:enforce <id> <advise\|confirm\|soft_deny\|deny>` | Set the enforcement level (a human edit: the row becomes `human`). |
| `hm memory:history <id>` | Status transitions, provenance and — for one release — the v0.5 dream history from the `legacy_*` tables. |
| `hm memory:export [--out <file>]` | Deterministic SQL dump of the database (same content → identical bytes). |
| `hm memory:export-skill [--out <dir>] [--min-confidence <n>] [--min-importance <n>]` | Export mature memories (confidence and importance at or above the thresholds) as `SKILL.md` files, by default under `.harness-memory/skills`. |
| `hm memory:stats [--since <iso>]` | Counts by status / authority / type, review load per day (gate: ≤ 3), recent auto activations and override distribution over the window (default: the last 7 days). |
| `hm memory:why --tool <name> --target <text> [--input <json>] [--session <key>] [--permission-mode <m>]` | Explain what would fire for a tool call: activated items, suppressed ones with the reason (`signature_mismatch`, `already_fired`, `scope_mismatch`, …) and matching policy rules. `--tool` takes the host name (`Bash`, `Edit`, `mcp__server__tool`) or the canonical one; `--input` passes raw `tool_input` JSON instead of `--target`; `--session` derives "already fired this turn" from that session's ledger; `--permission-mode` simulates `bypassPermissions` / `dontAsk`. |
| `hm memory:trace <id>` | Episodes and extraction runs behind a memory. |
| **Pipeline** | |
| `hm queue [list\|show <id>\|retry <id>\|drop <id>]` | Inspect or edit the extraction queue (`queued`, `leased`, `failed`, `dead` episodes). |
| `hm extract [--now] [--provider <name>] [--dry-run]` | Run the extraction worker in the foreground; `--dry-run` renders the prompts without calling the provider. |
| `hm dream` | Run consolidation now (TTL, expiry, override downgrade, merge proposals, embedding backfill, GC). |
| `hm trace <session_key>` | Ledger timeline of a session: prompts, fired memories, tool calls, failures and resolutions. |
| `hm recall <query> [--limit <n>] [--since <iso>]` | Search past episodes by their summaries — what `before_model` recalls when `recall.enabled` is on: prints date, session (`<host>-<key>`, usable with `hm trace`), kind (`extracted` = the extractor's summary, `derived` = the worker's deterministic one) and summary, newest-relevant first. Reads `snapshot/recall.v1.json` when it is fresh, else the database (and says which). `--since` filters on `closed_at`; the command applies no score threshold. With recall disabled it says so and exits 0. |
| **Import** | |
| `hm import [--from <file>] [--from auto-memory] [--auto-memory] [--include-project] [--memory-dir <dir>] [--yes] [--sync] [--dry-run] [--provider <name>]` | Split `CLAUDE.md` / `AGENTS.md` / `.cursorrules` bullets — or, with `--from auto-memory` (`--auto-memory`), the `type: feedback` notes of Claude Code's auto memory under `~/.claude/projects/<slug>/memory/` (`--include-project` adds `type: project` notes; `--memory-dir <dir>` names the directory when it cannot be derived) — into import episodes, run the extractor with `action = create`, show a confirmation table and insert the confirmed rows as `human` / `import` memories with `source_ref = import:<file>#L<n>` (`import:auto-memory:<file>#L<n>`). Bullets that cannot be typed yet (no extraction CLI) are stored verbatim as `advise` rows and typed later. `--yes` skips confirmation (`import_unconfirmed = 1`, enforcement capped at `advise`, shown in `hm review`); `--sync` stales rows whose bullets disappeared (directory-wide for auto-memory); `--dry-run` previews. Re-runs are idempotent by line hash. |
| **Evaluation** | |
| `hm eval:latency [--local] [--runs <n>] [--threshold <ms>] [--memories <n>] [--large] [--hook-script <path>]` | Spawn `dist/hook.js pre-tool` 50× against a generated 300-memory fixture and report min / p50 / p95 / max; exits 1 when p95 exceeds the budget (default 90 ms, `--threshold`). `--local` measures the installed project instead of a fixture, `--large` adds an informational 2,000-memory pass, `--hook-script` points at another `dist/hook.js`. |
| `hm eval:replay [--scenario <ids>] [--fixtures <dir>] [--keep] [--verbose]` | Replay the recorded ledger fixtures s01–s12 through the real hooks and the worker with the replay provider and check the scenario assertions (needs the repository checkout's `test/fixtures/replay`, or `--fixtures`); exits 1 on any failing check. `--keep` leaves each scenario's temp project on disk. |
| `hm eval:live` | Live three-arm evaluation (markdown only / native auto-memory / harness-memory) — later release. |
<!-- cli-reference:end -->

Names and flags are taken from the dispatcher (`src/cli/registry.ts` and the command modules under `src/cli/commands/`); `test/docs-cli-reference.test.ts` fails when this table and the dispatcher disagree.

## Troubleshooting

**Read `hm status` first.** `active 12 (auto 4) | candidates 3 | proposals 1 | queue 2 (waiting: not_logged_in) | last extraction 3h ago ok | probe not_logged_in | snapshot fresh | p95 61ms` tells you how many rows can fire, what is waiting for review, whether episodes are stuck and why, whether the provider works, whether the hooks read a current snapshot, and how slow `PreToolUse` is. Then `hm doctor`.

| Symptom | What it means / what to do |
|---|---|
| `probe not_logged_in`, `queue N (waiting: not_logged_in)` | The headless `claude -p` is not authenticated (the desktop app's login does not carry over). Run `claude auth login` in a terminal (older CLIs: `claude`, then `/login`); the worker re-probes within ten minutes and drains the queue, or run `hm install --host claude` to re-probe at once. Nothing is lost meanwhile. |
| `probe missing` | No `claude` / `codex` binary found. Install one, or set `HARNESS_MEMORY_CLAUDE_BIN` / `HARNESS_MEMORY_CODEX_BIN`. |
| `probe nested_refusal` | The probe ran inside a Claude Code session (`CLAUDECODE` inherited). Run `hm install` / `hm extract` from a plain terminal. |
| `probe provider_error` | The headless CLI ran but its API call failed; `hm status` and `hm doctor` print the provider's message next to the result (for example `api 404: There's an issue with the selected model …`). Set `extraction.model` in `.harness-memory/config.json` to a model your account can use (the default is the `sonnet` alias) and run `hm install --host claude` to re-probe. |
| `probe invalid_output` / `probe_timeout` | `claude -p --output-format json --json-schema` did not return structured output within `extraction.probe_timeout_ms`. Check `claude -p` in a terminal; a failed result is retried after ten minutes. |
| Nothing fires, `hooks.calls` says `never` for every event | Claude Code is not calling the hooks: check `.claude/settings.local.json` (`hm doctor` compares it to the manifest), that you opened Claude Code *in this project*, and the node path (`install.node`). `hm doctor --self-test` runs the hook exactly as Claude Code would. |
| `install.node FAIL` / `install.hook_script FAIL` | The recorded node binary or `dist/hook.js` moved (nvm switch, package reinstall, npx cache pruned). `hm doctor --fix`. |
| `snapshot stale` for more than a minute | Hooks saw a database newer than the snapshot and requested a reindex (`snapshot/.reindex-requested`, throttled to one per 60 s) but `node dist/worker.js <root> reindex` did not run — look at `logs/worker.log`, or run `hm snapshot:rebuild`. |
| `queue` grows, `dead` episodes in `hm doctor` | Three failed attempts (1 h / 6 h back-off) make an episode `dead`; `hm queue show <id>` has `last_error`, `hm queue retry <id>` requeues it. |
| exit code `75` | Another writer holds `locks/db.lock` (worker or CLI). Retry; a stale lock (heartbeat > 120 s or dead pid) is taken over automatically and reported by `hm doctor` (`locks.db`). |
| `database … is newer than this build` | The database was migrated by a newer harness-memory; upgrade the package. Hooks and read-only commands keep working. |
| Memories fire too often / wrong memory | `hm memory:why --tool bash --target "<command>"` explains every suppression; `hm memory:enforce <id> advise` lowers a row; an auto row overridden three times downgrades itself. |
| A `confirm` policy never asks | Under `permission_mode` `bypassPermissions` / `dontAsk` there is nobody to ask, so `confirm` becomes `soft_deny` (`delivery = before_downgraded` in the `fired` line). |
| Windows: Claude Code shows a `PowerShell` tool | Git Bash is absent; memories still match (canonical `bash`). `hm doctor` reports `env.git_bash`. |
| `hm: command not found` / `'hm' is not recognized` after `npm install -g` | The npm global prefix is not on PATH (`npm prefix -g`; Windows default `%APPDATA%\npm`, nvm `~/.nvm/versions/node/<v>/bin`, Homebrew `/opt/homebrew/bin`) or the terminal predates the install — open a new one. Meanwhile `node "$(npm root -g)/harness-memory/dist/bin/harness-memory.js"` works. `harness-memory --version` printing `0.5.1` means another Node's global directory wins (`npm ls -g harness-memory` under each Node); `hm` did not exist in 0.5. |
| Windows PowerShell: `hm.ps1 cannot be loaded because running scripts is disabled` | npm's PowerShell shim under the default execution policy (`npm.ps1` fails the same way). Once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or run `hm.cmd` / use Git Bash. The hooks never use the shim. |
| Claude Code shows a hook error on every tool call right after install | Exec-form hooks need Claude Code ≥ 2.1.139 (inferred from release notes); install assumes exec form when `claude --version` cannot be detected. Re-run `hm install --host claude --hook-form shell` (Windows without Git Bash: PowerShell, with the `&` call operator). |
| `probe not_logged_in` although `claude` works in your terminal | The worker runs `claude -p` with an allowlisted environment. The CLI's own auth and routing variables are forwarded (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK` / `USE_VERTEX`, `AWS_*`, `GOOGLE_*`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` / `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`); anything else your login depends on is not. `hm doctor --json` shows the probe detail. |

**`logs/hooks.log`** has one line per hook call:

```text
2026-11-08T12:00:01.234Z pre-tool tool=bash gen=42 activated=1 suppressed=17 decision=deny delivery=before enforcement=soft_deny dur=48ms ok
```

`status` is `ok`, `bad_stdin`, `snapshot_missing`, `disabled`, `not_installed`, `skipped:<reason>` or `error:<code>`; `gen` is the snapshot's `db_generation`. `HARNESS_MEMORY_DEBUG=1` (or `log.debug: true`) adds a JSON line with the full detail (activated ids, suppression kinds, rule hits). Hooks never fail the host: any exception becomes one log line, `{}` on stdout and exit 0. `logs/worker.log` has the worker's lease / extraction / end lines (`lease … waiting=<reason>` names what blocks the queue). `HARNESS_MEMORY_DISABLE=1` in Claude Code's environment turns every hook into an immediate exit when you need to rule harness-memory out.

## Privacy and security

- **No account, no telemetry, no server.** Everything lives in `<project>/.harness-memory/` and `~/.harness-memory/`. The only processes that talk to a network are (1) the extraction CLI you already use — `claude -p` or `codex exec` under your own login, called by the detached worker — and (2) the optional, one-time embedding model download when you enable `--with-embeddings`.
- **What the extractor sees.** For an eligible episode: your prompt text (≤ 4,000 chars), the tool calls of the turn as digests (command text or repository-relative path, ≤ 500 chars), tool output head/tail (2,000 / 1,000 chars) and error text (1,500) for failing and resolving calls, the last assistant message (≤ 2,000), the previous turn's ≤ 12 tool lines when the turn is a correction, and up to 40 existing memories (id, type, status, authority, scope, signature, summary). Never the transcript file, never your file contents beyond what tool output already showed. The call runs with `--tools ""`, all hooks and auto-memory disabled, no session persistence, an allowlisted environment and a cwd outside every repository.
- **Redaction before anything is written.** Ledger lines pass `redactCredentials` first: private key blocks, `sk-ant-…`, `sk-…`, GitHub `ghp_…` / `github_pat_…`, GitLab `glpat-…`, npm `npm_…`, Stripe `sk_live_…` / `sk_test_…`, AWS `AKIA…`, Slack `xox…` / `xapp-…`, Google `AIza…`, JWTs, `Bearer …` and `Basic …` headers, credentials in a URL of any scheme (`postgres://user:pass@`), `curl -u user:pass`, `--password …`, `mysql -p…`, and `KEY=value` / `"key": "value"` / `key: value` assignments whose key names a password, secret, token or API key (`DB_PASSWORD=`, `AWS_SECRET_ACCESS_KEY=`, `accessToken:`) become `<redacted>`; `$VAR` references are kept. The same redaction runs over `scope_refs`, `failure_sig` and `program_token` (capped at 256 chars per token, 4,000 in total) and over the text of imported bullets.
- **Extracted text is scanned** (invisible Unicode and control characters, prompt-injection phrases in English and Korean such as "ignore previous instructions" / "이전 지시를 무시", credential assignments, instructions to conceal or to disobey the user) and facts that mention harness-memory, its commands or memory ids are rejected (V6), so the model cannot write itself a rule through a tool output. The extraction prompt wraps recorded events, the previous turn, the last assistant message and the existing-memory list in data fences and states that fenced content is data, never an instruction; a legacy candidate whose stored text fails the scan can be reinforced but never auto-activates.
- **Hooks are read-only.** They open no database, hold no lock and return exit 0 on every path; their only writes are the ledger, the session state and queue files. `PreToolUse` never emits `allow`, so it can never widen your own permission prompts.
- **Retention.** Ledger segments 14 d, raw provider output 24 h, audit log 30 d, hooks.log 5 MB × 3 — configurable under `retention` / `log`. `hm uninstall --purge` removes it all except the `memory.sqlite.bak-v<N>` backups.

## Upgrading from 0.5

v0.5 was an OpenCode plugin with a different write path (conversation buffer → evidence rows → dream consolidation → human-reviewed promotion). v0.6 keeps your `memory.sqlite` and the five types / four triggers, and rebuilds everything around it:

- `hm install --host claude` migrates `user_version` 9 / 10 / 16 → **22** (migrations 017–022), after copying the file to `memory.sqlite.bak-v<N>`. No memory row is deleted. Every row gets an `authority`: `candidate` rows and auto-promoted rows become `auto`, every other row `human`; v0.5 LLM rows with scope `**/*` and only `before_model` get `needs_scope = 1` and a `fix_scope` proposal (90 d) in `hm review`; the v0.5 dream tables are renamed `legacy_*` (read by `hm memory:history` for one release), template candidates are rejected, duplicate live rows get `merge` proposals.
- OpenCode is **not supported by 0.6.0** (V2 plugin in 0.6.2; Codex hooks in 0.6.1). Remove the v0.5 plugin entry from `opencode.json` (and `.opencode/package.json`, `.opencode/commands/harness-memory-*.md`) yourself; `hm uninstall --purge` removes the legacy `.conversation-buffer.json` / `.dream-extract-state.json` files.
- `hm db:rollback` restores the pre-migration backup; the next writer migrates forward again, so `hm uninstall` first when you mean to go back to 0.5.

Details, the migration table and the old → new command map are in [docs/redesign/upgrade-from-0.5.md](docs/redesign/upgrade-from-0.5.md).

## Roadmap

- **0.6.0** — Claude Code (this release). Gates: `eval:replay` green, `eval:latency` p95 ≤ 90 ms, two weeks of dogfood with ≤ 3 review items per active day and an autonomy regret (rejected auto activations) ≤ 10 %.
- **0.6.1** — Codex host (`.codex/hooks.json`, `apply_patch`, `turn_id`, the `codex exec` provider).
- **0.6.2** — OpenCode V2 plugin (`Plugin.define`, `permission.assert`, context hook).
- **0.7** — global memory sync, auto↔auto merge, heeded-fire inference, snapshot buckets, dropping the `legacy_*` tables.

## Development

```bash
npm install
npm run build            # tsup → dist/hook.js, hook-bundle.js, worker.js, embed-helper.js, bin/harness-memory.js (+ migrations)
npm test                 # vitest
npm run typecheck        # tsc --noEmit
npm run package:verify   # pack, install the tarball into a temp project, run hm install / status / doctor
```

| Directory | Purpose |
|---|---|
| `src/core/` | Shared contracts: vocabularies, ledger / episode / extraction / snapshot / hook types, config, paths, ids, errors, process helpers |
| `src/adapters/` | Hook core (`runHook`), hook I/O, the Claude Code host adapter, session state |
| `src/activation/` | Snapshot reader, `before_tool` / `before_model` / `session_start` / `after_tool` selection, signature canonicalization and matching, tool vocabulary, lexical snapshot, the ActivationEngine |
| `src/dream/` | Ledger, episodes, extraction prompt / schema / validation, providers (`claude`, `codex`, `replay`), reconcile, consolidate, worker |
| `src/promotion/` | `transitionMemory` and the §4.7 edge table, `decideTier` / `enforcementDefault`, proposals, revalidation |
| `src/policy/` | Policy engine (tool + argument signature matching) and rule derivation |
| `src/db/` | Store (lock → load → migrate → transaction → atomic save → snapshot), locks, migrator, migrations 001–022, repositories, snapshot builder |
| `src/memory/` | `MemoryRepository` |
| `src/embed/` | Embedding helper, client and the `dense.v1.bin` codec |
| `src/cli/` | The `hm` dispatcher, shared libs and command modules |
| `src/security/` | Content scanner |

Design documents: [docs/redesign/spec-v0.6.md](docs/redesign/spec-v0.6.md) (Korean, the authoritative design), [docs/redesign/implementation-plan.md](docs/redesign/implementation-plan.md), [docs/redesign/m0-facts.md](docs/redesign/m0-facts.md) (facts measured on a real machine), [docs/redesign/phase-a-notes.md](docs/redesign/phase-a-notes.md) and [docs/redesign/phase-b-notes.md](docs/redesign/phase-b-notes.md) (module APIs). Pages under `docs/product/` and `docs/spec/` describe v0.5 and carry a banner saying so.

Korean README: [README.ko.md](README.ko.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## License

MIT
