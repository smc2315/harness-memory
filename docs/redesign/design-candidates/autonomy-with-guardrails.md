# Autonomy With Guardrails: harness-memory v0.6 core redesign

Slug: `autonomy-with-guardrails`. Angle: autonomy-first. Hook claims are taken from vendor documentation fetched on 2026-11-08 (Claude Code `hooks`, `plugins-reference`, `headless`, `sessions`; Codex `hooks`, `non-interactive-mode`; OpenCode `build/plugins/server`), because the host fact sheet was never written. Where a verified fact contradicts brief section 6, it is labelled.

## 1. Angle and principles

Thesis: a strong extraction model is trusted with *what* is worth remembering and *how it is keyed* (type, scope glob, tool signature, lifecycle trigger). It is never trusted with *authority*: it cannot change the status of anything a human approved, cannot activate a behaviour-changing rule, and cannot widen scope to the whole repository without a human. Authority is a column on the memory row, not a step in a workflow, so every mutating code path must check it and the sovereignty rule is testable as an invariant.

- P1 One write path: Episode → Extract → Reconcile → Activate. Regex never creates a memory; it only extracts failure signatures and salience hints.
- P2 Provenance is structural: a fact whose `evidence_refs` do not resolve to events of its episode is rejected before any write.
- P3 Keyed or candidate: a memory that cannot say where (`scope_glob`) and when (lifecycle trigger plus a `trigger_signature` for `before_tool`) it applies cannot be auto-activated.
- P4 Human sovereignty: `authority = 'human'` rows change status only by human action; the machine may annotate (`contested`) and propose.
- P5 Autonomy is bounded and reversible: TTL, trust tier, contradiction budget, daily activation cap, `autonomy_level` kill switch, and a shadow mode that measures autonomy precision before it is switched on.
- P6 The hot path never writes SQLite. Hooks read a snapshot and append JSONL; exactly one writer process at a time owns the SQLite file under a lock.
- P7 Hooks fail open. The only blocking outputs are `deny` from a human-approved policy with `enforcement = 'deny'` and the optional soft-deny (section 6).
- P8 Transcript files are never parsed (both vendors call the format unstable); episodes are built from hook payloads only.

## 2. Architecture: modules, processes, where state lives

| Process | Entry | Role | SQLite |
|---|---|---|---|
| Hook runner | `hm hook <HostEvent>` (`dist/hook.js`), one process per host event | reads stdin JSON, answers on stdout | read-only (snapshot first, SQLite fallback) |
| Worker | `hm worker`, spawned detached from the `Stop` hook (`spawn(..., {detached:true, stdio:'ignore'}).unref()`) | extraction, activation, consolidation, snapshot rebuild | writer, under lock |
| CLI | `hm <cmd>` | review, import, eval, doctor | writer, under lock |
| OpenCode plugin | in-process `Plugin.define` | same core as the hook runner; caches the snapshot keyed by file mtime; spawns the same worker | read-only |

State under `<repo>/.harness-memory/`: `memory.sqlite` (curated store, writer-only); `snapshot/active.json` (compiled read model: active memories, pre-parsed signatures, scope globs, serialized MiniSearch index via `MiniSearch.loadJSON`, policy rules, `source_mtime`); `events/<session_key>.jsonl` (append-only raw signal: prompt, tool_ok, tool_fail, activation, stop); `sessions/<session_key>.state.json` (written only by `UserPromptSubmit` and `Stop`: `turn_key`, `jsonl_offset_at_turn_start`, `correction`); `.writer.lock` (`{pid, startedAt, cmd}`); `config.json` (`autonomy_level`, provider, caps); `harness-memory.log` (FileLogger, kept).

Module map (brief constraint 4 kept). Kept as-is: `activation/{engine,mode-*,fusion,lexical,scope,embeddings,retrieval-helpers}`, `security/scanner`, `audit/*`, `db/{migrator,sqlite,schema}`, `eval/*`, `retrieval/{query-router,summary-repository}`, `memory/repository` (new columns), `policy/repository`, `adapters/types` (extended with `toolCall`, `enforcement`). Rewritten: `dream/llm-extract.ts` → `dream/{extractor,prompt,schema,reconcile,consolidate}.ts`; `promotion/auto-promoter.ts` → `promotion/{activator,authority,proposals}.ts`; `policy/engine.ts` (tool + signature matching); `retrieval/summary-generator.ts` (reads episodes); `plugin/opencode-plugin.ts` (V2 `Plugin.define`; buffer, gates and digest removed); `cli/*` collapsed under one `hm` binary. Deleted: `dream/worker.ts` (DreamWorker, regex typeGuess/topicGuess), `cli/dream-run.ts`, the gate functions of `cli/dream-extract.ts`, `ConversationBuffer`, `buildCandidateDigest`, `isHarnessMemoryCliCall`/`reloadDbFromDisk`. New: `activation/signature.ts` (grammar, parser, matcher), `activation/snapshot-repository.ts`; `dream/{episode-builder,episode-repository,provider}.ts`, `dream/providers/{claude-cli,codex-cli,opencode-sdk}.ts`; `policy/derive.ts`; `security/self-reference.ts`; `adapters/{claude-code-adapter,codex-adapter,tool-normalizer}.ts`; `db/{store,snapshot}.ts` and migrations 017–021; `hooks/` (host-agnostic runner); `cli/{hook,worker,review,proposals,import,install,doctor}.ts`.

## 3. Data model: DDL-level tables and columns, status machines, indexes

Migrations 017–021 (`PRAGMA user_version` 17..21), additive, in the migrator's existing style.

