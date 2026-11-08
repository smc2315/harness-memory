# harness-memory redesign candidate: operations and robustness

Slug: `operations-robustness`. Angle: design for the ugly cases first. Every failure mode below has a named behavior (F1–F24), every write has one owner, and every "nothing seems to be saved" complaint has a command that answers it.

Host-fact provenance: the fact sheet (`design-candidates/host-hook-facts.md`) was never written, so every hook claim was verified on 2026-11-08 against the Claude Code hooks, CLI, sessions and headless docs (code.claude.com/docs/en/{hooks,cli-reference,sessions,headless}) and the Codex hooks and CLI docs (learn.chatgpt.com/docs/{hooks,developer-commands}); unverifiable items are marked "unverified".

## 1. Angle and principles

1. **The hot path never takes a lock and never opens SQLite.** `PreToolUse` reads one snapshot file and appends to a per-session journal. SQLite writes belong to exactly two owners, the worker and the CLI, which removes the "two processes write one sql.js file" class of bugs (D1) instead of mitigating it.
2. **Append-only until proven useful.** Raw signals go to a per-session JSONL journal (crash-safe, lock-free). Knowledge enters SQLite only after extraction and deterministic reconcile. Evidence is not memory, operationally as well as conceptually.
3. **Atomic or nothing.** sql.js writes whole files, so a save is `write tmp → fsync → rename`, keeping the previous file as `memory.sqlite.prev`; a crash at any instruction leaves the old or the new database, never a torn one.
4. **Every failure is a named behavior, logged in one place.** `logs/hooks.log` and `logs/worker.log` carry one line per invocation with an outcome code; `harness-memory doctor` reads them and names which of F1–F24 happened.
5. **Degrade, do not block.** A missing index, missing headless CLI, slow provider, corrupt journal line or 700 MB transcript each have a defined degraded mode that keeps the agent working and evidence flowing.
6. **Keep what works.** ActivationEngine, security scanner, migrator, audit/file loggers, eval infrastructure and the adapter types stay; changes to them are additive (section 11).

## 2. Architecture: modules, processes, where state lives

### Processes

