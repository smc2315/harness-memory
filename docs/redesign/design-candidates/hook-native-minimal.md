# harness-memory v0.6 design candidate: Hook-native minimalist

Slug: `hook-native-minimal`

**Hook-facts caveat (Deviation 9).** The verified host fact sheet (`design-candidates/host-hook-facts.md`) did not exist when this was written. Hook claims below come from the designer's own knowledge of Claude Code and Codex as of mid-2026; uncertain ones are tagged **(V)** and each has a stated fallback. The final spec must replace (V) items with the fact sheet.

**Measurement basis.** Numbers marked "measured" were taken on the author's machine (Windows 11, Node 24.14, repo `node_modules`, 300 active memories, median wall-clock of 7 child-process runs; script in scratchpad `bench/bench.mjs`).

---

## 1. Angle and principles

Design the smallest system in which a `pitfall` or `policy` extracted from a real episode fires as a warning at `PreToolUse` on Claude Code and Codex, where every hook is a fresh process and nothing stays resident. Every component must be justified by a defect (R1–R7, D1–D7) or a brief requirement; otherwise it is deleted.

1. **The hot path reads one file and loads no engine.** Measured: a bare Node process is 50 ms; sql.js init+open+query adds 54 ms (104 ms total); `import('@xenova/transformers')` alone is 204 ms. A 100 ms budget forbids SQLite, WASM and the embedding model in `PreToolUse`. Hooks read a precomputed JSON snapshot written by whoever last wrote the database.
2. **Episodes are the queue.** No ops log, no buffer file, no gate counter. A turn is one append-only JSONL file; closing it at `Stop` is the only save trigger; a detached one-shot worker consumes it; if the worker dies the file is still there.
3. **One write path, one schema.** Episode → structured extraction → deterministic reconcile → authority-tiered activation. The regex candidate factory, conversation buffer, dream evidence tables and session-count gate are deleted, not repaired.
4. **Authority is a column.** `memories.authority ∈ {human, auto}` decides what the LLM may do: auto memories can be created, reinforced, staled and merged by the pipeline; human memories only receive proposals.
5. **Human judgment happens in the moment.** A user correction inside an episode is the human judgment; it is the strongest evidence and activates a `pitfall`/`workflow` immediately. The review CLI is for exceptions.
6. **Fail open, log to a file.** A hook that throws exits 0 with no output and appends one line to `.harness-memory/hooks.log`. Hooks never exit 2.
7. **Canonical tool vocabulary.** Memories store host-neutral tool names (`bash`, `edit`, `write`, `read`, `grep`, `glob`, `fetch`, `task`, `mcp:<server>/<tool>`); adapters map host names both ways, so a pitfall learned in Codex fires in Claude Code.

Kept unchanged: five types, four triggers, status lifecycle, `ActivationEngine` (hybrid dense+BM25+RRF, scope globs, budgets, type quotas, progressive disclosure, four modes, four classes), security scanner, migrator, audit and file loggers, eval infrastructure, adapter interface types, sql.js/transformers.js/MiniSearch, MIT, no telemetry, no account, no daemon, zero LLM calls per tool call.

---

## 2. Architecture: modules, processes, where state lives

### 2.1 Processes

| Process | Lifetime | Spawned by | Loads | Writes |
|---|---|---|---|---|
| `hook` (`dist/hook.js <event>`) | 50–90 ms | host, per event | snapshot JSON, open-episode tail; MiniSearch only for `prompt`/`session-start` | episode JSONL append, `hooks.log` |
| `worker extract <episode>` | 5–60 s | `hook stop`/`precompact`, detached | sql.js, optional embeddings, host CLI (`claude -p`/`codex exec`) | SQLite under lock, snapshot |
| `worker dream` | 1–10 s | `hook session-end` (next `session-start` on hosts without SessionEnd), detached | sql.js | SQLite under lock, snapshot |
| CLI | interactive | human | sql.js | SQLite under lock, snapshot |
| OpenCode plugin | host lifetime | OpenCode | same core functions in-process; snapshot cached by mtime | same lock discipline; never a resident DB |

"Detached one-shot worker" = `spawn(process.execPath, [...], {detached: true, stdio: 'ignore'}).unref()`; the hook exits at once, the worker exits within a minute. Nothing listens or waits for the next event, so it is not a daemon.

### 2.2 State between hook invocations

| Location | Content | Writer | Reader | Justification |
|---|---|---|---|---|
| `.harness-memory/memory.sqlite` | source of truth | workers, CLI (under lock) | workers, CLI | brief C/D |
| `.harness-memory/active.json` | snapshot: active memories without embeddings, policy rules, precompiled scope regexes, counts | every DB writer, atomic temp+rename after save | every hook | ≤100 ms without sql.js (§5.4) |
| `.harness-memory/episodes/open/<host>-<session_id>.jsonl` | current turn's events | `hook prompt/pre-tool/post-tool/post-tool-failure` | `hook stop/precompact` | brief A, D3 |
| `.harness-memory/episodes/closed/<episode_id>.jsonl` | closed, not yet extracted | `hook stop` (rename) | `worker extract`, `worker dream` (recovery) | crash safety: the file is the queue |
| `.harness-memory/db.lock` | `{pid, host, started_at}` | writers (`wx` create) | writers | D1 |
| `.harness-memory/hooks.log` | one line per hook run (event, ms, outcome) | hooks | human, eval | latency proof, fail-open visibility |
| `~/.harness-memory/global.sqlite` + `global-active.json` | global baseline memories (human only) | CLI `--global` | hooks (second read-only snapshot) | brief 3(c) |

Session identity: Claude Code gives `session_id` in every hook input; Codex gives `session_id` **(V)**; OpenCode gives `sessionID`. The episode file name is `<host>-<sanitized session_id>`. There is no separate session-state file: within-turn state (last failure signature, memories already fired) is derived by reading the open episode file (<100 KB, ~1 ms).

### 2.3 Modules (layout kept, internals rewritten)