```sql
-- 017_memory_authority_signatures.sql
ALTER TABLE memories ADD COLUMN authority TEXT NOT NULL DEFAULT 'human' CHECK(authority IN ('human','auto'));
ALTER TABLE memories ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual'
  CHECK(source_kind IN ('manual','extracted','imported','migrated'));
ALTER TABLE memories ADD COLUMN enforcement TEXT NOT NULL DEFAULT 'advise' CHECK(enforcement IN ('advise','confirm','deny'));
ALTER TABLE memories ADD COLUMN trust_tier TEXT NOT NULL DEFAULT 'approved'
  CHECK(trust_tier IN ('provisional','validated','approved'));
ALTER TABLE memories ADD COLUMN contradiction_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN contested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN open_proposal_id TEXT;
ALTER TABLE memories ADD COLUMN fire_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN heeded_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_fired_at TEXT;
ALTER TABLE memories ADD COLUMN revalidate_at TEXT;
ALTER TABLE memories ADD COLUMN origin_episode_id TEXT;
ALTER TABLE memories ADD COLUMN status_reason TEXT;  -- 'ttl_expired' | 'contradiction' | 'proposal:<id>' | 'human:<cmd>'
UPDATE memories SET authority = CASE promotion_source WHEN 'auto' THEN 'auto' ELSE 'human' END,
  trust_tier = CASE WHEN promotion_source='auto' AND validation_count=0 THEN 'provisional'
                    WHEN promotion_source='auto' THEN 'validated' ELSE 'approved' END;
CREATE INDEX IF NOT EXISTS idx_memories_status_authority ON memories(status, authority);

CREATE TABLE IF NOT EXISTS trigger_signatures (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tool_pattern TEXT NOT NULL,          -- 'Bash', 'Edit|Write', 'mcp__*__query'
  arg_path TEXT NOT NULL,              -- '$.command', '$.file_path', '$.pattern', '$.url', '$.*'
  match_kind TEXT NOT NULL CHECK(match_kind IN ('cmd','glob','regex','contains','exact')),
  pattern TEXT NOT NULL,
  negate INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL CHECK(created_by IN ('llm','human','import')),
  fire_count INTEGER NOT NULL DEFAULT 0,
  override_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trigger_signatures_memory ON trigger_signatures(memory_id);

-- 018_episodes.sql
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,                 -- sha(host:session_id:turn_key)
  host TEXT NOT NULL CHECK(host IN ('claude-code','codex','opencode','import')),
  session_id TEXT NOT NULL,
  turn_key TEXT NOT NULL,              -- Claude Code prompt_id | Codex turn_id | OpenCode counter
  started_at TEXT NOT NULL, closed_at TEXT,
  close_reason TEXT CHECK(close_reason IN ('stop','precompact','session_end','timeout','import')),
  prompt_excerpt TEXT NOT NULL DEFAULT '',
  scope_set_json TEXT NOT NULL DEFAULT '[]', tool_set_json TEXT NOT NULL DEFAULT '[]',
  failure_signatures_json TEXT NOT NULL DEFAULT '[]', salience_hints_json TEXT NOT NULL DEFAULT '[]',
  correction INTEGER NOT NULL DEFAULT 0, failure_resolved INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  raw_ref TEXT,                        -- events/<session_key>.jsonl:<byte_start>-<byte_end>
  extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(extraction_status IN ('pending','skipped','extracting','extracted','failed')),
  extraction_run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(extraction_status, next_attempt_at);

CREATE TABLE IF NOT EXISTS episode_events (      -- only for episodes that pass the capture gate
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,                -- the 'e<seq>' cited by evidence_refs
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('prompt','tool_ok','tool_fail','assistant_final','legacy_batch')),
  tool_name TEXT, scope_refs_json TEXT NOT NULL DEFAULT '[]',
  args_digest_json TEXT NOT NULL DEFAULT '{}',   -- command (<=400 chars), file_path, pattern, url
  excerpt TEXT NOT NULL DEFAULT '',    -- <=1200 chars head+tail, secrets redacted
  failure_signature TEXT,              -- 'bash:exit1:enoent', 'edit:old_string_not_found'
  PRIMARY KEY (episode_id, seq)
);

-- 019_proposals_provenance_runs.sql
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('supersede','stale','activate_policy','activate_global','merge',
                                    'escalate_enforcement','edit_signature','reactivate')),
  target_memory_id TEXT REFERENCES memories(id),
  replacement_memory_id TEXT REFERENCES memories(id),   -- candidate row for supersede / activate_*
  payload_json TEXT NOT NULL DEFAULT '{}',
  rationale TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',      -- ['<episode_id>#e3', ...]
  confidence REAL NOT NULL,
  created_by TEXT NOT NULL CHECK(created_by IN ('extractor','consolidator','contradiction','import')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','approved','rejected','expired','withdrawn')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, created_at);

CREATE TABLE IF NOT EXISTS provenance_links (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('created_from','reinforced_by','contradicted_by','proposed_by','imported_from')),
  extraction_run_id TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, episode_id, event_seq, relation)
);
CREATE INDEX IF NOT EXISTS idx_provenance_memory ON provenance_links(memory_id, relation);
```

Also in 019: `extraction_runs (id, episode_ids_json, provider, model, prompt_hash, input_chars, started_at, finished_at, status ∈ {started, succeeded, invalid_output, provider_error, timeout}, facts_count, actions_json, error)`, one row per LLM call. `020_policy_rules_signatures.sql` adds `tool_pattern, arg_path, match_kind, pattern, enforcement, signature_id, derived` to `policy_rules`. `021_legacy_evidence_fold.sql` is described in section 11.

Status machine (`memories.status`, unchanged vocabulary):

```
candidate --(Activator gate pass | human promote)--> active
candidate --(30d expiry | human reject)-----------> rejected
active    --(TTL expiry, auto only)---------------> stale      status_reason='ttl_expired'
active    --(contradiction budget, auto only)-----> stale      status_reason='contradiction'
active    --(approved proposal kind=stale)--------> stale      status_reason='proposal:<id>'
active    --(approved supersede | auto replacement activates)--> superseded
stale     --(reinforce evidence, auto only | human reactivate)--> active
```

Deviation: `proposed` is not a status. A human memory under an open proposal stays `active` with `contested = 1` and `open_proposal_id`, so the LLM can never hide human knowledge by proposing against it, and the engine's `DEFAULT_ACTIVE_STATUSES` is untouched. Episode status: `pending → extracting → extracted | failed`, or `pending → skipped` (kept for repeat-failure counting). Proposal status: `open → approved | rejected | expired (30 d) | withdrawn` (target changed before the decision).

## 4. Write path: capture → extraction → reconcile → activation

### 4.1 Capture (hooks: no LLM, no SQLite writes)

Each hook appends one JSON line to `events/<session_key>.jsonl` (`session_key = sha1(host + ':' + session_id).slice(0,16)`):

```json
{"t":"2026-11-08T10:02:11.120Z","k":"tool_fail","turn":"p_8f3","tool":"Bash","scope":["src/api/route.ts"],
 "args":{"command":"npm test"},"sig":"bash:exit1:enoent","dur":1820,"agent":null,
 "excerpt":"> vitest run\nError: ENOENT: no such file ... fixtures/seed.json"}
```