| Process | Lifetime | Entry | Writes SQLite? |
| --- | --- | --- | --- |
| Hook process (Claude Code, Codex) | one event, < 100 ms target | `dist/hooks/claude-code.js`, `dist/hooks/codex.js` (one bundle each; no sql.js, no transformers) | never |
| OpenCode plugin | OpenCode server lifetime | `dist/plugin/index.js` | never; it spawns the worker like a hook host |
| Worker | detached, one job, hard cap 120 s | `dist/worker/main.js extract|dream|reindex|import` | yes, under `locks/db.lock` |
| CLI | user command | `dist/bin/harness-memory.js` (direct dispatch; the current bin's `spawnSync` doubles Node startup) | yes, under `locks/db.lock` |

Deviation: brief section 4.D proposes lock + load/apply/save *for hook processes*. Here hook processes never write the database; they append to the journal and spawn the worker. Justification: serializing a 10 MB file under a lock cannot fit a 100 ms budget, and Claude Code runs parallel tool calls, so parallel `PostToolUse` processes would contend constantly.

### Module layout (kept decomposition)

- `src/db`: `sqlite.ts`, `migrator.ts` (kept; runs under lock), new `store.ts` (`openStoreForRead`, `withWriteLock`, `saveAtomic`, `verifyHeader`, `recoverFromPrev`), `locks.ts`, migrations 017–019.
- `src/dream`: `journal.ts`, `episodes.ts` (closer, capture moments, failure signatures), `extract.ts` (prompt, provider, validation), `reconcile.ts`, `consolidate.ts` (merge, TTL, expiry, GC), `providers/{claude-code,codex,opencode}.ts`, `schema/extraction.schema.json`. Deleted: `worker.ts` candidate synthesis, `llm-extract.ts`, `ConversationBuffer`, the `dream-extract.ts` gate file.
- `src/activation`: engine kept; new `index-snapshot.ts` (snapshot writer/reader), `signature.ts` (trigger matcher), lazy lexical build.
- `src/promotion`: `tiering.ts` (rules T1–T5) replaces the auto-promoter; `revalidate.ts` keeps `revalidateMemory`, `demoteOnContradiction`.
- `src/policy`: `engine.ts` rewritten to match tool and arguments, new `derive.ts` (production writer for `policy_rules`).
- `src/adapters`: `types.ts` kept and extended (`AdapterBeforeToolInput.toolInput: unknown`, `toolUseId`), new `hook-core.ts` (stateless per-event core), `claude-code.ts`, `codex.ts`, `opencode-adapter.ts` rewritten over `hook-core.ts`.
- `src/security`, `src/audit`, `src/retrieval`, `src/eval`: kept; session summaries are now generated from episodes by the dream pass.
- `src/cli`: new commands in section 10.

### State between invocations (`<project>/.harness-memory/`)

| Path | Owner | Durability rule |
| --- | --- | --- |
| `memory.sqlite`, `memory.sqlite.prev`, `memory.sqlite.bak-v<N>` | worker, CLI | atomic rename; `.prev` rotated only after `PRAGMA quick_check` passes on the new file |
| `cache/activation-index.v1.json` | writer that last saved | regenerated after every save; readers tolerate absence |
| `journal/<host>-<session_id>.jsonl`, `journal/blobs/<event_id>.txt` | hook processes | append-only; one event per line, line ≤ 32 KB, blobs ≤ 256 KB |
| `state/<host>-<session_id>.json` | hook processes | tiny (< 4 KB), written via tmp + rename; holds `turn_index`, `last_scope_ref`, `pending_failures[]`, `transcript_offset`, `episode_open_since` |
| `queue/<episode_ulid>.json` | Stop/SessionEnd hooks write, worker consumes | the files are the queue; ingested into `episodes` |
| `locks/db.lock/`, `locks/worker.lock/`, `locks/reindex.lock/` | whoever acquires | directory locks (atomic `mkdirSync`), `owner.json` inside |
| `logs/hooks.log`, `logs/worker.log`, `logs/hooks-debug.jsonl` | all | size-rotated 5 MB × 3 |
| `config.json`, `install-manifest.json` | install, doctor | explicit, human-editable |
| `worker/` | worker | empty cwd for headless CLI runs (no CLAUDE.md, `.claude/`, `.codex/`) |

Global tier `~/.harness-memory/global.sqlite` keeps the same store discipline with its own lock directory.

### Session identity

`session_key = <host>:<session_id>` (`session_id` from Claude Code or Codex stdin, `sessionID` from OpenCode). Subagent events (Claude Code adds `agent_id`, `agent_type`) are journaled under the parent session with `agent_id` set and excluded from episodes unless `capture.subagents=true`. Two hosts on one repo are two session keys sharing one index.

## 3. Data model

Migrations `017_episodes_and_authority.sql`, `018_policy_rules_v2.sql`, `019_meta_and_evidence.sql`; `PRAGMA user_version = 19`. Existing tables are kept; `dream_evidence_events` and `dream_memory_evidence_links` become read-only history.

```sql
-- 017
ALTER TABLE memories ADD COLUMN authority TEXT NOT NULL DEFAULT 'human'
  CHECK (authority IN ('human','auto'));
ALTER TABLE memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
  CHECK (origin IN ('manual','import','extraction','legacy_dream'));
ALTER TABLE memories ADD COLUMN needs_scope INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN reinforce_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN contradiction_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_reinforced_at TEXT;
ALTER TABLE memories ADD COLUMN source_file TEXT;      -- import provenance
ALTER TABLE memories ADD COLUMN source_hash TEXT;

CREATE TABLE trigger_signatures (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,                 -- canonical vocabulary, section 5
  arg_path TEXT NOT NULL,
  match_kind TEXT NOT NULL CHECK (match_kind IN ('glob','regex','contains')),
  pattern TEXT NOT NULL CHECK (length(pattern) <= 200),
  created_at TEXT NOT NULL);
CREATE INDEX idx_trigger_signatures_tool ON trigger_signatures(tool);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,                -- ULID, time-ordered
  session_key TEXT NOT NULL, turn_index INTEGER NOT NULL,
  opened_at TEXT NOT NULL, closed_at TEXT NOT NULL,
  close_reason TEXT NOT NULL CHECK (close_reason IN ('stop','session_end','precompact','idle','legacy_batch')),
  scope_refs_json TEXT NOT NULL, tools_json TEXT NOT NULL,
  failure_signatures_json TEXT NOT NULL, capture_moments_json TEXT NOT NULL,
  journal_ref TEXT NOT NULL, journal_byte_start INTEGER NOT NULL, journal_byte_end INTEGER NOT NULL,
  event_count INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued','leased','extracted','skipped','dead')),
  lease_until TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  extraction_run_id TEXT);
CREATE INDEX idx_episodes_status ON episodes(status, opened_at);
CREATE INDEX idx_episodes_session ON episodes(session_key);

CREATE TABLE extraction_runs (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT, episode_ids_json TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('ok','invalid_output','suspect','timeout','provider_error','no_provider')),
  facts_total INTEGER NOT NULL DEFAULT 0, facts_accepted INTEGER NOT NULL DEFAULT 0,
  rejections_json TEXT NOT NULL DEFAULT '[]', raw_output_ref TEXT);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('supersede','stale','activate_policy','activate_global','fix_scope')),
  target_memory_id TEXT REFERENCES memories(id), proposed_memory_id TEXT REFERENCES memories(id),
  episode_id TEXT, extraction_run_id TEXT, rationale TEXT NOT NULL, confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','expired')),
  created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT);
CREATE INDEX idx_proposals_status ON proposals(status, created_at);

-- 018
ALTER TABLE policy_rules ADD COLUMN tool TEXT;          -- canonical tool or NULL = any
ALTER TABLE policy_rules ADD COLUMN arg_path TEXT;
ALTER TABLE policy_rules ADD COLUMN match_kind TEXT CHECK (match_kind IN ('glob','regex','contains'));
ALTER TABLE policy_rules ADD COLUMN pattern TEXT;
ALTER TABLE policy_rules ADD COLUMN derived_at TEXT;    -- NULL = fixture/manual rule

-- 019
CREATE TABLE memory_evidence (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL, event_id TEXT NOT NULL, excerpt TEXT NOT NULL CHECK (length(excerpt) <= 500),
  relation TEXT NOT NULL CHECK (relation IN ('created','reinforced','contradicted')),
  created_at TEXT NOT NULL, PRIMARY KEY (memory_id, event_id));
CREATE INDEX idx_memory_evidence_episode ON memory_evidence(episode_id);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: db_generation, index_generation, installed_version, last_dream_at, last_gc_at
```

Status machines:

- `memories.status`: `candidate → active` (human promote, accepted proposal, auto tier T1–T5); `active → stale` (TTL expiry in the dream pass, auto-tier contradiction, accepted `stale` proposal, `memory:demote`); `active → superseded` (accepted or auto-tier `supersede`); `candidate → rejected` (human, or 30-day expiry); `stale → active` only via `memory:promote --revive`. `authority` flips `auto → human` when a human promotes, accepts or edits, never the reverse.
- `episodes.status`: `queued → leased` (worker sets `lease_until = now + 180 s`) `→ extracted | skipped | queued` (lease expired, F7) `→ dead` after 3 attempts.
- `proposals.status`: `pending → accepted | rejected | expired(30 d)`.

The old `evidence` table remains for manual notes. Provenance for extracted knowledge lives in `memory_evidence`, where `tiering.ts` counts distinct `episode_id` (the count R1 broke).

## 4. Write path: capture → extraction → reconcile → activation

### 4.1 Capture (hook processes, no LLM, no SQLite)

Journal event line (`journal.ts`):

```json
{"id":"01JC...","t":"2026-11-08T09:12:33.120Z","kind":"tool_fail","session_key":"claude:abc","turn":7,
 "agent_id":null,"tool":"bash","host_tool":"Bash","tool_use_id":"toolu_01...","scope_ref":"src/api/route.ts",
 "input":{"command":"npm test"},"input_truncated":false,
 "output_head":"...2 KB...","output_tail":"...1 KB...","output_bytes":48211,"blob":"blobs/01JC....txt",
 "failure_signature":"bash|enoent|src/api/route.ts","duration_ms":4187}
```

Event kinds: `user_prompt`, `tool_ok`, `tool_fail`, `assistant_turn_end`, `session_start`, `session_end`, `compact`. Caps per event: input 4 KB, output head 2 KB + tail 1 KB, blob up to 256 KB, then `truncated=true` (F12). One `appendFileSync` of a line under 32 KB is atomic enough on NTFS and POSIX, so concurrent `PostToolUse` processes need no lock; a torn line is skipped and counted (F6).

Capture moments, detected in the hook process from session state:

- **correction**: a `UserPromptSubmit` whose `prompt` matches the correction lexicon (`/\b(no|not that|don't|do not|never|instead|wrong|undo|revert|stop)\b/i`, Korean `아니|하지 ?마|말고|대신|틀렸|되돌려`), or any prompt following a `tool_fail` in the same turn.
- **resolution**: a `tool_ok` whose `(tool, scope_ref)` matches an entry in `pending_failures` (set by the last `tool_fail`), closing a failure→resolution pair.
- **turn end**: `Stop` (Claude Code, Codex) or `session.idle` (OpenCode) closes the episode.

Failure signature: `<tool>|<class>|<scope_ref>`, class from an ordered regex table (`enoent`, `eaddrinuse`, `timeout`, `assertion`, `type_error`, `exit_<n>`, `permission`, `not_found`, `other`); on Codex, which lacks `PostToolUseFailure`, class is inferred from `tool_response` in `PostToolUse`.

### 4.2 Closing and queueing (Stop, SessionEnd, PreCompact)

`episodes.ts.closeEpisode()` runs in the Stop hook: it reads the journal from `episode_open_since` to EOF (bounded to 4 MB), computes scope set, tool set, failure signatures and capture moments, writes `queue/<ulid>.json` atomically, resets state, and if the episode qualifies spawns `node dist/worker/main.js extract` detached (`stdio` to `logs/worker.log`, `unref()`), exiting 0 in under 50 ms. SessionEnd does the same with `close_reason=session_end` and also spawns `dream`; SessionEnd hooks get 1.5 s by default on Claude Code and 1 s (3 s max) on Codex, so spawn-only is mandatory (F23). PreCompact closes with `close_reason=precompact` without spawning.

Deviation: the brief says "extraction runs per closed episode". Every turn closes an episode, but LLM extraction is gated by `extraction.queuePolicy` (default `signals`): only episodes with ≥ 1 capture moment, ≥ 8 tool calls including an edit, or decision markers in `last_assistant_message` (`decided|we'll use|switch to|from now on`) are queued, and `extraction.maxRunsPerDay` (default 40) bounds cost; episodes beyond the cap are `skipped` (`daily_cap`) and remain inspectable. Justification: a headless call per turn on a chatty session costs minutes of model time and is the main source of garbage facts.

### 4.3 Extraction worker

`worker extract` acquires `locks/worker.lock` (single worker), ingests queue files into `episodes`, leases the 3 oldest `queued` episodes, builds one prompt per batch (≤ 24 KB of journal text per episode) plus the 40 most scope-relevant existing memories (`id`, `type`, `status`, `authority`, `scope_glob`, `summary`) so reinforce/supersede target real ids, and calls the provider with the schema:

```json
{"type":"object","required":["facts"],"additionalProperties":false,
 "properties":{"facts":{"type":"array","maxItems":12,"items":{"type":"object","additionalProperties":false,
  "required":["action","type","summary","details","scope_glob","lifecycle_triggers","confidence","evidence_refs"],
  "properties":{
   "action":{"enum":["create","reinforce","propose_supersede","propose_stale"]},
   "target_memory_id":{"type":"string"},
   "type":{"enum":["policy","workflow","pitfall","architecture_constraint","decision"]},
   "summary":{"type":"string","maxLength":200},
   "details":{"type":"string","maxLength":2000},
   "scope_glob":{"type":"string","maxLength":200},
   "relevant_tools":{"type":"array","items":{"enum":["bash","edit","write","read","grep","glob","web","mcp","other"]}},
   "trigger_signature":{"type":"object","required":["tool","arg_path","match_kind","pattern"],
     "properties":{"tool":{"type":"string"},"arg_path":{"type":"string"},
       "match_kind":{"enum":["glob","regex","contains"]},"pattern":{"type":"string","maxLength":200}}},
   "lifecycle_triggers":{"type":"array","minItems":1,"items":{"enum":["session_start","before_model","before_tool","after_tool"]}},
   "confidence":{"type":"number","minimum":0,"maximum":1},
   "evidence_refs":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"string"}},
   "rationale":{"type":"string","maxLength":400}}}}}}
```

Provider commands (prompt always on stdin, never argv: Windows caps a command line at 8191 characters):

- Claude Code: `claude -p --output-format json --json-schema <schema> --tools "" --max-turns 1 --no-session-persistence --settings '{"disableAllHooks":true}' --model <cfg>`, cwd `.harness-memory/worker/`, env `HARNESS_MEMORY_DISABLE=1`. `--bare` is avoided: the docs say bare mode skips the subscription login and needs `ANTHROPIC_API_KEY`. The result is read from `structured_output`; a missing field is `invalid_output`.
- Codex: `codex exec - --ephemeral --sandbox read-only --skip-git-repo-check --output-schema <schema> -c features.hooks=false --json`, same cwd and env guard; the final message is parsed as JSON.
- OpenCode: existing SDK path behind the same `ExtractionProvider` interface (`probe()`, `extract(prompt, schema, timeoutMs)`).

Every hook entry checks `process.env.HARNESS_MEMORY_DISABLE === "1"` first and exits 0, so a provider run cannot recurse into our hooks (F17). Wall clock cap 120 s (`extraction.timeoutMs`), child killed on expiry; retries at 1, 10 and 60 min, then `dead` (F8). A failed `probe()` (binary missing, `--version` > 5 s) records `no_provider` once per day and leaves episodes `queued` (F9).

Validation (`extract.ts`, per fact, rejection codes recorded): V1 schema; V2 `evidence_refs` must be event ids of the batch's episodes (hallucination check); V3 `scope_glob` must match ≥ 1 episode `scope_ref`, except `**/*`, allowed only for `decision`/`architecture_constraint` and forcing the human gate; V4 `trigger_signature.tool` must be in the episode's tool set; V5 regex must compile, contain no nested quantifiers (`(a+)+` heuristic) and run on a 4 KB sample under 2 ms; V6 `scanMemoryContent` safe; V7 `reinforce`/`propose_*` need an existing `target_memory_id`; V8 non-empty summary; V9 in-batch duplicates collapsed. Breaker (F10): > 12 facts, > 50 % rejected, or non-JSON output marks the run `invalid_output`/`suspect`, keeps the raw output at `worker/raw/<run_id>.txt` for 7 days, and parks the episodes as `skipped` (`suspect_run`) with no automatic retry.

### 4.4 Deterministic reconcile (`reconcile.ts`)

For each accepted fact, in order: RC1 identity match (`identity_key`) → treat as `reinforce`; RC2 near-duplicate (embedding cosine ≥ 0.85 when the worker has the model; otherwise token Jaccard ≥ 0.6 on normalized summaries) → `reinforce`; RC3 `reinforce` → `confidence += 0.05` (cap 0.99), `reinforce_count += 1`, `last_reinforced_at`, `memory_evidence(relation='reinforced')`, and `revalidateMemory()` for auto-tier targets (extends `ttl_expires_at` by 14 days, `validation_count += 1`), which fixes D4; RC4 `propose_supersede`/`propose_stale` against `authority='human'` → `proposals` row, target untouched; against `authority='auto'` with type `pitfall`/`workflow` → applied immediately (`superseded`/`stale`, `contradiction_count += 1`, audit event); RC5 `create` → `MemoryRepository.create` inside try/catch where `DuplicateMemoryContentError` is converted to RC3 (R5), `origin='extraction'`, `status='candidate'`, `trigger_signatures` rows, `memory_evidence(relation='created')` for every `evidence_ref`.

### 4.5 Authority-tiered activation (`tiering.ts`)

A new candidate becomes `active, authority='auto', ttl_expires_at = now + 14 d` when all of T1–T5 hold: T1 type ∈ {`pitfall`, `workflow`}; T2 `scope_glob ≠ '**/*'`; T3 has a `trigger_signature` or `relevant_tools`, and `lifecycle_triggers` includes `before_tool` or `before_model`; T4 evidence: ≥ 2 distinct episodes in `memory_evidence`, or one episode that contains a failure→resolution pair with `confidence ≥ 0.9` (then TTL is 7 d); T5 `scanMemoryContent` safe. Everything else stays `candidate`; `policy` and `**/*` candidates also get a `proposals` row (`activate_policy`, `activate_global`) for the review digest. Dream consolidation (`consolidate.ts`) runs at SessionEnd and on `memory:dream`: it merges near-duplicates, flips auto memories past `ttl_expires_at` to `stale` (the TTL finally runs), rejects candidates older than 30 days, expires proposals, prunes `audit_log` beyond 30 days, deletes journals whose episodes are terminal and older than 7 days, regenerates session summaries, and rewrites the index. It never creates candidates (R6, R7).

Commit: the worker loads the DB under `locks/db.lock`, applies the batch in memory, marks episodes `extracted` with `extraction_run_id`, saves atomically, writes the index, releases. A crash before the save loses nothing: the lease expires and the episode is re-queued (F7), and the provider output is cached at `worker/raw/<episode>.json` for 24 h so the retry does not re-pay.

## 5. Read path

Host event → trigger: `SessionStart → session_start`; `UserPromptSubmit → before_model`; `PreToolUse → before_tool`; `PostToolUse`/`PostToolUseFailure → after_tool` (capture; injection only on failure).

### The activation index

`cache/activation-index.v1.json`: `{generation, builtAt, schemaVersion, memories:[{id,type,summary,details,scope_glob,activation_class,lifecycle_triggers,relevant_tools,signatures:[{tool,arg_path,match_kind,pattern}],confidence,importance,authority,validation_count,ttl_expires_at,last_verified_at,updated_at,created_at,scope_prefix}], rules:[policy rules], buckets:{"<tool>|<scope_prefix>":[memoryIdx...]}, lexical:<MiniSearch.toJSON()>}`, about 2–3 MB for 2000 memories, parsed in 10–20 ms. Only `active`, non-expired memories are included. `SnapshotMemoryRepository` (read-only `list`, `getById`, `listLineageConflicts`) satisfies the engine's repository interface, so ActivationEngine is unchanged.

### `before_tool` matching algorithm (`hook-core.ts` + `signature.ts`)

1. Normalize `tool_name` to the canonical vocabulary: Claude `Bash→bash`, `Edit|MultiEdit|NotebookEdit→edit`, `Write→write`, `Read→read`, `Grep→grep`, `Glob→glob`, `WebFetch|WebSearch→web`, `mcp__*→mcp`; Codex `shell|local_shell→bash`, `apply_patch→edit`; OpenCode names pass through lowercased.
2. Derive `scope_ref`: `tool_input.file_path | path | notebook_path`; for `bash`, the first token of `command` that looks like a relative path inside the repo; else the session's `last_scope_ref`; else `.`. Paths are normalized to forward slashes and made relative to `cwd` (`CLAUDE_PROJECT_DIR` as fallback root).
3. Candidate set = `buckets[tool|prefix] ∪ buckets[tool|*] ∪ buckets[*|prefix] ∪ baseline`, which bounds glob tests to roughly 200 even at 2000 memories.
4. Apply the existing engine filters (`trigger_mismatch`, `scope_mismatch`, `tool_mismatch`), then the new one: if the memory has signatures for this tool, test `pattern` against `tool_input[arg_path]` (`glob` via minimatch, `regex` with the V5-vetted pattern and a 4 KB input cap, `contains` case-insensitive); a hit adds +0.25, a miss on every signature suppresses with the new kind `signature_mismatch`; memories without signatures keep the scope-only score.
5. Policy rules are evaluated by `PolicyEngine.evaluate({lifecycleTrigger, scopeRef, toolName, toolInput})` with the same matcher; warnings are formatted first.
6. Budget for this trigger: `maxMemories: 4`, `maxPayloadBytes: 3072`, via the existing `ActivationRequest` fields. Deviation from the 10 / 8 KB defaults: the tool boundary should be sharp; the defaults still apply at `before_model`.
7. Output (Claude Code): `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"## Tool Warnings ..."}}`; a matched `policy` with `policy_subtype='hard'` adds `permissionDecision:"ask"` and `permissionDecisionReason` (never `deny` by default). Codex lacks `ask` and gets `additionalContext` only; the host caps it at 10,000 characters and we stay under 3 KB.

### Other triggers

- `session_start`: baseline class only, cap 2 KB, via `additionalContext`; `systemMessage` carries a one-line user-facing status only when proposals are pending or doctor flags a problem (nothing reaches the model, D6).
- `before_model`: `startup` mode on a session's first prompt, otherwise `classifyQueryType`; `queryTokens` from `prompt`, `scopeRef` from state; BM25 always, dense only when `retrieval.denseMode='hot'`.
- `after_tool` failure: the top `pitfall` matching the failure class and scope, injected via `PostToolUseFailure.additionalContext`; no evidence rows per activated memory (D7).

### Embedding model policy

`retrieval.denseMode`: `off` | `worker-only` (default for hook hosts) | `hot` (default for the OpenCode plugin, which keeps the model warm). In `worker-only`, the worker computes and stores embeddings for RC2 dedup and dream merging; hook processes never import `@xenova/transformers`, which costs 300–800 ms to load plus seconds for the model.

### Latency plan (PreToolUse, Windows laptop, 2000 memories)

Node start 35–50 ms; single-file hook bundle load 10–15 ms; read + parse index 10–20 ms; bucketed matching ≤ 15 ms; journal append ≤ 3 ms. Target p50 ≤ 80 ms, p95 ≤ 120 ms, measured by `bench:hook` (50 synthetic invocations through the real entry point) with a 150 ms CI ceiling. The lexical index is not built when `queryTokens` is empty (always true at `before_tool`) and is loaded from the snapshot's serialized MiniSearch at `before_model`.

## 6. Authority model

| Memory class | Who activates | Who demotes | TTL |
| --- | --- | --- | --- |
| `pitfall`, `workflow` with scope and trigger, T1–T5 met | tiering, automatically (`authority='auto'`) | dream pass on TTL expiry, auto-tier contradiction, human | 14 d, extended by reinforcement |
| `policy` (any origin) | human only (`review accept`, `memory:promote`) | human; LLM may only file `stale`/`supersede` proposals | none |
| `**/*` scope baseline (any type) | human only | human | none |
| `decision`, `architecture_constraint` | human (candidate + `review`) | human | none |
| Imported bullets (`origin='import'`) | active on import as `authority='human'`, class `baseline` | human; re-import marks removed bullets `stale` | none |

Proposals are the only way the LLM touches `authority='human'` memories. `review` shows the target, the proposed replacement, rationale, confidence and evidence excerpts; `accept` on `supersede` activates the replacement as `authority='human'` and supersedes the target; `accept` on `stale` marks the target stale; `reject` records the decision, and a repeat proposal must carry an `episode_id` newer than `decided_at`. `fix_scope` proposals come from migration (section 11).

## 7. Host adapters

Event mapping (verified fields in backticks):

| Trigger / capture | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| session_start | `SessionStart` (`source`), out `additionalContext`, `systemMessage` | `SessionStart` (`source`), out `additionalContext` | plugin load + first `chat.message` |
| before_model | `UserPromptSubmit` (`prompt`), out `additionalContext` (30 s default timeout) | `UserPromptSubmit` (`prompt`), out `additionalContext` | `experimental.chat.system.transform` |
| before_tool | `PreToolUse` (`tool_name`, `tool_input`, `tool_use_id`), out `additionalContext`, `permissionDecision` allow/deny/ask | `PreToolUse` (same fields), out `additionalContext`, `permissionDecision` allow/deny only (`ask` unsupported) | `tool.execute.before` (args available) |
| after_tool ok | `PostToolUse` (`tool_response`, `duration_ms`), `async: true` | `PostToolUse` (`tool_response`) | `tool.execute.after` |
| after_tool fail | `PostToolUseFailure` (`error`, `is_interrupt`), out `additionalContext` | not available; inferred from `tool_response` | inferred from output |
| turn end | `Stop` (`stop_hook_active`, `last_assistant_message`) | `Stop` (same; matcher ignored) | `session.idle` |
| flush | `PreCompact` (`trigger`), `SessionEnd` (`reason`; 1.5 s default budget, raisable to 60 s) | `PreCompact`, `SessionEnd` (1 s default, 3 s max) | `session.compacted`, process exit |

Hook I/O contract: stdin JSON parsed with a 1 MB cap; parse failure → exit 0 with `outcome=bad_stdin`. Exit code is always 0 (decisions travel in JSON); exit 2 is never used because on Windows without Git Bash any code other than 0 or 2 counts as a hook failure.

Install (`harness-memory install --host claude|codex|opencode|all --scope project|user`):

- Claude Code: writes exec-form entries into `.claude/settings.json` (or `~/.claude/settings.json`): `{"type":"command","command":"<absolute node path>","args":["<abs>/dist/hooks/claude-code.js"],"timeout":5}` for `PreToolUse` (5 s), `UserPromptSubmit` (10), `PostToolUse` (5, `async: true`), `PostToolUseFailure` (5), `Stop` (10), `SessionStart` (5), `PreCompact` (5), `SessionEnd` (1). Exec form needs a real `.exe` and npm's `.cmd` shims need shell form or `node` plus the script path per the docs; calling the signed `node.exe` directly also avoids Windows Smart App Control, which blocks unsigned executables and some Mark-of-the-Web script types (npm-shim behavior unverified). The node path is `process.execPath` at install time; `doctor --fix` rewrites it when it moves (nvm, volta). Alternative distribution: a Claude Code plugin (`.claude-plugin/plugin.json`, `hooks/hooks.json` using `${CLAUDE_PLUGIN_ROOT}/dist/hooks/claude-code.js`, `skills/harness-memory/SKILL.md`) from a marketplace; the hook bundle ships prebuilt with `sql-wasm.wasm`, and `@xenova/transformers` is an optional dependency loaded only by the worker when `denseMode ≠ off`.
- Codex: writes `.codex/hooks.json` (project; loads only when the project `.codex/` layer is trusted) or `~/.codex/hooks.json`, with `command` and `commandWindows` both set to the `node` invocation; registers `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`, `SessionEnd` (timeout 1). Users must trust the hook via `/hooks`; `doctor` prints that step. Codex `transcript_path` is documented as format-unstable and never parsed.
- OpenCode: `opencode.json` plugin entry as today, slash commands, and `.opencode/package.json` dependency; the plugin uses `hook-core.ts`.

Every file the installer touches is recorded in `install-manifest.json` with a hash of our entry, so `uninstall` removes exactly our entries.

## 8. Concurrency and crash safety

Writer protocol (`store.ts`):

```
withWriteLock(dbPath, purpose, waitMs):   // CLI 3000, worker 10000
  acquire locks/db.lock (mkdirSync; owner.json {pid, host, startedAt, purpose})
  bytes = readFileSync(memory.sqlite); verifyHeader(bytes)   // "SQLite format 3\0"
  db = new SQL.Database(bytes); quick_check on open failure → recoverFromPrev
  apply(db); meta.db_generation += 1
  writeFileSync(memory.sqlite.tmp-<pid>, db.export()); fsyncSync
  renameSync(tmp → memory.sqlite) (retry ×5, 20 ms backoff; on EPERM/EBUSY fall back to copyFileSync + warn)
  rotate the old bytes to memory.sqlite.prev before the rename
  writeIndexSnapshot(db) → cache/activation-index.v1.json.tmp → rename
  release lock
```

Named failure modes and behaviors:

- F1 concurrent writers: the second writer polls every 25 ms up to `waitMs`; the CLI then exits 75 (`EX_TEMPFAIL`) with "database busy: <purpose> by pid <n> since <t>"; the worker re-queues itself after 30 s.
- F2 crash mid-save: tmp file is orphaned, `memory.sqlite` is intact; next writer deletes `*.tmp-*` older than 10 min.
- F3 corrupt database (bad header or `quick_check` failure): `recoverFromPrev` restores `.prev`, keeps the bad file as `memory.sqlite.corrupt-<ts>`, logs `recovery`; `doctor` reports the lost generations.
- F4 stale lock: `owner.json` older than 60 s with a dead pid on this host (`process.kill(pid, 0)`), or older than 10 min on another host, is taken over and logged.
- F5 index missing or unparsable: the hook returns empty activation, logs `index_missing`, spawns `worker reindex` under `locks/reindex.lock` (60 s age guard); no hook opens SQLite to compensate.
- F6 torn journal line: skipped and counted; `doctor` shows `journal_bad_lines`.
- F7 worker killed mid-batch: lease expires after 180 s, episode returns to `queued`; `attempt_count` bounds retries at 3.
- F8 slow or hanging provider: child killed at 120 s, run `timeout`, retry schedule 1/10/60 min, then `dead`.
- F9 provider missing: `no_provider` logged once per day, episodes wait, `status` and `doctor` say "N episodes waiting; run `install --provider`".
- F10 garbage extraction: validation codes V1–V9, `suspect` breaker, raw output retained 7 days, no automatic retry.
- F11 700 MB transcript: episodes are built from hook payloads; `transcript_path` is opened only when `last_assistant_message` is absent (older builds), as a tail read bounded by the `transcript_offset` bookmark and 1 MB.
- F12 giant tool output: head/tail excerpt + blob cap + `truncated` flag; blobs GC'd with the journal.
- F13 2000 memories: bucketed index, lazy lexical, serialized MiniSearch, `maxActiveMemories` soft limit 1500 raising a doctor warning, TTL pruning of the auto tier, `memory:gc` purging `rejected` rows older than 90 days.
- F14 Windows rename refused (antivirus scan, open handle): retry, then copy fallback.
- F15 clock skew between hosts: ordering uses ULIDs plus host time; TTL comparisons tolerate 10 min.
- F16 disk full (`ENOSPC`): hooks swallow it and exit 0; the worker aborts before `rename`, so the database is never truncated.
- F17 hook recursion through the headless provider: `HARNESS_MEMORY_DISABLE=1` guard plus `--settings '{"disableAllHooks":true}'` (Claude) and `-c features.hooks=false` (Codex).
- F18 `node` not found or moved: install writes `process.execPath`; `doctor` verifies it exists and `--fix` rewrites.
- F19 database newer than code (`user_version` > 19): read-only mode with "upgrade harness-memory"; hooks still read the index.
- F20 migration failure: `memory.sqlite.bak-v16` is written first; on exception it is restored and the CLI exits 1 naming the migration.
- F21 two hosts on one repo: distinct session keys; shared index; both spawn workers, serialized by `worker.lock`.
- F22 duplicate hook registration (user and project settings both carry our entry): the scanner de-duplicates by `tool_use_id`; `doctor` warns.
- F23 SessionEnd budget: spawn-only, no I/O beyond one queue file and one state write.
- F24 stale in-memory copy in the OpenCode plugin: it keeps a read cache keyed by `statSync(memory.sqlite).mtimeMs + size`, re-reads on change, and routes writes through the worker; the bash-output detection hack is deleted (D1).

Observability for "nothing seems to be saved": every hook writes one line, e.g. `2026-11-08T09:12:33Z PreToolUse claude:abc12 tool=bash scope=src/api/route.ts gen=42 activated=2 suppressed=17 dur=63ms ok`, outcomes `ok | bad_stdin | index_missing | disabled | error:<code>`; `HARNESS_MEMORY_DEBUG=1` adds full JSON to `hooks-debug.jsonl`. `doctor` cross-checks hook registration against the manifest, the node path, last invocation per event, journal size and bad lines, queue depth, the last `extraction_runs` row, the provider probe, lock state, DB `quick_check`, `user_version`, `db_generation` vs index generation and disk usage. Claude Code's `claude --debug` log (`~/.claude/debug/<session-id>.txt`) contains `Hooks: PreToolUse:Bash [...] finished with status 0 (63ms)` lines; `doctor --host-debug <path>` greps them to prove the host ran us.

## 9. Policy engine and rule derivation

`derive.ts.deriveRules(memory)` runs whenever a `policy` memory becomes `active` (promote, accept, import) and in the 018 backfill: one rule per `trigger_signature` (`rule_code = pol:<memory_id>:<sig_index>`, `tool`, `arg_path`, `match_kind`, `pattern`, `scope_glob`, `trigger_kind='before_tool'`) plus one scope-only `before_model` rule when the memory lists that trigger; `severity='warning'`, with `policy_subtype='hard'` driving the `ask` decision. `PolicyRuleRepository.list` already filters rules of non-active memories, so demotion needs no deletion; `deriveRules` rewrites its memory's rows idempotently. Fixture CLIs stay for tests (`derived_at IS NULL`). `PolicyEngine.evaluate` gains `toolName` and `toolInput` and uses `signature.ts`, so rules and memories match through one code path and `memory:why --tool bash --input '{"command":"git push --force"}'` explains both.

## 10. CLI surface and review UX

`harness-memory <command>` (direct in-process dispatch, `--json` everywhere, `--db` optional):

- Setup: `install`, `uninstall [--purge] [--purge-global]`, `doctor [--fix] [--host-debug <path>]`, `bench:hook`.
- Status and review: `status` (one line: `active 212 (auto 61) | candidates 7 | proposals 3 | queue 2 | last extraction 2h ago ok | index gen 42 fresh`), `review` (interactive or `--json`; proposals first, then candidates grouped by type, with evidence excerpts; keys `a`ccept, `r`eject, `e`dit scope, `s`kip), `memory:*` commands kept; `why` gains `--tool`, `--input`.
- Pipeline: `trace <session_key>` (episode timeline: events, capture moments, close reason, queue decision, extraction run, per-fact outcomes), `queue [list|retry <id>|drop <id>|retry-dead]`, `extract [--now] [--provider ...]`, `dream`, `reindex`, `gc`.
- Import: `import [--file CLAUDE.md|AGENTS.md|.cursorrules|MEMORY.md] [--all]`: bullets become `policy` baseline memories (`origin='import'`, `source_file`, `source_hash`); `MEMORY.md` (Claude Code auto-memory under `~/.claude/projects/<project>/memory/`) is imported as `decision`/`workflow` by heading heuristics; re-import marks removed bullets `stale` and never duplicates.

Review is exception handling: nothing is injected for the model; the user sees `systemMessage` "harness-memory: 3 proposals pending, run `harness-memory review`" at `SessionStart` at most once per day (`state/digest.json`).

## 11. Migration from v0.5 databases and from the current module code

Database (runs under `locks/db.lock`, after `memory.sqlite.bak-v16`):

1. 017 adds columns and tables. Backfill: `authority = CASE WHEN promotion_source='auto' THEN 'auto' ELSE 'human' END`; `origin = CASE WHEN id IN (dream links) THEN 'legacy_dream' ELSE 'manual' END`.
2. R2 victims (`scope_glob='**/*' AND lifecycle_triggers='["before_model"]' AND origin='legacy_dream'`) get `needs_scope=1` and a `fix_scope` proposal; human-approved ones stay active but are excluded from `before_tool` until fixed.
3. Legacy template candidates (`summary LIKE 'Pitfall around %'` etc., R6) are `rejected` with reason `legacy_template`; their evidence links stay.
4. Pending `conversation-batch` rows become `episodes` (`close_reason='legacy_batch'`, `journal_ref='legacy:<evidence_id>'`, excerpt copied to `journal/legacy.jsonl`, `status='queued'`) so buffered conversations are extracted once by the new path; other pending/retained/latent rows are `discarded`.
5. 018 backfills `policy_rules` from active `policy` memories; 019 derives `memory_evidence` from `dream_memory_evidence_links` (`relation='created'`) so auto-tier counting works for legacy memories, and prunes `audit_log` to 30 days.
6. `.conversation-buffer.json` and `.dream-extract-state.json` are deleted by `install`/`doctor --fix`.

Code: rewritten — `opencode-plugin.ts` (thin host over `hook-core.ts`), `opencode-adapter.ts`, `policy/engine.ts`, `promotion/auto-promoter.ts` (→ `tiering.ts`), `dream/repository.ts`, `cli/install.ts`, `cli/memory-review.ts`, `cli/memory-health-check.ts` (→ `doctor`), `bin/harness-memory.ts`. Deleted — `dream/worker.ts` candidate synthesis, `dream/llm-extract.ts`, `cli/dream-extract.ts`, `cli/dream-run.ts`, `ConversationBuffer`, the review digest, `isHarnessMemoryCliCall`/`reloadDbFromDisk`, regex `typeGuess`/`topicGuess`. New — `db/store.ts`, `db/locks.ts`, `dream/{journal,episodes,extract,reconcile,consolidate}.ts`, `dream/providers/*`, `activation/{index-snapshot,signature}.ts`, `policy/derive.ts`, `adapters/{hook-core,claude-code,codex}.ts`, `hooks/*.ts`, `worker/main.ts`, CLI `doctor`, `status`, `review`, `trace`, `queue`, `import`, `gc`, `bench:hook`, `uninstall`. Kept — `activation/{engine,fusion,lexical,scope,mode-*}.ts` (plus lazy lexical and `signature_mismatch`), `security/scanner.ts`, `audit/*`, `memory/repository.ts` (plus columns), `retrieval/*`, `eval/*`, migrations 001–016. Existing tests keep passing except those asserting deleted behavior (buffer flush, gate counters, template candidates), replaced by the suites in section 13.

## 12. Defect coverage matrix

| ID | Structural elimination |
| --- | --- |
| R1 | `tiering.ts` counts distinct `episode_id` in `memory_evidence`; RC5 writes those rows in the same batch as the memory and the schema requires `evidence_refs` (`minItems: 1`), so an extracted memory without evidence cannot exist. |
| R2 | `scope_glob`, `lifecycle_triggers`, `relevant_tools` and `trigger_signature` are required or validated schema fields (V3, V4); `**/*` is allowed only for `decision`/`architecture_constraint` and forces the human gate; T2–T3 make scope and trigger preconditions of auto-activation. |
| R3 | No gate counters exist. The queue is a directory of episode files; the worker runs whenever a qualifying episode is queued, serialized by `worker.lock`, bounded by the daily cap. |
| R4 | `reconcile.ts` cannot change the status of `authority='human'` memories; it can only insert `proposals`. Only auto-tier `pitfall`/`workflow` targets are demoted automatically. |
| R5 | `DuplicateMemoryContentError` becomes reinforce per fact; episode marking and fact application are one in-memory batch saved atomically, so on failure nothing is written and the lease retries with the cached provider output. |
| R6 | The regex candidate synthesizer is deleted; the dream pass only merges, expires and prunes. Legacy template candidates are rejected by migration. |
| R7 | There is one input stream (journal → episodes) and one consumer (the extraction worker). `dream` reads `memories` and `proposals`, never episodes. |
| D1 | Hook processes never write SQLite; the OpenCode plugin routes writes through the worker and re-reads on mtime/size change; the bash-output detection hack is gone. |
| D2 | The prompt asks for operating knowledge at lifecycle boundaries, supplying the episode's scope set, tool set and failure signatures; the schema carries scope, tools, trigger signature and lifecycle triggers. |
| D3 | Capture is per turn with semantic moments, 4 KB input / 3 KB excerpt + 256 KB blob per event, 24 KB per episode in the prompt, session attribution by `session_key` on every event. |
| D4 | RC3 calls `revalidateMemory()` for auto-tier targets; the dream pass flips expired memories to `stale`, so TTL and revalidation both actually run. |
| D5 | `PolicyEngine.evaluate` matches tool and argument signatures; `derive.ts` writes `policy_rules` on every policy activation and in the 018 backfill. |
| D6 | No digest is injected into model context; pending proposals surface as a user-facing `systemMessage` once per day and in `status`. |
| D7 | `after_tool` writes nothing to SQLite; the journal line is one append per tool call regardless of how many memories activated. |

## 13. Eval plan

Correctness on the 12-scenario corpus (`research/eval/task-corpus.md`): `eval:replay` drives the real hook entry points with synthetic stdin payloads (each scenario encoded as a `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUseFailure` sequence) under three conditions: markdown-only (existing `eval:baseline`), Claude Code native auto-memory (a `MEMORY.md` fixture with the same facts, injected whole via `additionalContext`), and harness-memory. Metrics: important policy misses, false warnings, stale suppression, conflict surfacing, budget adherence, and `before_tool` precision (scenario 3 must fire on `write` of `.env.local`; scenario 6 must stay silent). Continue threshold: ≥ 30 % fewer important misses than markdown-only and ≥ 20 % fewer than auto-memory, with no increase in false warnings.

Live A/B: `eval:live` runs each scenario as `claude -p` and `codex exec` sessions with and without hooks over a seeded `.harness-memory/`, 3 repetitions each, recording rule violations in tool calls; tables land in `research/eval/output/`.

Operations suites (vitest, CI): crash injection (`SIGKILL` the worker between `writeFileSync(tmp)` and `rename`; `memory.sqlite` must open and `.prev` rotate correctly); concurrency (20 parallel hook processes appending to one journal plus a CLI promote loop; no lost events, no deadlock, EX_TEMPFAIL paths exercised); a sparse 700 MB transcript fixture with `last_assistant_message` absent (bounded read); a 2000-memory fixture with `bench:hook` p95 ≤ 150 ms on the Windows runner; garbage extraction fixtures (non-JSON, 40 facts, hallucinated `evidence_refs`, catastrophic regex) exercising V1–V9 and the breaker; v0.5 database fixtures (R2 victims, pending `conversation-batch` rows) migrated and asserted; hooks invoked via `node` only, never `npx` shims, on the Windows runner.

## 14. Risks, effort estimate, open questions

Risks: (1) Node startup dominates the 100 ms budget on cold Windows disks; the single-file bundle and no-SQLite hot path are the mitigation, measured by `bench:hook`. (2) Headless CLI drift (`--json-schema` output shape, `--settings` hook disabling, Codex `-c features.hooks`); `probe()` plus the `HARNESS_MEMORY_DISABLE` guard hold regardless of flags. (3) Extraction cost on subscription plans; the daily cap and `signals` policy are the levers. (4) Auto-tier false positives at scale; TTL, contradiction demotion and `authority` keep them reversible, and `review` lists recent auto activations. (5) Codex project hooks need `/hooks` trust, which users will miss; `doctor` flags a never-invoked Codex hook. (6) Journal and blob growth on long sessions; capped per event and GC'd after extraction.

Effort (solo developer): M1 store, locks, atomic save, index snapshot, hook entries, `bench:hook` — 2 weeks; M2 journal, episodes, capture moments, queue, worker, providers, schema, validation, reconcile, tiering, dream pass — 3 weeks; M3 signature matcher, policy derivation, Claude Code and Codex adapters, install/uninstall/doctor — 2 weeks; M4 OpenCode port, migrations 017–019 with fixtures, `review`, `status`, `trace`, `import` — 1.5 weeks; M5 eval replay and live A/B, ops test suites, docs — 1.5 weeks. Total 10 weeks.

Open questions: (1) Should `PostToolUse` be `async: true` on Claude Code, given async hooks are killed at `-p` teardown? Capture-only hooks lose nothing except possibly the last events of a `-p` session. (2) Codex `transcript_path` and rollout layout are undocumented in reachable pages; the design avoids them, but Codex failure detection from `tool_response` needs a fixture corpus. (3) Is `permissionDecision: "ask"` for `policy_subtype='hard'` acceptable, or should hard policies stay advisory everywhere? (4) The default extraction model per provider, and whether a `haiku`-class model is good enough for structured extraction. (5) Whether to ship dense retrieval for hook hosts at all in v0.6, or make `worker-only` the only mode until `bench:hook` data exists. (6) The host fact sheet should still be written by the parent workflow; the facts used here were verified independently and may differ from other designers' assumptions.