| Module | Kept | Rewritten | Deleted | New |
|---|---|---|---|---|
| `src/activation` | engine, modes, fusion, lexical, embeddings, scope | `engine.ts` takes a `MemoryReader` interface (`list`, `getById`, `listLineageConflicts`) instead of `MemoryRepository`; lexical index built lazily only when `queryTokens` exist; signature scoring at before_tool | — | `snapshot-reader.ts` |
| `src/dream` | — | `worker.ts` becomes the detached worker entry (`extract`, `dream`) | regex candidate factory, `repository.ts` (evidence events/runs/links), evidence types | `episode-log.ts`, `extract/{schema,prompt}.ts`, `extract/providers/{claude,codex,opencode}.ts`, `reconcile.ts`, `consolidate.ts` |
| `src/promotion` | `revalidateMemory` | `auto-promoter.ts` → `authority.ts` (`decideTier`, `applyActivation`, `lifecycleSweep`) | 5-gate cycle over the `evidence` table | — |
| `src/policy` | `types.ts`, `repository.ts` | `engine.ts` matches tool + target signature | — | `signature.ts` (shared matcher), `derive.ts` (production rule writer) |
| `src/security` | scanner | — | — | — |
| `src/adapters` | `types.ts` (extended), `test-harness.ts` | `opencode-adapter.ts` thin | plugin-era session tracking | `claude-code.ts`, `codex.ts`, `hook-io.ts`, `tool-vocabulary.ts` |
| `src/db` | migrator, sqlite, schema types | — | — | `migrations/017–021`, `snapshot.ts`, `lock.ts`, `writer.ts` (`withWriteLock`) |
| `src/cli` | list/add/promote/reject/demote/why/stats/export/history/migrate/inspect/eval | `install.ts`, `memory-review.ts` | `dream-extract.ts`, `dream-run.ts`, `dream-runs-*.ts`, `dream-evidence-list.ts`, `fixtures-add-policy-rules.ts` | `doctor.ts`, `proposals-*.ts`, `import.ts`, `episodes-*.ts`, `snapshot-rebuild.ts`, `policy-add.ts` |
| `src/retrieval` | `summary-repository.ts`, `query-router.ts` | — | `summary-generator.ts` | summaries written by `worker extract` from extraction output |
| `src/audit` | logger, file-logger | — | `buffer_*`, `review_digest_shown`, `gate_check` events | `episode_closed`, `extraction`, `reconcile_action`, `proposal` events. **Deviation 8:** hooks write only the file log; `audit_log` rows come from workers and CLI |
| `src/plugin` | — | `opencode-plugin.ts` shrinks to host wiring | ConversationBuffer, review digest, per-tool-call `embedMissingMemories`, `isHarnessMemoryCliCall`/`reloadDbFromDisk` | — |
| root | — | — | — | `src/hook.ts` single bundled entry (`module.enableCompileCache()` when available) |

Deleted: ~3,700 lines (`opencode-plugin.ts` 1,467, `dream/repository.ts` 774, `dream/worker.ts` 680, `dream-extract.ts` 333, `summary-generator.ts` 264, `auto-promoter.ts` 213). New: ~2,000 lines.

---

## 3. Data model: DDL-level tables and columns, status machines, indexes

Migrations 017–021 follow the existing convention (one SQL file each, `PRAGMA user_version` bump); final `user_version = 21`.

### 3.1 `memories` (017)

```sql
ALTER TABLE memories ADD COLUMN authority TEXT NOT NULL DEFAULT 'human';     -- 'human' | 'auto'
ALTER TABLE memories ADD COLUMN trigger_signature_json TEXT;                 -- §3.6
ALTER TABLE memories ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual';  -- 'manual'|'import'|'extraction'|'legacy'
ALTER TABLE memories ADD COLUMN source_ref TEXT;                             -- 'import:CLAUDE.md' | 'episode:<id>'
ALTER TABLE memories ADD COLUMN evidence_score REAL NOT NULL DEFAULT 0;      -- sum of episode evidence weights
ALTER TABLE memories ADD COLUMN fire_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_fired_at TEXT;
ALTER TABLE memories ADD COLUMN revalidate_after TEXT;                       -- auto memories: TTL checkpoint
UPDATE memories SET authority = CASE promotion_source WHEN 'auto' THEN 'auto' ELSE 'human' END;
CREATE INDEX IF NOT EXISTS idx_memories_status_authority ON memories(status, authority);
```