Kinds: `prompt` (≤ 2 KB, `correction` flag), `tool_ok`, `tool_fail`, `activation` (`{trig, tool, fired:[ids], sig:[ids], suppressed:{kind:count}, ms}`), `stop` (`last_assistant_message` ≤ 2 KB). `failure-signature.ts` derives `tool:exitcode|class:token` from `tool_response`/`error` (families: enoent, eaddrinuse, econnrefused, timeout, assertion, type_error, module_not_found, permission, nonzero exit, generic). Credential patterns from `scanMemoryContent` are replaced with `<redacted>` before the line is written. `correction-detector.ts` runs at `UserPromptSubmit`: a lexicon with negation guards (`don't|do not|never|stop|instead|wrong|아니|하지 마|말고|대신`), or a short prompt (< 240 chars) after a turn that ended in an unresolved `tool_fail`. It is a hint for the extractor, never an activation gate by itself.

### 4.2 Episode close and extraction gate

The `Stop` hook (`PreCompact`/`SessionEnd` only write a flush marker) slices the session JSONL from `jsonl_offset_at_turn_start`, builds an `EpisodeDraft` (`episode-builder.ts`: scope set, tool set, failure signatures, `failure_resolved` = a `tool_fail` with signature S followed later in the turn by `tool_ok` of the same tool family on an overlapping scope, `salience_hints` from the kept regex tags applied to the prompt and `last_assistant_message` only), spawns the worker, and exits 0 in ~50 ms. The worker's deterministic capture gate persists `episode_events` and marks `pending` when `correction = 1`, or `failure_resolved = 1`, or (`event_count ≥ 3` and a salience hint), or the failure signature already appeared in ≥ 2 `skipped` episodes within 14 days (repeat failures without resolution are pitfalls too). Otherwise the episode is `skipped` with only its summary row. Pending episodes are batched, oldest first, up to 5 per LLM call.

### 4.3 Extraction: provider, prompt, schema

`provider.ts`: `extract({systemPrompt, userPrompt, schema}) → {raw, model?}`. `claude-cli` runs `claude -p --output-format json --json-schema <schema> --no-session-persistence --max-turns 1 --permission-mode dontAsk --disallowedTools "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Agent"` with the prompt on stdin and reads `structured_output`; `codex-cli` runs `codex exec - --output-schema <file> --ephemeral --skip-git-repo-check --json` and reads the final item; `opencode-sdk` keeps the current SDK call with `tools: {}`. Every provider child gets `HARNESS_MEMORY_DISABLE=1`, on which the hook runner exits 0 immediately, so the extraction run cannot feed itself through our own hooks. Deviation: `--bare` is not used although recommended for scripts, because bare mode never reads subscription credentials and the brief forbids requiring API keys.

System prompt (complete):

```
You are the memory extractor for harness-memory, a project-memory layer for an AI coding agent working in
repository "{repo_name}". You receive one or more episodes. An episode is one agent turn rendered as numbered
events e1..eN (user prompt, tool calls with arguments and results, failures, final assistant message), plus
existing memories that may be reinforced or challenged. Decide what durable, re-usable project knowledge the
episodes PROVE, and key it so a deterministic engine can surface it at the right moment later.

Rules
1. Extract only knowledge that changes what the agent does in a FUTURE turn here: a rule to follow, a mistake
   and its fix, a procedure that worked, a structural boundary, a decision with rationale. Not task progress,
   one-off facts, or restatements of the prompt.
2. Every fact cites the events that prove it in evidence_refs (e.g. ["e3","e7"]). No citation, no fact.
3. Use the narrowest true scope_glob: a file ("src/api/route.ts"), a directory ("db/migrations/**") or a
   family ("**/*.test.ts"). "**/*" only if it truly applies everywhere.
4. If the knowledge should surface when a tool is ABOUT TO RUN (a failing command, a file that must not be
   written, a required flag), give at least one trigger_signature and include "before_tool" in
   lifecycle_triggers; otherwise use "before_model" and/or "session_start".
5. Type test: enforceable rule → policy; mistake + consequence + fix → pitfall; repeatable procedure →
   workflow; structural boundary → architecture_constraint; choice between alternatives → decision.
6. If an existing memory already says this, use "reinforce" with target_memory_id. If an episode proves one
   wrong or outdated, use "propose_supersede" (replacement in the same fact) or "propose_stale". You cannot
   edit or delete memories; you can only propose.
7. summary ≤160 chars, imperative and specific ("Run scripts/seed.js before npm test; tests read
   fixtures/seed.json"); details ≤800 chars: what happened, why, how to avoid or do it. English only. Replace
   secrets and tokens with <redacted>.
8. confidence = P(true AND durable AND correctly scoped); omit facts below 0.6.
9. Output JSON only, valid against the schema. Nothing qualifies → {"facts":[],"nothing_to_learn":true}.

Signature grammar
  tool      normalized tool glob: Bash | Edit | Write | Read | Glob | Grep | WebFetch | Agent |
            mcp__<server>__<tool> | "*" ; alternatives with "|", e.g. "Edit|Write"
  arg_path  "$.command" (Bash) | "$.file_path" (Edit/Write/Read) | "$.pattern" (Grep/Glob) | "$.url" | "$.*"
  match     "cmd"  shell-aware "<program> [subcommands...] [--flags...]" matched against each simple command
                   of $.command, e.g. "git push --force", "npm test", "prisma migrate deploy"
            "glob" path glob on the value ("**/.env*", "db/migrations/**");  "regex" JS regex ≤200 chars,
            no nested quantifiers;  "contains" case-insensitive substring;  "exact" exact string
  negate    true inverts the matcher ("git commit" present AND "--no-verify" absent = two signatures)
```

User prompt template:

```
EPISODE {episode_id}  host={host} session={session_id} turn={turn_key}
flags: correction={0|1} failure_resolved={0|1} hints={decision_signal,...}
TOOLS: Bash, Edit     FILES: src/api/route.ts, scripts/seed.js
EVENTS
e1 [prompt] "tests are failing again, fix it"
e2 [Bash FAIL exit=1 sig=bash:exit1:enoent 1.8s] $ npm test
   → Error: ENOENT: no such file or directory, open 'fixtures/seed.json'
e3 [Bash ok 0.4s] $ node scripts/seed.js
e4 [Bash ok 12.1s] $ npm test → 42 passed
e5 [assistant] "Tests pass after running the seed script; fixtures/seed.json is gitignored..."
EXISTING MEMORIES (targets for reinforce / propose_*)
[mem_3f9a…] [pitfall] [auto] scope=src/api/** "Run scripts/seed.js before npm test …"
(up to 30: memories whose scope intersects the episode's files, plus top BM25 matches on event text)
OUTPUT: JSON per schema
```

Output schema (passed verbatim to `--json-schema` / `--output-schema`):

```json
{"type":"object","required":["facts","nothing_to_learn"],"additionalProperties":false,
 "properties":{
  "nothing_to_learn":{"type":"boolean"},
  "facts":{"type":"array","maxItems":8,"items":{"type":"object","additionalProperties":false,
    "required":["episode_id","action","type","summary","details","scope_glob","relevant_tools",
                "trigger_signatures","lifecycle_triggers","confidence","evidence_refs","knowledge_kind","rationale"],
    "properties":{
      "episode_id":{"type":"string"},
      "action":{"enum":["create","reinforce","propose_supersede","propose_stale"]},
      "target_memory_id":{"type":["string","null"]},
      "type":{"enum":["policy","workflow","pitfall","architecture_constraint","decision"]},
      "summary":{"type":"string","minLength":12,"maxLength":160},
      "details":{"type":"string","maxLength":800},
      "scope_glob":{"type":"string","minLength":1,"maxLength":200},
      "relevant_tools":{"type":"array","items":{"type":"string"},"maxItems":6},
      "trigger_signatures":{"type":"array","maxItems":4,"items":{"type":"object","additionalProperties":false,
        "required":["tool","arg_path","match","pattern"],
        "properties":{"tool":{"type":"string"},"arg_path":{"type":"string"},
          "match":{"enum":["cmd","glob","regex","contains","exact"]},
          "pattern":{"type":"string","maxLength":200},"negate":{"type":"boolean"}}}},
      "lifecycle_triggers":{"type":"array","minItems":1,
        "items":{"enum":["session_start","before_model","before_tool","after_tool"]}},
      "confidence":{"type":"number","minimum":0,"maximum":1},
      "evidence_refs":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"string","pattern":"^e[0-9]{1,3}$"}},
      "knowledge_kind":{"enum":["correction","failure_resolution","convention","decision","observation"]},
      "rationale":{"type":"string","maxLength":300}}}}}}
```

### 4.4 Deterministic reconcile (`reconcile.ts`: one transaction, one `SAVEPOINT` per fact)

1. Validate against the schema (small hand-rolled validator, no new dependency); `evidence_refs` must exist in the cited episode; `scanMemoryContent` and `selfReference` (rejects instructions to edit `.harness-memory`, hooks or settings) must pass. Failure → `rejected:<reason>` in `actions_json`, savepoint rolled back.
2. Normalize: forward slashes, strip `./`, reject globs escaping the repo; `relevant_tools` through `tool-normalizer`; coerce `lifecycle_triggers` by type (`pitfall`/`policy` with signatures must include `before_tool`; `decision`/`architecture_constraint` get `session_start`,`before_model`); lint signatures (tool-glob charset, regex length and nested-quantifier check, `cmd` pattern must parse).
3. Identity: `createOrGet` semantics on `identity_key`; an exact duplicate turns `create` into `reinforce` (`DuplicateMemoryContentError` is also caught and converted). Near-duplicate: same type, overlapping scope family, BM25 top-1 over existing summaries ≥ θ (or cosine ≥ 0.85 when embeddings exist) → `reinforce` of that memory; new signatures are appended to `auto` targets (≤ 6 per memory) and proposed (`edit_signature`) for `human` targets.
4. `reinforce`: `validation_count += 1`, `last_verified_at = now`, `revalidateMemory` extends TTL for `auto` rows (D4 fixed inside the branch; `human` rows change only `last_verified_at`/`validation_count`), `provenance_links(reinforced_by)`.
5. `propose_supersede` / `propose_stale`: target `human` → `proposals` row (+ replacement `candidate` for supersede), target `contested = 1`, `open_proposal_id`; nothing else changes. Target `auto` → `contradiction_count += 1`, `provenance_links(contradicted_by)`; `confidence ≥ 0.8` or two contradictions within 30 days → `stale` (`status_reason='contradiction'`); a supersede replacement goes through step 6 with `supersedes_memory_id`, and the old row becomes `superseded` only when the replacement activates.
6. `create`: insert `candidate` (`source_kind='extracted'`, `origin_episode_id`, signatures, `provenance_links(created_from)`), then the Activator (section 6) decides `active`/`auto` or leaves `candidate` (+ `activate_policy`/`activate_global` proposal when gated).
7. Episode rows → `extracted` with `extraction_run_id` in the same transaction. Invalid provider output → run `invalid_output`, `attempts += 1`, backoff 1 h / 6 h / 24 h, then `failed` (R5: bounded retries, no partial leaks).
8. After commit: `derivePolicyRules()`, snapshot rebuild, lock release.

### 4.5 Consolidation (`consolidate.ts`; worker when idle: at `Stop` if the last run is > 6 h old, on the `SessionEnd` marker, or `hm consolidate`)

Never invents memories. It sweeps TTL (auto active → stale), applies contradiction budgets, expires candidates and proposals (30 d), merges near-duplicate auto↔auto memories (cosine ≥ 0.92) and proposes `merge` when a human memory is involved, backfills embeddings (the model loads here, offline), counts heeded fires (a `before_tool` fire followed within three events by `tool_ok` of the same family without a failure signature → `heeded_count += 1`; two heeded fires equal one validation), promotes repeat-failure `skipped` episodes to `pending`, folds JSONL activation lines into `audit_log` and `fire_count`, deletes JSONL files older than 14 days whose episodes are closed, rotates `memory.sqlite.bak`, regenerates `session_summaries` from episodes, and rebuilds the snapshot.

## 5. Read path: the four triggers, before_tool matching, budgets, latency plan

| Trigger | Host event | Query inputs | Mode | Budget | Delivery |
|---|---|---|---|---|---|
| `session_start` | `SessionStart` (`startup|resume|clear|compact`) | repo fingerprint tokens, branch, `source` | `startup` | 10 / 8 KB | `hookSpecificOutput.additionalContext` |
| `before_model` | `UserPromptSubmit` | prompt tokens, path-like tokens as `scopeRef` (else `.`), `classifyQueryType` | `default`/`temporal`/`cross_session` | 10 / 8 KB | `additionalContext` |
| `before_tool` | `PreToolUse` | normalized tool call | `default` + signature stage | 3 / 1.5 KB (Deviation: deliberately small tool-boundary payload) | enforcement ladder (sections 6, 7) |
| `after_tool` | `PostToolUse`, `PostToolUseFailure` | tool call + status | `default`, `after_tool` types | 2 / 1 KB | `additionalContext` (fix hint on failures) + capture |

`before_tool` matching (`activation/signature.ts`, `mode-default.ts`):