Existing columns stay. `identity_key` is redefined in code as `sha256(type | normalized(summary) | scope_glob)`; `details` and `lifecycle_triggers` no longer participate (a reworded detail created a new identity: R5's root).

Status machine (states unchanged, edges tightened):

```
candidate ─(human promote | auto tier)─▶ active ─(accepted stale proposal | TTL sweep | auto contradiction)─▶ stale
candidate ─(human reject | 45-day expiry)─▶ rejected
active ─(accepted supersede proposal | auto supersede)─▶ superseded   (replacement becomes active)
stale ─(human promote)─▶ active
```
Only `authority='auto'` rows take the automatic edges; `authority='human'` rows move only through an accepted proposal or a CLI command.

### 3.2 `episodes`, `extraction_runs` (018)

```sql
CREATE TABLE episodes (
  id TEXT PRIMARY KEY,                                  -- ulid
  host TEXT NOT NULL, session_id TEXT NOT NULL,         -- 'claude-code' | 'codex' | 'opencode'
  started_at TEXT NOT NULL, closed_at TEXT NOT NULL,
  close_reason TEXT NOT NULL CHECK(close_reason IN ('stop','precompact','session_end','idle','recovered')),
  scope_refs_json TEXT NOT NULL DEFAULT '[]', tools_json TEXT NOT NULL DEFAULT '[]',
  flags_json TEXT NOT NULL DEFAULT '{}',                -- {correction, failure, resolution, remember, warnings_shown}
  evidence_weight REAL NOT NULL DEFAULT 0,              -- remember 3, correction 2, resolution 2, failure 1
  event_count INTEGER NOT NULL, raw_bytes INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('closed','extracting','extracted','skipped','failed')),
  extraction_run_id TEXT, error TEXT
);
CREATE INDEX idx_episodes_session ON episodes(host, session_id, closed_at);
CREATE INDEX idx_episodes_status ON episodes(status);
CREATE TABLE extraction_runs (
  id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('claude','codex','opencode')), model TEXT,
  started_at TEXT NOT NULL, completed_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('started','completed','failed','invalid_output')),
  input_chars INTEGER NOT NULL, output_json TEXT, facts_count INTEGER NOT NULL DEFAULT 0,
  actions_json TEXT NOT NULL DEFAULT '[]', error TEXT
);
```

### 3.3 `proposals` (018)

```sql
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('create_policy','supersede','stale','activate_global')),
  target_memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,      -- human memory affected
  candidate_memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,   -- new candidate (create_policy/supersede)
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  rationale TEXT NOT NULL, confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','rejected','expired')),
  created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
);
CREATE INDEX idx_proposals_open ON proposals(status, created_at);
CREATE UNIQUE INDEX idx_proposals_one_open ON proposals(kind, target_memory_id, candidate_memory_id) WHERE status = 'open';
```
`open → accepted | rejected | expired (30 d)`. Accepting `supersede` runs `MemoryRepository.supersedeMemory`; `stale` runs `markMemoryStale`; `create_policy` promotes the candidate and calls `derivePolicyRules`; `activate_global` promotes in the global DB.

### 3.4 `evidence` (021 rebuild)

Same columns plus `episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL`, `weight REAL NOT NULL DEFAULT 1`; `source_kind` CHECK widened to `('session','task','file','manual_note','episode','import','reinforce')`; excerpts capped at 500 chars in code. No per-activation rows exist (D7).

### 3.5 `policy_rules` (019)

```sql
ALTER TABLE policy_rules ADD COLUMN tool_pattern TEXT NOT NULL DEFAULT '*';   -- canonical tool glob: 'bash', 'mcp:*'
ALTER TABLE policy_rules ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'any';   -- 'command'|'path'|'url'|'any'
ALTER TABLE policy_rules ADD COLUMN arg_pattern TEXT;                          -- regex source
ALTER TABLE policy_rules ADD COLUMN decision TEXT NOT NULL DEFAULT 'context';  -- 'context' | 'ask'
```

### 3.6 Trigger signature (`memories.trigger_signature_json`)

```json
{ "tool": "bash", "target": "command", "pattern": "^git push( .*)? (--force|-f)\\b", "pattern_kind": "regex" }
```
`target ∈ {command, path, url, any}`, `pattern_kind ∈ {regex, glob, substring}`; globs compile to regex at snapshot build.

### 3.7 Dropped (020) — Deviation 6

`dream_evidence_events`, `dream_runs`, `dream_memory_evidence_links`, `topic_summaries` (never populated). `session_summaries` stays (feeds `temporal`/`cross_session`) and gains `episode_id`.

### 3.8 Snapshot `active.json` (derived)

`{schema, built_at, db_sha256, memories[], policy_rules[], recent_summaries[], counts{candidates, open_proposals}}`. Each memory carries every column the engine reads (`id, type, summary, details≤600, scope_glob, scope_regex, lifecycle_triggers, relevant_tools, trigger_signature, authority, confidence, importance, activation_class, ttl_expires_at, validation_count, promotion_source, created_at, updated_at, last_verified_at, supersedes_memory_id, open_proposal`) but no embeddings; each rule carries `rule_code, memory_id, severity, trigger_kind, scope_glob, scope_regex, tool_pattern, target_kind, arg_pattern, decision, message`. Measured 160 KB at 300 memories, ~1 ms to parse.

---

## 4. Write path: capture → extraction → reconcile → activation, with the extraction JSON schema

### 4.1 Capture (hooks, no DB)

Episode JSONL lines (all with `ts`, `seq`, `session_id`):

| Line | Writer | Fields |
|---|---|---|
| `prompt` | `hook prompt` | `text` (≤4,000), `correction: bool`, `remember: bool` |
| `fired` | `hook pre-tool`/`post-tool` | `memory_ids[]`, `rule_codes[]`, `tool`, `target` |
| `tool_ok` | `hook post-tool` | `tool_use_id`, `tool`, `canonical_tool`, `input_summary` (command or path, ≤500), `scope_ref`, `output_head` (≤1,000), `output_tail` (≤500), `resolution_of: tool_use_id\|null` |
| `tool_fail` | `hook post-tool-failure` (Codex: derived in `post-tool` from `tool_response` **(V)**) | same as `tool_ok` plus `error` (≤1,500), `failure_sig` = `canonical_tool\|target\|first error line, digits stripped` |

Correction detection in `hook prompt`: the previous line is `tool_fail`, or the text matches a small bilingual lexicon (`don't|do not|never|stop|instead|wrong|아니|하지 마|말고|대신|틀렸`). Remember: `remember|from now on|기억|앞으로`. Resolution in `hook post-tool`: an earlier `tool_fail` with the same `canonical_tool` and target (path, or command up to its first flag) → `resolution_of`.

Closing (`hook stop`, `hook precompact`, OpenCode `session.idle`): rename `open/…` → `closed/<ulid>.jsonl`, prepend a `header` line (`episode_id, host, session_id, transcript_path, cwd, close_reason`), compute `evidence_weight`. If weight ≥ 1 or any `fired` line exists, spawn `worker extract`; otherwise move to `skipped/` (deleted by the next dream pass; a `skipped` row is still recorded). That is the entire gate; `minSessions`, `minHours`, `pending ≥ 2` and the gate-state file are gone (R3).

### 4.2 Extraction (worker, one LLM call per eligible episode)

Prompt assembly (`extract/prompt.ts`): header; all `prompt` lines; `tool_fail` lines in full; `tool_ok` lines that resolved a failure in full, others as one-line summaries; `fired` lines as "warnings shown"; the turn's last assistant message from `transcript_path` when readable (Claude Code JSONL walked backwards; Codex rollout **(V)**); existing active/candidate memories whose `scope_glob` overlaps any episode scope (id, type, summary, authority, scope, signature; ≤60); the canonical tool vocabulary; type definitions from `docs/spec/memory-taxonomy.md`. Hard cap 24,000 chars, salience-ordered truncation (corrections and failures last to go). The mem0-style "user preferences" wording is gone (D2).

```ts
interface ExtractionProvider { name: 'claude'|'codex'|'opencode';
  extract(prompt: string, schema: object, opts: { timeoutMs: number }): Promise<{ raw: string; model?: string }>; }
```
`claude`: `claude -p --output-format json --tools ""` with the prompt on stdin **(V `--tools ""`; fallback `--disallowedTools`)**, `--json-schema` when available **(V)**, else schema text in the prompt. `codex`: `codex exec --output-schema <file> -o <out>` **(V)**. `opencode`: existing SDK call. Every provider child gets `HARNESS_MEMORY_WORKER=1`; `hook.ts` exits 0 immediately when it sees that variable, so the nested headless session's hooks never recurse into us. Output is validated by `extract/schema.ts` (hand-written validator, no new dependency); invalid output gets one repair re-prompt, then `extraction_runs.status='invalid_output'`, `episodes.status='failed'`, file kept for `episodes:show`.

### 4.3 Extraction JSON schema

```json
{ "type": "object", "required": ["episode_summary", "facts"],
  "properties": {
    "episode_summary": { "type": "string", "maxLength": 400 },
    "facts": { "type": "array", "maxItems": 8, "items": { "type": "object",
      "required": ["action", "type", "summary", "details", "scope_glob", "lifecycle_triggers", "confidence", "evidence_refs"],
      "properties": {
        "action": { "enum": ["create", "reinforce", "propose_supersede", "propose_stale"] },
        "target_memory_id": { "type": ["string", "null"] },
        "type": { "enum": ["policy", "workflow", "pitfall", "architecture_constraint", "decision"] },
        "summary": { "type": "string", "maxLength": 200 },
        "details": { "type": "string", "maxLength": 1200 },
        "scope_glob": { "type": "string" },
        "relevant_tools": { "type": "array", "items": { "enum": ["bash","edit","write","read","grep","glob","fetch","task","mcp"] } },
        "trigger_signature": { "type": ["object", "null"], "required": ["tool", "target", "pattern", "pattern_kind"],
          "properties": { "tool": { "type": "string" }, "target": { "enum": ["command","path","url","any"] },
                          "pattern": { "type": "string", "maxLength": 300 }, "pattern_kind": { "enum": ["regex","glob","substring"] } } },
        "lifecycle_triggers": { "type": "array", "minItems": 1, "items": { "enum": ["session_start","before_model","before_tool","after_tool"] } },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
        "evidence_refs": { "type": "array", "minItems": 1, "items": { "type": "object", "required": ["seq", "quote"],
          "properties": { "seq": { "type": "integer" }, "quote": { "type": "string", "maxLength": 300 } } } },
        "rationale": { "type": "string", "maxLength": 300 } } } } } }
```
The prompt requires a `trigger_signature` for `pitfall`/`policy` facts tied to a command or path, a `scope_glob` derived from the episode's paths (`**` only when truly project-wide), and quotes that occur verbatim in the input; the validator drops facts whose quote is not a substring of the prompt.

### 4.4 Reconcile (deterministic, `reconcile.ts`), per fact

1. **Sanitize**: `scanMemoryContent`; unsafe → rejected row. Regex patterns compiled in try/catch; invalid or >300 chars → fact dropped.
2. **Resolve target**: missing `target_memory_id` → treat as `create`.
3. **Dedup ladder** for `create`: exact `identity_key` → `reinforce`; token-Jaccard ≥ 0.6 on normalized summaries within same type and overlapping scope → `reinforce` (details merged, longer wins); cosine ≥ 0.88 when the embedding model is available → `reinforce`. `DuplicateMemoryContentError` is caught and converted (R5).
4. **Apply** in one sql.js transaction per episode: `create` → insert with `source_kind='extraction'`, `source_ref='episode:<id>'`, `evidence_score = episode.evidence_weight`, one `evidence(kind='episode')` row, status from `decideTier` (§6). `reinforce` → evidence row, `evidence_score += weight`, `confidence = min(0.99, c+0.05)`, `last_verified_at = now`, `revalidateMemory` for auto memories (D4); a candidate crossing the tier threshold is activated. `propose_supersede`/`propose_stale` → target `auto`: applied now (replacement inherits scope/signature if the fact lacks them); target `human`: `proposals` row, target untouched, supersede replacement inserted as `candidate` with `supersedes_memory_id` (R4).
5. **Commit**: `episodes.status='extracted'`, `extraction_runs` completed, `session_summaries` upsert (`summary_short = episode_summary`, tools, scopes), audit rows; save DB (temp+rename), rebuild snapshot, release lock, delete the episode file. Everything happens on the in-memory database and is exported only after commit, so partial writes cannot leak.

Idempotence: if `episodes.id` from the header already exists as `extracted`, the worker deletes the file and exits.

### 4.5 Activation of what was written

Nothing is injected from the write path. The next hook reads the regenerated `active.json`: a memory created from a correction at 14:02 fires at the next matching `PreToolUse` at 14:03, because scope, triggers and signature now come from the schema, not from hard-coded `**/*` + `before_model` (R2).

---

## 5. Read path: the four triggers, `before_tool` matching algorithm, budgets, latency plan

### 5.1 Trigger mapping on hook hosts

| Trigger | Claude Code event | Mode | Source | Budget | Output |
|---|---|---|---|---|---|
| `session_start` | `SessionStart` | `startup` | snapshot (baseline/startup classes, lexical over repo fingerprint, `recent_summaries`) | 10 / 8 KB | `hookSpecificOutput.additionalContext` |
| `before_model` | `UserPromptSubmit` | `classifyQueryType(prompt)` | snapshot, lazy MiniSearch (11 ms at 300) | 10 / 8 KB | `additionalContext` |
| `before_tool` | `PreToolUse` | `default` + signature | snapshot | **3 / 2 KB** | `additionalContext` **(V)**; `permissionDecision:'ask'` for `decision='ask'` rules; else `systemMessage` fallback |
| `after_tool` | `PostToolUse`/`PostToolUseFailure` | `default` | snapshot | 2 / 1 KB | `additionalContext` |

**Deviation 1:** `before_model` fires once per user turn at `UserPromptSubmit`, not before every model call; Claude Code and Codex expose no pre-inference hook, and in-turn needs are served by `before_tool`/`after_tool`. **Deviation 2:** the dense leg is disabled on the hook hot path (model import alone is 204 ms); it stays in the engine and is used by the worker (dedup, embedding backfill), the CLI and the OpenCode in-process adapter. **Deviation 3:** `before_tool` defaults to 3 memories / 2 KB and `after_tool` to 2 / 1 KB; 8 KB per tool call over a 50-call turn is 400 KB of context. The 10 / 8 KB default remains for the other two triggers.

### 5.2 `before_tool` algorithm (`hook pre-tool`)

```
1 canonical = toolVocabulary.toCanonical(host, tool_name)        // 'Bash'→'bash', 'mcp__github__create_pr'→'mcp:github/create_pr'
2 target    = pickTarget(canonical, tool_input)                   // bash: command; edit/write/read: file_path; fetch: url; else JSON (≤2000)
3 scopes    = scopeRefs(canonical, tool_input, cwd)               // path tools: relative path; bash: path-like tokens; none → ['.']
4 snapshot  = readSnapshot(); schema mismatch or DB newer by >60 s → sql.js fallback, rebuild snapshot once (~105 ms), log
5 fired     = readOpenEpisode().firedKeys                         // `${memory_id}|${canonical}|${target}`
6 rules     = policy_rules where trigger_kind=='before_tool' && glob(tool_pattern, canonical)
              && (global || scopes.some(s => scope_regex.test(s))) && (arg_pattern==null || RegExp(arg_pattern).test(target))
7 memories  = engine.activate({ lifecycleTrigger:'before_tool', scopeRefs: scopes, toolName: canonical, toolTarget: target,
              activationMode:'default', maxMemories:3, maxPayloadBytes:2048 })
              // status/TTL → trigger ∈ lifecycle_triggers → relevant_tools null or ∋ canonical → any scope matches scope_regex
              // → signature present ⇒ must match (tool glob + pattern on target) and scores +0.5 → drop ids in `fired`
              // → calculateMemoryScore (trust multiplier by authority/validation_count) → quotas policy 2 / pitfall 2 / workflow 1 → budget
8 text      = rules first ("- [POLICY/warning] message"), then memories ("- [PITFALL] summary — details≤300")
9 append `fired` line; stdout {hookSpecificOutput:{hookEventName:'PreToolUse', additionalContext:text}} (+ permissionDecision:'ask' if any rule asks)
10 exit 0 always; on throw: log line, no output
```
Step 7's signature test is the structural fix for the wedge: a pitfall with `{bash, command, "^npm test"}` fires only on `npm test` in matching scopes, not on every bash call.

### 5.3 Budgets and fatigue

Per-trigger budgets live in `.harness-memory/config.json`. A memory fired for the same `canonical|target` is not repeated within an episode. `fire_count` is rolled up by the worker; memories with `fire_count ≥ 20` and `evidence_score < 3` are reported as "noisy" by `memory:stats` (no automatic demotion).

### 5.4 Latency plan with arithmetic

| Component | Measured | In hot path? |
|---|---:|---|
| Node process start+exit (empty script) | 50 ms | yes, unavoidable |
| sql.js: require 3 + WASM init 6 + open 1.3 MB 3 + query 15 + loader ≈ 27 | +54 ms (104 total) | **no** (fallback only) |
| `JSON.parse` of 160 KB snapshot | 1 ms | yes |
| `import('minimatch')` | 11.5 ms | **no**: regexes precompiled at snapshot build |
| 300 × `minimatch()` | 8 ms | **no** → 300 × precompiled `RegExp.test` ≈ 1–2 ms |
| MiniSearch import 5 + build 300 docs 11 + search 2 | 18 ms | only `prompt`, `session-start` |
| `import('@xenova/transformers')` (no model) | 204 ms | **never** in hooks |

`PreToolUse` budget: 50 (process) + 1 (stdin) + 1 (snapshot parse) + 2 (scope regex × 300) + 1 (≤50 rule/signature tests) + 1 (open-episode tail) + 1 (format, append, stdout) + 5–8 (compile of the ~300 KB bundle; compile cache on Node ≥ 22 shrinks this) = **62–66 ms**; targets p50 ≤ 70 ms, p95 ≤ 90 ms in-process. Host-side spawn overhead (shell wrapper, Windows Defender) adds 10–30 ms outside our control, which is why the internal target is 70 ms, not 100. `UserPromptSubmit` adds the MiniSearch leg: ≈ 80–85 ms. A CI test (`eval:latency`) spawns `dist/hook.js pre-tool` 50 times against a 300-memory fixture and fails when p95 > 90 ms.

Staleness: a writer renames `active.json` 1 ms after saving the DB; a hook mid-read sees the old consistent file. No partially written state is ever visible.

---

## 6. Authority model: what is automatic, what is gated, how proposals work

`decideTier(fact, episode)` is a pure function in `src/promotion/authority.ts`:

| Condition | Result |
|---|---|
| `type ∈ {pitfall, workflow}` ∧ `scope_glob` ∧ (`trigger_signature` ∨ `relevant_tools`) ∧ `confidence ≥ 0.7` ∧ `evidence_score ≥ 2` ∧ scanner safe | `active`, `authority='auto'`, `revalidate_after = now+30 d`, `validation_count=0`, trust 0.65 |
| same with `evidence_score < 2` (bare failure) | `candidate`, auto-eligible; activates on the next reinforcing episode |
| `type ∈ {decision, architecture_constraint}` | `candidate`; CLI digest only |
| `type = policy` | `candidate` + `proposals(kind='create_policy')` |
| `scope_glob ∈ {'**','**/*'}` with `activation_class='baseline'` | `candidate` + `proposals(kind='activate_global')` |

**Deviation 4:** "enough evidence" is an evidence score (correction 2, resolution pair 2, remember 3, failure 1) rather than a count of episodes, so a single user correction activates a `pitfall`/`workflow` immediately; the correction is the human judgment, captured when it happens.

Automatic lifecycle for `auto`: reinforce extends `revalidate_after` by 30 days and increments `validation_count` (trust 0.65 → 0.80 → 0.95); `propose_stale`/`propose_supersede` from extraction apply at once (contradiction demotion); the dream sweep sets `stale` when `revalidate_after` has passed with no reinforcement and no firing in 30 days (a firing defers the sweep once). Candidates expire to `rejected` after 45 days; proposals expire after 30.

Gated for `human` (manual add, import, accepted proposal, `memory:promote`): the pipeline may only insert a `proposals` row; it never changes status, scope, signature or text. `memory:review` shows proposals first with target, candidate, rationale and episode excerpt; accept applies the transition and derives policy rules; reject records a `manual_note` on the target, and an identical candidate `identity_key` within 30 days is skipped at reconcile. Human memories keep trust 1.0 and win quota slots over auto memories with the same type, scope and signature.

---

## 7. Host adapters: event mapping tables for Claude Code, Codex, OpenCode; hook I/O; install/distribution

### 7.1 Claude Code

| Event | Matcher | Command | Reads | Writes |
|---|---|---|---|---|
| `SessionStart` | `startup\|resume\|clear\|compact` | `hook session-start` | `session_id`, `cwd`, `source` | `additionalContext` (session_start activation); pending migrations + snapshot rebuild if missing (one-time, under lock); optional one-line user-visible `systemMessage` "N proposals await `harness-memory review`", once per session |
| `UserPromptSubmit` | — | `hook prompt` | `prompt`, `session_id` | `additionalContext` (before_model); episode `prompt` line |
| `PreToolUse` | `.*` | `hook pre-tool` | `tool_name`, `tool_input`, `tool_use_id`, `cwd` | `additionalContext` **(V)**; `permissionDecision:'ask'` + reason for `decision='ask'` rules; `fired` line |
| `PostToolUse` | `.*` | `hook post-tool` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id` | `tool_ok` line; after_tool `additionalContext` |
| `PostToolUseFailure` | `.*` | `hook post-tool-failure` | `tool_name`, `tool_input`, `error`, `tool_use_id` **(V)** | `tool_fail` line |
| `Stop` | — | `hook stop` | `session_id`, `transcript_path`, `stop_hook_active` | `stop_hook_active` → exit 0; else close episode, spawn `worker extract` |
| `PreCompact` | `manual\|auto` | `hook precompact` | `session_id`, `transcript_path` | close episode early, spawn worker |
| `SessionEnd` | — | `hook session-end` | `session_id`, `reason` | close open episode, spawn `worker dream` |

`SubagentStop`, `Notification`, `PermissionRequest` are not registered. `install --host claude` writes `.claude/settings.json` (or `~/.claude/settings.json` with `--user`): `{"type":"command","command":"node \"<abs>/dist/hook.js\" pre-tool","timeout":10}` per event (20 s for `stop`/`session-end`). The command is an absolute path to the installed bundle, never `npx` (300–800 ms resolution per call). Plugin distribution: `.claude-plugin/plugin.json` + `hooks/hooks.json` with `"node \"${CLAUDE_PLUGIN_ROOT}/dist/hook.js\" pre-tool"`; `/plugin marketplace add smc2315/harness-memory`, `/plugin install harness-memory`. The plugin ships `dist/` plus the sql.js wasm (660 KB); `@xenova/transformers` is **optional**, installed by `install --with-embeddings` into `~/.harness-memory/node_modules` (its optional `onnxruntime-node` is a 92 MB native binary; without it the worker uses lexical dedup and the engine's lexical leg).

### 7.2 Codex (every row (V) until the fact sheet lands)

| Event | Command | Notes |
|---|---|---|
| `SessionStart` | `hook session-start` | also spawns `worker dream` for leftover episodes (no SessionEnd known to me) |
| `UserPromptSubmit` | `hook prompt` | |
| `PreToolUse` | `hook pre-tool` | `tool-vocabulary.ts`: `shell`/`local_shell`/`exec_command` → `bash`, `apply_patch` → `edit`, … |
| `PostToolUse` | `hook post-tool` | failure derived from `tool_response` (`exit_code != 0` or `error`) → `tool_fail` |
| `Stop` | `hook stop` | transcript from `transcript_path` if present, else newest rollout under `~/.codex/sessions/` matching `session_id` |

Config goes to `~/.codex/hooks.json` (project `.codex/hooks.json` when supported) plus `codex_hooks = true` under `[features]` in `config.toml` if gated. Output contract assumed identical in shape. If Codex `PreToolUse` lacks `additionalContext`, the adapter falls back to `systemMessage`; capture and extraction still work and the wedge degrades to "warn the human" on that host.

### 7.3 OpenCode (third adapter, in-process)

| Plugin hook | Core call | Delivery |
|---|---|---|
| `chat.message` | `prompt` | memories appended in `experimental.chat.system.transform` |
| `tool.execute.before` | `pre-tool` (compute, record `fired`) | **Deviation 7:** no pre-tool context channel exists, so warnings are appended to `output.output` of the same call in `tool.execute.after` |
| `tool.execute.after` | `post-tool`/`post-tool-failure` (failure inferred from output/metadata) | — |
| `session.idle` | `stop` | spawns `worker extract`, detached |
| `session.compacted` | `precompact` | — |

The plugin holds no `Database`. Reads use the snapshot (cached, invalidated by `statSync` mtime); writes use `withWriteLock`. The bash-output grep for our own CLI disappears (D1).

### 7.4 Hook I/O (`adapters/hook-io.ts`)

Read stdin fully with a 2 s guard; parse JSON; on failure exit 0 silently. Write exactly one JSON object to stdout; logs go to the file. Exit code always 0. `HARNESS_MEMORY_WORKER=1` or `HARNESS_MEMORY_DISABLE=1` → exit 0 before touching the snapshot.

---

## 8. Concurrency and crash safety

Writers: `worker extract`, `worker dream`, CLI, OpenCode plugin. Readers: hooks (snapshot only). Protocol (`db/writer.ts`):

```
withWriteLock(dbDir, fn, {waitMs: 5000}):
  acquire : open('db.lock','wx'); write {pid, host, started_at}
            EEXIST → read; pid dead (kill(pid,0) throws) or started_at > 120 s old → unlink, retry; else sleep 50–250 ms jittered until waitMs
  fn(db)  : db = openSqlJsDatabase(memory.sqlite); migrate if user_version < CURRENT; fn runs its transactions
  save    : export → memory.sqlite.tmp-<pid> → fsync → rename over memory.sqlite
  snapshot: buildSnapshot(db) → active.json.tmp-<pid> → rename over active.json
  release : unlink db.lock (in finally)
```
sql.js has no file locking and exports the whole file (1.3 MB at 300 memories, ~3 ms), so the lock serialises load→apply→save for the worker's whole run (seconds); no hook ever waits for it. `memory:review` collects decisions in memory and applies them in one short lock (or every 10 decisions), never holding the lock across a prompt.

| Failure | Effect | Recovery |
|---|---|---|
| Hook killed by host timeout | at most one lost episode line | parser skips a truncated last line |
| Parallel `PostToolUse` hooks append concurrently | interleaved lines | each line is self-contained (`tool_use_id`, `seq`); order is irrelevant |
| Worker dies before DB save | nothing written; file stays in `closed/` | next `worker extract`/`dream` processes it |
| Worker dies after save, before snapshot rename | DB newer than snapshot | hook sees mtime gap > 60 s → sql.js fallback rebuild; next writer rebuilds |
| Worker dies after snapshot, before deleting the file | duplicate work | header `episode_id` already `extracted` → file deleted, no second LLM call |
| Lock holder dies | stale lock | pid liveness + 120 s age |
| Lock wait > 5 s | worker exits without writing | file stays; retried at next close/dream; `hooks.log` line |
| CLI and worker both write | serialised; the later one re-reads the saved file | no lost approvals (D1) |
| Disk full / rename fails | old DB and snapshot intact | error logged, episode retained |

---

## 9. Policy engine and rule derivation

`PolicyEngine.evaluate({ lifecycleTrigger, canonicalTool, target, scopeRefs })` returns warnings for rules where `trigger_kind` matches, `tool_pattern` glob matches the canonical tool, any scope matches `scope_regex` (or the rule is global), and `arg_pattern` is null or tests true on `target` (`target_kind` selects command/path/url/any). `signature.ts` is shared with the activation engine's `trigger_signature` test, so rules and pitfalls cannot drift apart.

Production writer `derivePolicyRules(memory)` (`src/policy/derive.ts`) runs whenever a `policy` memory becomes `active` (promote, import confirmation, accepted `create_policy`) or is edited; `deletePolicyRules(memoryId)` runs when it leaves `active`:

```
rule_code    = 'POL_' + slug(summary, 24) + '_' + sha1(memory.id).slice(0, 4)
severity     = policy_subtype == 'hard' ? 'warning' : 'info'
trigger_kind = first of lifecycle_triggers ∩ ['before_tool','after_tool'], default 'before_tool'
scope_glob   = memory.scope_glob
tool_pattern = trigger_signature?.tool ?? relevant_tools?.join('|') ?? '*'
target_kind  = trigger_signature?.target ?? 'any'
arg_pattern  = trigger_signature ? toRegexSource(trigger_signature) : null
decision     = subtype 'hard' ? config.policy.hard_decision ('context' default, 'ask' opt-in) : 'context'
message      = summary (+ ' — ' + details.slice(0, 200) for 'hard')
```
Rules keep `memory_id`, so `PolicyRuleRepository.list()` keeps hiding rules of inactive memories; the snapshot carries them pre-joined. Hand-written rules without a memory remain possible via `policy:add`. Policies stay warning-first: the only escalation is `permissionDecision:'ask'`, which shows the warning in the permission prompt and leaves the decision to the human; `deny` is never emitted (D5).

---

## 10. CLI surface and review UX

| Group | Commands |
|---|---|
| setup | `install --host claude\|codex\|opencode [--user] [--with-embeddings]`; `doctor` (hook registration, node path, snapshot freshness, lock, p95 from `hooks.log`, provider availability); `db:migrate`; `snapshot:rebuild` |
| memory | `memory:list`, `memory:show`, `memory:add`, `memory:promote`, `memory:reject`, `memory:demote`, `memory:why --trigger before_tool --tool bash --target "git push --force" --scope src/x.ts` (same algorithm as the hook, prints activated/suppressed with reasons), `memory:stats` (fires, noisy memories, auto/human split), `memory:export`, `memory:history` |
| review | `review` (proposals first, then candidates; `a`ccept / `r`eject / `s`kip / `e`dit scope+signature / `p`romote-as-human); `proposals:list\|accept\|reject`; `digest` (one line: `2 proposals, 4 candidates, 1 noisy memory`) |
| capture | `episodes:list`, `episodes:show <id>` (raw lines + extraction output), `episodes:retry <id>`, `extract --episode <path>` (foreground, for debugging), `dream` (foreground sweep) |
| import | `import [--from CLAUDE.md AGENTS.md .cursorrules MEMORY.md] [--yes]` |
| eval | existing `eval:*` plus `eval:latency` |

No review text is ever placed in model context (D6); the only in-session surface is the optional one-line user-visible `systemMessage` at `SessionStart`. The digest is also printed by `doctor` and `review`.

---

## 11. Migration from v0.5 databases and from the current module code

**Database** (automatic, under lock, at first `SessionStart` or any CLI run): migrations 017–021 as in §3. Backfills: `authority` from `promotion_source`; `source_kind='legacy'` for pre-017 rows; v0.5 DreamWorker template candidates rejected in SQL (`status='candidate' AND details LIKE 'Dream consolidation candidate built from recent evidence:%'`, reason row "v0.5 template candidate") (R6 cleanup); legacy LLM candidates (scope `**/*`, triggers `["before_model"]`) stay as candidates, with `review --legacy` offering the `e`dit action; pending `conversation-batch` events are dropped with their table (300-char fragments without scope); `evidence` rows survive the 021 rebuild with `episode_id NULL`; `policy_rules` rows get `tool_pattern='*'` and keep working; `session_summaries` kept. The migrator is unchanged, so an old CLI refusing a newer DB behaves as today.

**Import** (new): `harness-memory import` reads `CLAUDE.md`, `AGENTS.md`, `.cursorrules` and Claude Code's native `MEMORY.md` (`~/.claude/projects/<encoded cwd>/memory/MEMORY.md` **(V path)**), runs each through the extraction schema with `action` restricted to `create`, prints the structured table (type, scope, signature, triggers) and, on confirmation or `--yes`, inserts `active`, `authority='human'`, `source_kind='import'`, `source_ref='import:<file>'` rows (`activation_class='baseline'` for global scope), deriving policy rules. **Deviation 5:** imported memories become active human memories after the confirmation step rather than candidates; the confirmation is the human gate. Re-runs are idempotent via `identity_key`; removed bullets are reported, never auto-staled.

**Code**, ordered so the 315 tests stay green: (1) `MemoryReader` + `SnapshotMemoryReader`, lazy lexical index, signature scoring (existing tests keep running against `MemoryRepository`); (2) `lock.ts`, `writer.ts`, `snapshot.ts`, migrations 017–021; (3) `hook.ts`, `hook-io.ts`, `tool-vocabulary.ts`, `episode-log.ts`, Claude Code adapter; (4) `extract/*`, `reconcile.ts`, `authority.ts`, `worker.ts`; (5) `policy/signature.ts`, `derive.ts`, engine rewrite; (6) CLI additions/deletions, `install`; (7) OpenCode plugin shrink, Codex adapter; (8) delete `dream/repository.ts`, old `worker.ts`, `summary-generator.ts`, `dream-extract.ts`, their tests and `test/zz-repro*.ts` once new tests cover the same defects.

---

## 12. Defect coverage matrix: R1–R7 and D1–D7, each with how the design makes it structurally impossible

| ID | Defect | Structural elimination |
|---|---|---|
| R1 | LLM candidates never auto-promote (evidence count 0) | Promotion reads `memories.evidence_score`, set by every `create`/`reinforce` in the same transaction; no second table can be forgotten. |
| R2 | LLM memories hard-coded `**/*` + `before_model` | `scope_glob`, `lifecycle_triggers`, `relevant_tools`, `trigger_signature` are validated schema fields; `reconcile.ts` has no defaults for them (a fact without `scope_glob` is dropped). |
| R3 | Extraction once per process lifetime | The only gate is "a closed episode with signal exists"; `minSessions`, `lastExtractAt`, the gate file and `dreamExtractRunning` are deleted; each `Stop` spawns its own worker. |
| R4 | LLM supersede/stale removes human memories | Transitions on `authority='human'` rows exist only through `proposals` acceptance in the CLI; `reconcile.ts` maps `propose_*` on human targets to `proposals` inserts. |
| R5 | Duplicate fact throws, batch retried forever | Dedup ladder converts duplicates to `reinforce` before insert; the error is caught; one transaction per episode and idempotent `episode_id` mean no partial writes and no re-runs. |
| R6 | Template-text deterministic candidates | `DreamWorker` deleted; regex survives only as episode salience flags; legacy template candidates rejected by migration 020. |
| R7 | `dream:run` consumes conversation batches | Buffer and evidence-event table are gone; episodes have one consumer (`worker extract`); `worker dream` only reconciles memories and recovers unprocessed files. |
| D1 | Plugin holds DB in memory, overwrites CLI writes | No process holds the database; every write is lock → load → apply → save → snapshot; hooks are read-only on an atomically replaced file. |
| D2 | mem0-style prompt, schema without scope/tools/trigger | §4.3 schema; prompt built from episode structure (paths, tools, failure signatures, warnings shown). |
| D3 | Count-based flush, 300/4000-char truncation, wrong session attribution | Episode = one turn closed at `Stop`/`PreCompact`; excerpts 1,000+500, failures 1,500; identity from the host `session_id` in the file name. |
| D4 | `reinforce` never revalidates | `reinforce` calls `revalidateMemory` and bumps `evidence_score`; only the dream sweep stales by TTL. |
| D5 | Scope-only policy engine; nothing writes rules | `signature.ts` matches tool + target; `derivePolicyRules` runs on every policy activation path. |
| D6 | Review inbox in system prompt | No hook emits review text into `additionalContext`; the digest exists only in the CLI and an optional user-visible one-liner. |
| D7 | 2 KB evidence row per activated memory per call | Hooks cannot write SQLite at all; firing appends a ≤200-byte line, rolled into `fire_count` by the worker. |

---

## 13. Eval plan: how to prove it beats markdown-only and native auto-memory on the 12-scenario corpus

Arms, run live with `claude -p` in a fixture repo per scenario of `research/eval/task-corpus.md` (s01–s12), 5 seeds each: **A** markdown-only (all 30 rules in `CLAUDE.md`, hooks off); **B** Claude Code native auto-memory seeded with the same rules in `MEMORY.md`, hooks off; **C** harness-memory (same `CLAUDE.md` plus hooks; memories from `import`, and for s04/s07/s09/s11 from replaying a recorded prior-session episode through `worker extract`, so the pitfalls are auto memories rather than hand-written fixtures).

Metrics (annotation rubric plus deterministic checks): (1) **important policy miss rate**, primary, continue threshold ≥ 30 % reduction vs A, deterministic where possible (s03: was `.env.local` written with a secret; s06: did the scope mismatch stay silent); (2) **warning precision** = relevant warnings / warnings shown (`fired` lines vs annotations), target ≥ 0.7; (3) **heed rate**, the live question the kill memo asked: given a warning, did the model change the action; (4) **context cost**, bytes of `additionalContext` per turn, C ≤ 25 % of A; (5) **hot-path latency**, p50/p95 of `PreToolUse` from `hooks.log`, gate p95 ≤ 90 ms in-process; (6) **extraction yield** on replayed episodes: facts per episode, % with `trigger_signature`, % auto-activated, % that fire in the matching scenario (R2 in live form).

Also kept: the deterministic replay harness (`eval:memory`) rewired to the snapshot reader so the existing 12 scenario files remain a unit-level regression suite, and a 2-week dogfood on the author's repos with the same `hooks.log`-derived latency and precision numbers (`memory:stats --since 14d`).

---

## 14. Risks, effort estimate (solo developer, weeks), open questions

**Risks.** (a) Hook API drift and unverified facts (`PreToolUse.additionalContext`, `PostToolUseFailure` fields, Codex events and output, `--json-schema`, `--tools ""`, `--output-schema`): each has a fallback, so the risk is degraded delivery, not breakage; the fact sheet must settle them first. (b) Windows spawn overhead (shell wrapper, Defender) can push wall-clock to 100–130 ms when our process is 65 ms; `doctor` reports measured p95, and `hooks.windows_fast_path` registers `PreToolUse` only for `Bash|Edit|Write|MultiEdit`. (c) Nested headless-session recursion if a host strips environment variables; the worker also writes `worker.pid` and `hook.ts` exits when `process.ppid` chains to it. (d) Extraction cost and noise: one `claude -p` per eligible turn; bounded by the eligibility gate and `extract.max_per_hour` (default 12). (e) Warning fatigue: tool-level warnings are more visible than system-prompt text; mitigated by 3 / 2 KB budgets, signature-first ranking, per-episode dedup and the noisy-memory report. (f) `@xenova/transformers` pulls a 92 MB native `onnxruntime-node` optional dependency, straining the zero-native claim; embeddings are optional and default to the WASM backend. (g) Snapshot/DB divergence after a crashed CLI write; bounded by the 60 s mtime check and `doctor`.

**Effort (solo):** engine `MemoryReader` + lazy index + signature scoring 1 w; lock/writer/snapshot + migrations 1 w; hook entry, episode log, Claude Code adapter, latency CI 1.5 w; extraction providers, validator, reconcile, authority 2 w; policy signature + derivation 0.5 w; CLI (review/proposals/import/doctor) 1 w; OpenCode shrink + Codex adapter + dream sweep 1 w; live eval + dogfood fixes 1.5 w. **≈ 9.5 weeks** (range 8–11); a usable Claude Code-only build exists after week 5.

**Open questions.** (1) Does the fact sheet confirm `hookSpecificOutput.additionalContext` on `PreToolUse` for both hosts? If not, is `permissionDecision:'ask'` acceptable as default delivery for `policy_subtype='hard'` given "never hard-block by default"? (2) Codex: exact event list, tool names, failure signalling, `transcript_path`, project-level `hooks.json`. (3) Should an `after_tool` injection also carry before_model-class memories mid-turn when the scope changes, since `before_model` fires only at `UserPromptSubmit`? (4) Is single-correction auto-activation (Deviation 4) acceptable, or should a second episode be required as the review suggested? (5) Keep the global DB and `activate_global` in v0.6, or defer global memory? (6) Should `import` create active human memories after confirmation (Deviation 5) or candidates? (7) Is dropping dense retrieval from the hook hot path acceptable until an opt-in warm embedding sidecar (a daemon, hence outside the default runtime) is designed?

**Deviations, collected:** 1 `before_model` at `UserPromptSubmit` only (§5.1); 2 dense leg off the hook hot path (§5.1); 3 tighter `before_tool`/`after_tool` budgets (§5.1); 4 evidence score instead of episode count (§6); 5 import creates active human memories after confirmation (§11); 6 dream evidence tables, `DreamWorker`, buffer, gate state and heuristic summaries deleted, legacy batches discarded (§3.7); 7 OpenCode warnings delivered in `tool.execute.after` (§7.3); 8 hooks never write `audit_log` (§2.3); 9 no fact sheet, (V) tags with fallbacks (header).