1. `normalizeToolCall(host, tool_name, tool_input)` → `{tool, args, scopeRefs[], simpleCommands[]}`. Scope refs come from `$.file_path|$.path|$.notebook_path|$.filePath`, Codex `apply_patch` headers (`*** Update File:`), or path-like tokens of each simple command; the shell splitter handles `&&`, `||`, `;`, `|`, env prefixes and wrappers (`npx`, `pnpm`, `bunx`, `yarn`, `sudo`).
2. Candidates from the snapshot: `status='active'`, TTL not expired, `before_tool ∈ lifecycle_triggers`, `relevantTools` null or containing `tool`.
3. `sigMatch` = any signature matches (`minimatch(tool, tool_pattern)`, selector resolves, matcher true, `negate` honoured; `cmd` matches program basename, then subcommand prefix, then flag-set inclusion with long/short normalization). `scopeMatch` = any scopeRef matches `scope_glob`, or the glob is broad.
4. Fire iff `(hasSignatures && sigMatch && (scopeRefs.length === 0 || scopeMatch))` or `(!hasSignatures && scopeMatch && type ∈ {policy, pitfall})`. Signature-bearing memories whose signature misses are suppressed as `signature_mismatch` even when scope matches; this is the precision gain over scope-only matching.
5. Score = `calculateMemoryScore` (kept, trust multiplier included) + 0.25 signature match + 0.15 tool match; `human` rows with `enforcement ≠ advise` first. Type quotas: policy 2, pitfall 2, workflow 1. Session dedup: a memory that fired for the same signature within the last 20 tool events (JSONL tail, last 8 KB) is suppressed as `recently_fired` unless `enforcement ≠ advise`.
6. Append the `activation` line; `fire_count`/`last_fired_at` are folded in by consolidation.

Latency plan (target p50 < 80 ms, p95 < 150 ms, no daemon): Node 20 start of a single-file bundle without any `transformers.js` import 35–50 ms; `HARNESS_MEMORY_DISABLE`/project-root check 1 ms; read + parse `active.json` (≤ 512 KB for 300 memories, pre-parsed signatures, serialized MiniSearch) 8–15 ms; matching 300 × ≤ 6 signatures 1–3 ms; JSONL append 1 ms. The embedding model never loads in a hook: `ActivationEngine` runs with `embeddingService = null` on hook hosts (it already degrades to lexical), and dense scoring is applied offline by reconcile, consolidation and `hm why` (Deviation: the hybrid engine is kept, but on stateless hosts dense retrieval is a write-time, not read-time, operation). Fallbacks: snapshot `source_mtime` older than `memory.sqlite` → read SQLite directly (≈ +120 ms); any exception → exit 0 with no output. `UserPromptSubmit` has a 30 s host timeout, so `before_model` may spend up to ~300 ms; `SessionEnd` has 1.5 s (Claude Code) / 1 s (Codex), so it only writes a marker.

## 6. Authority model: what is automatic, what is gated, how proposals work

| Action | `auto` memory | `human` memory | Candidate |
|---|---|---|---|
| create (extractor) | – | – | always allowed |
| activate | Activator gates below | `hm memory promote` / `hm review` | – |
| reinforce / TTL extension | automatic | automatic (`validation_count`, `last_verified_at` only) | automatic |
| add signature | automatic (≤ 6) | proposal `edit_signature` | automatic |
| stale / supersede | automatic under contradiction rules | proposal only; row stays active, `contested=1` | reject/expire automatic |
| reactivate stale | automatic on new reinforce evidence | human only | – |
| enforcement change | n/a (`advise` only) | human only; consolidator proposes `escalate_enforcement` after ≥ 3 fires | – |
| scope widening to `**/*` | never | human only | proposal `activate_global` |
| delete | never (`rejected`/`superseded` rows are retained) | never | never |

Activator gates (`promotion/activator.ts`, replaces `auto-promoter.ts`):

```
canAutoActivate(m, ep):
  config.autonomy_level ∈ {standard, aggressive}          -- 'off' and 'shadow' never activate
  ∧ m.type ∈ {pitfall, workflow} ∪ (aggressive ? {decision, architecture_constraint} : ∅)
  ∧ ¬isGlobal(m.scope_glob) ∧ m.activation_class ≠ 'baseline'
  ∧ hasKey(m) := (before_tool ∈ triggers ∧ |signatures| ≥ 1) ∨ (narrow scope ∧ before_model ∈ triggers)
  ∧ evidence := distinctEpisodes(m) ≥ 2
              ∨ (distinctEpisodes(m) = 1 ∧ ep.correction ∧ m.confidence ≥ 0.85)
              ∨ (ep.failure_resolved ∧ m.type = pitfall ∧ m.confidence ≥ 0.8)
  ∧ scan(m).safe ∧ ¬selfReferential(m)
  ∧ autoActivationsToday < config.daily_cap (default 10)
on pass: status=active, authority='auto', trust_tier = distinctEpisodes ≥ 2 ? 'validated' : 'provisional',
         validation_count = distinctEpisodes - 1, ttl_expires_at = now + ttlDays(validation_count)
ttlDays(v) = min(90, 7 · 2^v)        -- 7, 14, 28, 56, 90
```

Deviation: single-episode activation (brief and review ask for evidence ≥ 2). A user correction or a failure→resolution pair inside one turn is the strongest signal the system ever sees; waiting for a second occurrence makes the agent repeat the mistake once more by design. The cost is bounded by the 7-day provisional TTL, the 0.65 trust multiplier (unchanged `calculateMemoryScore`), advise-only delivery, and the shadow calibration in section 13.

TTL, revalidation and contradiction for `auto` rows: every `reinforce`, heeded-fire pair, or approved proposal in its favour extends TTL via `ttlDays(validation_count)`; a contradiction increments `contradiction_count` and halves the remaining TTL; two contradictions in 30 days or one with confidence ≥ 0.8 → `stale`; a stale `auto` row reinforced again returns to `active` as `provisional`. For `human` rows TTL is null and contradictions only open proposals; `contested` rows are still injected, rendered with a `(contested, see hm review)` suffix so the agent hears the truth without losing the rule.

Human-gated by construction: `policy` activation (candidate + `activate_policy` proposal), global baseline activation (`activate_global`), supersede/stale of human rows, enforcement escalation, signature edits on human rows. `hm proposals approve <id>` performs the transition inside the writer lock with `decided_by='human'` and `status_reason='proposal:<id>'`; a replacement becomes `active` with `authority='human'`, so a human-approved replacement inherits sovereignty.

Optional soft-deny (off by default; `config.autonomy.pitfall_enforcement = "soft_deny"`): an `auto` pitfall whose `cmd` signature has ≥ 2 tokens and `trust_tier='validated'` may answer `PreToolUse` with `permissionDecision:"deny"` plus a reason that includes the escape hatch `HM_OVERRIDE=<memory_id> <command>`; the normalizer strips the prefix, lets the call through, and records `override_count += 1` plus a contradiction. It never hard-blocks because the model can always override, and each override is negative evidence for calibration.

Kill switch: `autonomy_level: off | shadow | standard | aggressive` in `config.json`; `shadow` runs the Activator but writes the would-be decision into `audit_log(auto_activation_shadow)` instead of changing status. `hm status` prints the day's automatic activations; `hm memory promote|demote <id>` converts any row to `authority='human'`.

## 7. Host adapters: event mapping, hook I/O, install/distribution

Verified facts that correct brief section 6: Claude Code command hooks default to 600 s (30 s for `UserPromptSubmit`, 1.5 s for `SessionEnd`), not 60 s; `PreToolUse` `additionalContext` is "added to Claude's context alongside the tool result", so only `permissionDecision: ask` (reason shown to the user) or `deny` (reason shown to Claude) act before the tool runs; `transcript_path` is JSONL with an internal, unstable line format; common input includes `prompt_id` (turn id) and `permission_mode`. Codex events: `SessionStart, SessionEnd, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt, PreModelRequest, PostModelRequest`; no `PostToolUseFailure`; `PreToolUse` supports `permissionDecision` `allow|deny`, `additionalContext`, `updatedInput` but not `ask`; `turn_id` is provided; hooks live in `~/.codex/hooks.json`, `<repo>/.codex/hooks.json` or `config.toml [hooks]`, require trust via `/hooks` (hash-bound), and may ship in a plugin's `hooks/hooks.json`; `SessionEnd` times out at 1 s; shell commands match as `Bash`, `apply_patch` as `Edit|Write`, MCP tools as `mcp__<server>__<tool>`. OpenCode's documented plugin API is V2 (`Plugin.define({id, setup(ctx)})`, `ctx.tool.hook("execute.before"|"execute.after")`, `ctx.session.hook("prompt"|"context"|"compaction")`, `ctx.event.subscribe()`, `ctx.storage`); V1 names such as `tool.execute.before` survive through a compatibility layer; a `session.idle` event is not confirmed.

Claude Code mapping:

| Core step | Hook (matcher) | Input used | Output |
|---|---|---|---|
| `session_start` | `SessionStart` (`startup|resume|clear|compact`) | `session_id`, `cwd`, `source` | `hookSpecificOutput.additionalContext`; `systemMessage` "harness-memory: N proposals pending (hm review)" on `startup` only, when N > 0 |
| `before_model`, correction detect, turn open | `UserPromptSubmit` | `prompt`, `prompt_id`, `session_id` | `additionalContext` |
| `before_tool` | `PreToolUse` (`Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*`) | `tool_name`, `tool_input`, `tool_use_id`, `agent_id` | advise → `additionalContext` (+ `systemMessage` when a policy fired); confirm → `permissionDecision:"ask"`; deny → `permissionDecision:"deny"` + `permissionDecisionReason` |
| `after_tool` capture | `PostToolUse` (`Bash|Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob|mcp__.*`), `PostToolUseFailure` | `tool_input`, `tool_response`/`error`, `duration_ms` | `additionalContext` only for `after_tool` memories |
| episode close, worker spawn | `Stop` | `stop_hook_active`, `last_assistant_message` | nothing (`decision` or `additionalContext` would continue the turn) |
| flush | `PreCompact`, `SessionEnd` (`timeout: 1`) | `trigger`, `reason` | nothing (PreCompact stdout would become compaction instructions) |

Codex: `SessionStart` → `session_start`; `UserPromptSubmit` (`prompt`, `turn_id`) → `before_model`; `PreToolUse` → `before_tool`, confirm degraded to advise + `systemMessage`; `PostToolUse` → `after_tool`, failure inferred from `tool_response`; `Stop` → episode close with no stdout (plain text is invalid there); `PreCompact`/`SessionEnd` → marker. OpenCode: `ctx.session.hook("prompt")` → `before_model` + turn open; `ctx.session.hook("context")` → injection (verify; V1 fallback `experimental.chat.system.transform`); `ctx.tool.hook("execute.before")` → `before_tool` (advise rides the next `context` hook because the before hook cannot inject text; deny by throwing, verify); `ctx.tool.hook("execute.after")` → capture; `ctx.event.subscribe()` for idle/compaction → episode close (names to verify).

Hook I/O (Claude Code):

```json
// stdin PreToolUse
{"session_id":"abc","prompt_id":"p_8f3","cwd":"/repo","hook_event_name":"PreToolUse","permission_mode":"default",
 "tool_name":"Bash","tool_input":{"command":"npm test"},"tool_use_id":"toolu_01"}
// stdout, auto pitfall (advise)
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"[harness-memory] PITFALL (auto, validated): Run scripts/seed.js before npm test; tests read fixtures/seed.json. Fired by Bash::$.command::cmd \"npm test\". Not applicable? prefix the command with HM_OVERRIDE=mem_3f9a."}}
// stdout, human policy with enforcement=deny
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
  "permissionDecisionReason":"[harness-memory] POLICY: Never write .env files; create .env.example with placeholders and add .env.local to .gitignore."},
 "systemMessage":"harness-memory blocked a .env write (policy mem_7c1d)."}
```

Install and distribution: `hm install --host claude` writes the plugin layout for `/plugin marketplace add smc2315/harness-memory` and `/plugin install harness-memory@harness-memory`: `.claude-plugin/plugin.json` (`name`, `version`, `hooks: "./hooks/hooks.json"`), `hooks/hooks.json` with exec-form command hooks (`"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/dist/hook.js","PreToolUse"],"timeout":5`), `commands/review.md|status.md|why.md` (run `hm ... --json` and present), `bin/hm` (on the Bash tool's PATH while enabled); wasm and model caches live in `${CLAUDE_PLUGIN_DATA}`. A non-plugin path writes the same hooks into `.claude/settings.json`. `hm install --host codex` writes `<repo>/.codex/hooks.json` (string-form commands, `"timeout": 5`) and prints the `/hooks` trust step. `hm install --host opencode` adds `"harness-memory/opencode"` to `opencode.json` `plugins`. All installers run `hm import` and `db:migrate`.

Session identity: `session_key = sha1(host:session_id)`; turn key = Claude Code `prompt_id` (fallback counter in `state.json`), Codex `turn_id`, OpenCode message id. Project root = nearest ancestor of `cwd` containing `.harness-memory/`, else `.git/`. Subagent events carry `agent_id` and belong to the parent session's episode.

## 8. Concurrency and crash safety

Protocol (`db/store.ts`): readers never lock; they read `snapshot/active.json` (or `memory.sqlite` as a whole-file fallback). Writers call `withWriterLock(dir, waitMs, fn)`: create `.writer.lock` with `fs.openSync(path, 'wx')` and write `{pid, startedAt, cmd}`; on `EEXIST` treat the lock as stale if `process.kill(pid, 0)` throws `ESRCH` or `startedAt` is older than 120 s, unlink and retry; otherwise sleep 25 ms until `waitMs` (hooks 0, worker 30 s, CLI 5 s then a clear "writer busy" error with `--wait`). Inside the lock: load bytes → open sql.js → apply (transactions, per-fact savepoints) → `db.export()` → write `memory.sqlite.tmp-<pid>` → `fsync` → `renameSync` over `memory.sqlite` → write `snapshot/active.json.tmp` → rename → release. JSONL appends are one `appendFileSync` of one line (< 4 KB, atomic on POSIX; per-session files avoid cross-session interleaving). `state.json` is written only by the two sequential per-session hooks; parallel `PostToolUse` hooks only append.

| Failure | Effect | Recovery |
|---|---|---|
| Writer crashes before rename | `.tmp-<pid>` left, DB intact | next writer deletes stale tmp files |
| Writer crashes holding the lock | lock remains | stale detection (dead pid or > 120 s) |
| Two CLIs at once | second waits ≤ 5 s | then fails cleanly, nothing partial |
| Hook reads during a rename | sees the old or the new whole file | both consistent; `source_mtime` check |
| Snapshot stale or missing | hook reads SQLite | writer regenerates; `hm snapshot rebuild` |
| Hook killed mid-append | truncated last line | parser skips malformed trailing line |
| Worker killed by host exit | episode stays `pending` | next `Stop` worker, or `hm episodes extract` |
| Invalid LLM output | run `invalid_output`, backoff | 3 attempts then `failed`; `--dry-run` prints the prompt |
| SQLite corrupted | open fails | `memory.sqlite.bak` (daily rotation), `hm doctor --restore` |
| Windows rename over an open file | Node opens with share-delete flags | covered by a Windows CI test |

D1 is eliminated structurally: no long-lived process holds the SQLite file, including the OpenCode plugin, so no stale in-memory copy can overwrite a CLI's work and no bash-output string matching is needed.

## 9. Policy engine and rule derivation

`PolicyEngine.evaluate({lifecycleTrigger, scopeRef, toolCall})` returns warnings for rules whose `trigger_kind` matches and whose scope glob matches `scopeRef` **or** whose signature (`tool_pattern`, `arg_path`, `match_kind`, `pattern`) matches `toolCall` through the shared `SignatureMatcher`; warnings carry `enforcement`, which the adapter maps to the host ladder. `policy/derive.ts` is the production writer, run inside every writer lock: `derivePolicyRules(db)` deletes `derived = 1` rules whose memory is no longer `active`, then upserts one rule per signature of every active `policy` memory (`rule_code = 'POL-' + memory_id.slice(0,8) + '-' + n`, `severity = enforcement === 'advise' ? 'info' : 'warning'`, `derived = 1`) plus one scope-only rule per lifecycle trigger for policies without signatures. Hand-written rules (`derived = 0`) are preserved; `fixtures:add-policy-rules` becomes test-only. The eval fixture `NO_COMMIT_SECRETS` becomes a human policy memory with signature `Write|Edit::$.file_path::glob:**/.env*` and `enforcement='deny'`.

## 10. CLI surface and review UX

One binary `hm` (alias `harness-memory`): `hm status` (one line: active/auto/provisional counts, open proposals, last extraction, autonomy level); `hm review` (interactive, exceptions only, ordered: proposals against human memories → policy candidates → global candidates → recently auto-activated for optional veto; keys `a`pprove `r`eject `e`dit `s`nooze; `--json`); `hm proposals list|approve|reject|withdraw`; `hm memory list|show|add|promote|demote|reject|edit|why|history|signature add|rm` (`promote`/`demote` set `authority='human'`); `hm episodes list|show|extract [--dry-run]`; `hm consolidate`; `hm import --from CLAUDE.md|AGENTS.md|.cursorrules|MEMORY.md [--approve|--candidate]`; `hm install --host ...`; `hm doctor` (lock, snapshot age, pending episodes, failed runs, unscoped memories); `hm snapshot rebuild`; `hm eval replay|autonomy|live`; `hm hook <event>`; `hm worker`. Nothing about review reaches the model (D6): the surfaces are the CLI, host slash commands that call it, and a one-line `systemMessage` to the user at `SessionStart` when proposals exist.

Import (`import.ts`): the file is split into bullets and headings, rendered as an `import` episode (`e<N>` = line numbers) and sent through the same extractor in import mode (scope inferred from path mentions, signatures encouraged). `CLAUDE.md`, `AGENTS.md`, `.cursorrules` are human-authored → `authority='human'`, `status='active'`, `activation_class='baseline'` when global, `source_kind='imported'`, `provenance_links(imported_from)`; re-import diffs per-line hashes and applies changes directly (the human edited the file). Claude Code native `MEMORY.md` (`~/.claude/projects/<slug>/memory/MEMORY.md`) is machine-written → candidates that run through the Activator as `authority='auto'`. Deviation: the bullet-regex importer in `install.ts` is replaced because imported rules need scope and signatures to work at `before_tool`.

## 11. Migration from v0.5 databases and from the current module code

Database: 017–020 are additive. `021_legacy_evidence_fold.sql` converts each `pending` `dream_evidence_events` row with `tool_name='conversation-batch'` into an `episodes` row (`host='opencode'`, `turn_key='legacy:'||id`, `extraction_status='pending'`) with one `episode_events` row (`kind='legacy_batch'`, excerpt = batch text), so the new extractor processes them once with the new prompt; all other evidence rows become `discarded`. `evidence` and `dream_memory_evidence_links` stay read-only (`memory:history` still shows them); `provenance_links` is the source of truth going forward. Memories from the old LLM path (`scope_glob='**/*'`, `lifecycle_triggers=['before_model']`, candidate) stay candidates, are listed by `hm doctor` as unscoped, and expire or get re-extracted. `PRAGMA user_version = 21`; the migrator and its tests are unchanged.

Code: delete `ConversationBuffer`, `incrementSessionCount`/`checkGates`, `buildCandidateDigest`, `isHarnessMemoryCliCall`/`reloadDbFromDisk`, `DreamWorker`, `dream-run.ts`, `executeExtractionActions`; move `revalidateMemory` into `authority.ts`; extend `MemoryRecord`/`UpdateMemoryInput`; add `SnapshotRepository` implementing the `list/getById/listLineageConflicts` subset the engine uses (engine type-compatible); `AdapterBeforeToolResult.blocked` becomes `enforcement`. Of the 315 tests, activation, scanner, migrator, repository and eval suites stay; dream-worker and buffer tests go; the two repro tests are kept and inverted into regressions. Rollout: v0.6.0 ships hooks, the Claude Code adapter and the extractor with `autonomy_level='shadow'` as default; v0.6.x flips to `standard` once the calibration report (section 13) passes.

## 12. Defect coverage matrix

| ID | Why it cannot recur |
|---|---|
| R1 | Every applied fact writes `provenance_links`; the Activator counts `distinctEpisodes` from `provenance_links`, never from `evidence`; facts without resolvable `evidence_refs` are rejected before insertion. |
| R2 | The schema requires `scope_glob`, `lifecycle_triggers`, `trigger_signatures`; reconcile coerces triggers by type; the Activator refuses `**/*` and key-less memories; the hard-coded `scopeGlob: "**/*"` path no longer exists. |
| R3 | No `minSessions` gate or process-lifetime counter: a fresh worker runs per closed episode; the only gate is "is there a pending episode". |
| R4 | `supersede`/`stale` do not exist as direct actions; `propose_*` against `authority='human'` can only create a `proposals` row and set `contested`. Status writes on human rows are reachable only from `proposals.approve` and `hm memory promote|demote|reject` (`decided_by='human'`); an invariant test asserts no other code path writes `status` on human rows. |
| R5 | `createOrGet` identity semantics turn duplicates into `reinforce`; each fact runs in a savepoint; episode consumption commits with the facts; failed runs back off and stop after 3 attempts. |
| R6 | `DreamWorker` and template candidates are deleted; regex survives only as failure-signature extraction and salience hints; all memory text comes from the extractor and cites an episode. |
| R7 | One queue (`episodes`), one consumer (the worker); `conversation-batch` evidence is folded into episodes by migration 021; `dream:run` is removed. |
| D1 | No process holds SQLite open across events; writers use lock + load/apply/save + atomic rename; hooks are read-only and see CLI changes through the snapshot `source_mtime`. |
| D2 | The prompt asks for keyed, repository-specific, citable knowledge; the schema forces scope, tools, signatures, triggers, confidence and evidence. |
| D3 | Capture is semantic: episodes are turns closed at `Stop`/`PreCompact`; excerpts are 1200 chars head+tail; every line carries `session_id` + `prompt_id`/`turn_id`; gates are correction, failure→resolution, repeat failure. |
| D4 | TTL extension is inside `applyReinforce` for every reinforce and heeded-fire pair, not a separate call. |
| D5 | `PolicyEngine` matches tool + signature; `derivePolicyRules` runs inside every writer lock. |
| D6 | No review text reaches the model; proposals surface via `hm status/review` and a user-only `systemMessage`. |
| D7 | `after_tool` writes one JSONL line per tool call and no evidence rows; activation audit lines are compact id lists folded into `audit_log` later. |

## 13. Eval plan

1. Deterministic replay (`hm eval replay`, kept `src/eval` runners): the 12-scenario corpus is ported so fixtures carry `trigger_signatures` and `authority` (s03: `Write|Edit::$.file_path::glob:**/.env*`, deny; s06 must suppress with `signature_mismatch`/`scope_mismatch`; s09 stale suppression; s12 budget at 3 / 1.5 KB). Pass criteria as today (0 important misses, stale and conflict markers present) plus: no `auto` row changes a `human` row's status in any scenario, and p95 `PreToolUse` latency < 150 ms measured by spawning the real hook binary with the scenario's stdin.
2. Extraction calibration (`hm eval autonomy`): a 40-episode gold set recorded from dogfooding JSONL (anonymized, in `research/eval/episodes/`) with gold facts (type, scope, signature, action). Metrics: fact precision/recall, scope exactness, signature validity (parses, fires on the gold call, does not fire on 20 negative calls), and autonomy regret = share of would-be auto-activations the reviewer rejects. Leaving shadow mode requires precision ≥ 0.8, regret ≤ 0.1, signature false-fire ≤ 1 per 100 negative calls; re-run monthly and on any prompt or model change (`prompt_hash` in `extraction_runs` makes regressions attributable).
3. Live A/B (`hm eval live`): the 12 scenarios plus 6 two-session "learn then apply" scenarios (session A holds the correction or failure→resolution; session B must be warned at the right boundary), run with `claude -p` and `codex exec` three ways: markdown-only, Claude Code native auto-memory (`MEMORY.md` seeded with the same facts), markdown + harness-memory. Scored with the existing annotation rubric and miss taxonomy plus timing (warning before the risky tool call: yes / with result / no), false-warning rate, injected tokens per turn, heed rate. The continue threshold stays the brief's ≥ 30 % reduction of important misses; the design's own claim is the timing column, where markdown and `MEMORY.md` structurally score "session start only".

## 14. Risks, effort estimate, open questions

Risks: (1) Claude Code `PreToolUse` `additionalContext` arrives with the tool result, so `advise` cannot prevent the first execution; "stop before the mistake" is fully delivered only by `deny`/`ask` (human policies) or the opt-in soft-deny; mitigated by escalation proposals and the eval timing column. (2) Node cold start on Windows may push p95 past 150 ms; mitigation: single-file bundle, no transformers import, optional `bun` runner. (3) Extraction cost: one headless model call per salient turn on the user's plan; mitigated by gates, 5-episode batching and backoff. (4) Signature over-fitting (an `exact` command string) causes silent misses; the linter prefers `cmd`/`glob`, and `hm doctor` lists signatures that never fired in 30 days. (5) OpenCode V2 event names and injection hook are unverified. (6) Codex hook trust (`/hooks`, hash-bound) adds an install step and re-trust on every binary update.

Effort (solo): W1–2 store/lock/snapshot, JSONL capture, hook runner, Claude Code adapter and installer, snapshot read path; W3–4 schema, prompt, providers (claude/codex), reconcile, Activator, migrations 017–021; W5 signature grammar and matcher, policy derivation, replay port; W6 consolidation, proposals, `hm review`; W7 Codex adapter and trust flow, import; W8 OpenCode V2 adapter, shadow-mode tooling, docs; W9–10 dogfooding, 40-episode gold set, live A/B, tuning, v0.6.0. Ten weeks, risk +2.

Open questions: should `decision` memories be auto-activatable at `standard` level, given they carry no signatures and mostly serve `session_start`? Should worktrees share one `.harness-memory` (config `shared_db_path`) or stay isolated? Is `claude -p` on a subscription acceptable as the default extractor cost, or should extraction default to the cheapest configured model (`--model`/`-m`)? Does OpenCode V2 expose a session-idle event and a pre-tool injection channel, or must `advise` ride the next `context` hook? Should soft-deny become the default for `validated` pitfalls once calibration regret is below 5 %?
