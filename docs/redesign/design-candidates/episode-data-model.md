# harness-memory v0.6 design candidate: episode-data-model

Slug `episode-data-model`. Angle: data-model purist. Reference code: v0.5.1 clone at `C:\Users\choey\AppData\Local\Temp\hm-src\repo` (read only).

Host facts: the designated `design-candidates/host-hook-facts.md` did not exist, so every hook claim in section 7 was verified on 2026-11-08 against `code.claude.com/docs/en/hooks`, `code.claude.com/docs/en/cli-reference`, `learn.chatgpt.com/docs/hooks`, and `learn.chatgpt.com/docs/non-interactive-mode` (redirect targets of the `developers.openai.com/codex/...` pages). Items marked (unverified) must be confirmed before implementation.

## 1. Angle and principles

v0.5 does not fail on tuning; it fails because the write path has no stable unit. Evidence is a per-tool-call fragment with a seven-state lifecycle, two uncoordinated writers turn fragments into memories, and no row links an active memory back to the moment that justified it. This design makes the **episode** the unit of capture, makes every derived row content-addressed, and makes reconcile a pure function of (episode, extraction output, current DB state).

- P1 Immutable capture, derived everything else. `spans` and `episodes` are facts; `memories`, `proposals`, `policy_rules`, and the activation snapshot are derivations rebuildable from facts plus recorded decisions.
- P2 Content-addressed identity. `span.id = H(session_id, line)`, `episode.id = H(session_id, first_seq)`, `extraction_run.id = H(episode_id, extractor_version, prompt_sha256)`, `claim.id = H(claim_key, episode_id)`, `memory.identity_key = H(type, scope_glob, signature_key, normalized_summary)`. Re-application is `INSERT OR IGNORE`.
- P3 Four explicit state machines (episode, extraction run, memory, proposal), each with one transition function and a guard table. No bare `UPDATE ... SET status`.
- P4 Authority is a column enforced by the memory transition guard. The LLM cannot demote a human-authority row; it can only open a proposal.
- P5 Provenance is a relation: memory to claim to span to episode to session (to `transcript_path`). `memory:trace` is a JOIN.
- P6 The hot path reads a materialized view and appends to a ledger. It never opens a write transaction, never loads the embedding model, never calls an LLM.
- P7 Numbers are set-derived. `confidence`, `evidence_count`, `distinct_session_count`, `support_count` are recomputed from provenance sets, never incremented, so replaying an episode yields identical rows.

## 2. Architecture: modules, processes, where state lives

Processes on hook hosts: one fresh Node process per hook event (`harness-memory hook --host claude-code|codex`, stdin JSON, behavior selected by `hook_event_name`); the extractor (`harness-memory episode:extract`), which on `Stop` runs inside the asynchronous hook process; CLI commands; and the OpenCode in-process plugin, which calls the same core over the same files. No daemon.

| State | Location | Writer | Reader |
|---|---|---|---|
| Canonical store | `.harness-memory/memory.sqlite` (sql.js) | any process holding `memory.sqlite.lock` (section 8) | CLI, extractor, fallback hot path |
| Capture ledger | `.harness-memory/ledger/<host>-<session_id>.jsonl`, append-only | capturing hooks | `src/capture/importer.ts` |
| Activation snapshot | `.harness-memory/activation-snapshot.json`: active memories, compiled signatures, serialized MiniSearch index, `generation` stamp | every writer, at commit | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUseFailure` |
| Raw extraction output | `.harness-memory/extractions/<run_id>.json` | extractor | `episode:show`, replay eval |
| Per-session cursor | `.harness-memory/state/<session_id>.json` (`last_line`, `open_episode_id`, `digest_shown_at`), temp+rename | hooks | hooks |
| Global baseline | `~/.harness-memory/global.sqlite` via the unchanged `CompositeMemoryRepository` | CLI | snapshot builder |

Session identity: `session_id` from hook stdin on both hosts, `sessionID` in OpenCode; `sessions.id = "<host>:<session_id>"`.

Module map (the brief's decomposition is kept):

| Module | Status | Content |
|---|---|---|
| `src/capture/` | new | `ledger.ts` (`appendLedgerLine`, `readLedger`), `segmenter.ts` (`segmentLedger`, `normalizeFailureSignature`, `detectCorrection`, `extractScopeRef`, `extractCommandText`), `importer.ts` (`importLedger`) |
| `src/dream/` | rewritten | `extractor.ts` (`buildEpisodePrompt`, `EXTRACTION_SCHEMA`, `parseExtraction`), `providers/{claude-cli,codex-cli,opencode-sdk,replay}.ts` behind `ExtractionProvider`, `reconcile.ts` (`reconcileRun`), `consolidate.ts`. Deleted: `worker.ts`, `llm-extract.ts`, regex `typeGuess/topicGuess`, evidence-state methods of `DreamRepository` |
| `src/promotion/` | rewritten | `transitions.ts` (`transitionMemory`, `AuthorityViolationError`), `proposals.ts` (`openOrSupportProposal`, `decideProposal`), `auto-activate.ts` (`autoActivateEligible`), `ttl.ts`. Deleted: `auto-promoter.ts` |
| `src/policy/` | extended | `rule-deriver.ts` (`derivePolicyRules`), `signature.ts` (`matchesSignature`); engine matches tool and command |
| `src/activation/` | kept | engine, modes, fusion, scope, lexical untouched; new `signature-matcher.ts` (`matchBeforeTool`); embedding service optional at the call site |
| `src/adapters/` | extended | `types.ts` kept; new `hook-adapter.ts` (`handleHookEvent`), `hosts/claude-code.ts`, `hosts/codex.ts`, `hosts/tool-aliases.json`; `opencode-adapter.ts` thinned onto the same core |
| `src/db/` | extended | migrations 017-023, `locking.ts` (`withWriteLock`), `snapshot.ts` (`rebuildSnapshot`, `loadSnapshot`), `post-migrations/019-backfill-identity.ts` |
| `src/cli/` | rewritten | `hook.ts`, `episode-*.ts`, `proposal-*.ts`, `import.ts`, `memory-review.ts`, `memory-trace.ts`, `install.ts`; deleted `dream-run.ts`, `dream-extract.ts`, `dream-evidence-list.ts`; `fixtures-add-policy-rules.ts` moves to tests |
| `src/plugin/opencode-plugin.ts` | rewritten | thin mapping of OpenCode hooks onto `handleHookEvent`; `ConversationBuffer`, review digest, `isHarnessMemoryCliCall`, `reloadDbFromDisk` deleted |
| `src/security`, `src/audit`, `src/retrieval`, `src/eval` | kept | `summary-generator.ts` reads episodes instead of evidence events |

## 3. Data model

Ids are deterministic strings from the existing `createDeterministicId(seed)`; `H(...)` means `createDeterministicId(parts.join(":"))`. Timestamps are ISO-8601 TEXT.

### 3.1 Capture tables (migration 017)

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- "<host>:<session_id>"
  host TEXT NOT NULL CHECK(host IN ('claude-code','codex','opencode')),
  host_session_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  transcript_path TEXT,                -- opaque host pointer
  ledger_path TEXT NOT NULL,
  ledger_lines_imported INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, last_event_at TEXT NOT NULL,
  ended_at TEXT, end_reason TEXT
);

CREATE TABLE spans (                   -- immutable; one row per ledger line
  id TEXT PRIMARY KEY,                 -- H('span', session_id, sha256(line))
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,                -- ledger line index
  episode_id TEXT REFERENCES episodes(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool_result','tool_failure','marker')),
  hook_event TEXT NOT NULL,
  tool_name TEXT,                      -- canonical: bash, edit, write, read, glob, grep, webfetch, task, mcp:<server>:<tool>, other
  host_tool_name TEXT, tool_use_id TEXT,
  scope_ref TEXT,                      -- normalized relative path
  command_text TEXT, exit_code INTEGER,
  failure_signature TEXT,              -- 'ENOENT', 'exit:1:vitest', 'TS2322', ...
  is_correction INTEGER NOT NULL DEFAULT 0,
  explicit_marker INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,                  -- redacted, <= 4096 chars
  text_sha256 TEXT NOT NULL, text_truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX idx_spans_episode ON spans(episode_id);
CREATE INDEX idx_spans_failure ON spans(failure_signature) WHERE failure_signature IS NOT NULL;

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,                 -- H('episode', session_id, first_seq)
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('turn','correction','failure_resolution')),
  status TEXT NOT NULL CHECK(status IN ('open','closed','queued','extracting','extracted','skipped','failed')),
  related_episode_id TEXT REFERENCES episodes(id),   -- correction: the corrected turn
  first_seq INTEGER NOT NULL, last_seq INTEGER,
  opened_at TEXT NOT NULL, closed_at TEXT,
  close_reason TEXT CHECK(close_reason IN ('stop','precompact','session_end','next_prompt','manual')),
  scope_set_json TEXT NOT NULL DEFAULT '[]',
  tool_set_json TEXT NOT NULL DEFAULT '[]',
  failure_signatures_json TEXT NOT NULL DEFAULT '[]', -- [{sig, first_seq, resolved_seq}]
  has_correction INTEGER NOT NULL DEFAULT 0,
  has_resolution INTEGER NOT NULL DEFAULT 0,
  has_explicit_marker INTEGER NOT NULL DEFAULT 0,
  mutating_tool_count INTEGER NOT NULL DEFAULT 0,     -- edit/write/bash spans
  salience REAL NOT NULL DEFAULT 0,
  content_hash TEXT,                                  -- sha256 of ordered span text_sha256s, set at close
  retry_count INTEGER NOT NULL DEFAULT 0, skip_reason TEXT,
  UNIQUE(session_id, ordinal)
);
CREATE INDEX idx_episodes_status ON episodes(status);
```

Evidence has two implicit states only: a line exists in the ledger, or it has been imported as a span. The seven-state `dream_evidence_events` machine disappears; lifecycle belongs to the episode.

Episode state machine (`transitionEpisode` in `src/capture/episode-state.ts`):

| From | To | Trigger | Guard |
|---|---|---|---|
| open | closed | `Stop`, `PreCompact`, `SessionEnd`, next `UserPromptSubmit` while open, `episode:close --manual` | sets `last_seq`, `closed_at`, `content_hash`, flags, `salience` |
| closed | queued | `salience >= 0.3` | see 4.2 |
| closed | skipped | otherwise | `skip_reason = 'low_salience'` |
| queued | extracting | extractor holds the write lock | `extraction_runs` row `started` |
| extracting | extracted | run reaches `reconciled` | |
| extracting | failed | provider, parse, or timeout error | `retry_count += 1` |
| failed | queued / skipped | `retry_count < 3` / `>= 3` | `skip_reason = 'extraction_failed'` |

Invariants: E1 spans of a `closed`-or-later episode are immutable. E2 episode ranges within a session are disjoint and cover every non-marker span. E3 `salience = min(1, 0.6*has_correction + 0.5*has_resolution + 0.3*has_explicit_marker + 0.1*min(mutating_tool_count,3)/3)`.

### 3.2 Extraction, claims, provenance (migration 018)

```sql
CREATE TABLE extraction_runs (
  id TEXT PRIMARY KEY,                 -- H('extract', episode_id, extractor_version, prompt_sha256)
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  provider TEXT NOT NULL CHECK(provider IN ('claude-cli','codex-cli','opencode-sdk','replay')),
  model TEXT, extractor_version TEXT NOT NULL, prompt_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('started','parsed','reconciled','failed')),
  raw_response_path TEXT, claim_count INTEGER NOT NULL DEFAULT 0, error TEXT,
  started_at TEXT NOT NULL, finished_at TEXT
);

CREATE TABLE claims (                  -- one row per LLM output item; immutable after reconcile
  id TEXT PRIMARY KEY,                 -- H('claim', claim_key, episode_id)
  claim_key TEXT NOT NULL,             -- type|scope_glob|signature_key|normalized_summary
  extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id),
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  ordinal INTEGER NOT NULL,
  proposed_action TEXT NOT NULL CHECK(proposed_action IN ('create','reinforce','propose_supersede','propose_stale')),
  target_memory_id TEXT,
  type TEXT NOT NULL CHECK(type IN ('policy','workflow','pitfall','architecture_constraint','decision')),
  summary TEXT NOT NULL, details TEXT NOT NULL, rationale TEXT,
  scope_glob TEXT NOT NULL, relevant_tools_json TEXT NOT NULL,
  trigger_signature_json TEXT, lifecycle_triggers_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  evidence_refs_json TEXT NOT NULL,    -- span ids, validated to belong to episode_id
  scan_result TEXT NOT NULL CHECK(scan_result IN ('safe','blocked')),
  reconcile_outcome TEXT CHECK(reconcile_outcome IN ('created','reinforced','proposal_opened','proposal_supported','applied_auto','rejected_invalid','rejected_unsafe','rejected_no_target')),
  resulting_memory_id TEXT, resulting_proposal_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_claims_key ON claims(claim_key);

CREATE TABLE memory_provenance (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  span_id TEXT NOT NULL REFERENCES spans(id),
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  claim_id TEXT REFERENCES claims(id),   -- NULL for manual/import rows
  relation TEXT NOT NULL CHECK(relation IN ('origin','reinforce','contradict','manual','import')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, span_id, relation)
);
CREATE INDEX idx_prov_episode ON memory_provenance(episode_id);
```

`memory:trace <id>` is `memories -> memory_provenance -> spans -> episodes -> sessions.transcript_path`; it prints span text, tool, command, failure signature, and the transcript pointer. Every active extraction-sourced memory has at least one `origin` row (M4).

### 3.3 Memories (migration 019, ALTER TABLE)

```sql
ALTER TABLE memories ADD COLUMN authority TEXT NOT NULL DEFAULT 'human' CHECK(authority IN ('human','auto'));
ALTER TABLE memories ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual' CHECK(source_kind IN ('manual','import','extraction','consolidation'));
ALTER TABLE memories ADD COLUMN source_ref TEXT;
ALTER TABLE memories ADD COLUMN trigger_signature_json TEXT;    -- {tool, command_pattern, path_glob, failure_signature}
ALTER TABLE memories ADD COLUMN signature_key TEXT;             -- canonical serialization, '' if none
ALTER TABLE memories ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 0;         -- COUNT(DISTINCT episode_id) in provenance
ALTER TABLE memories ADD COLUMN distinct_session_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN superseded_by_memory_id TEXT;   -- forward pointer; supersedes_memory_id stays
ALTER TABLE memories ADD COLUMN revalidate_after TEXT;
ALTER TABLE memories ADD COLUMN stale_reason TEXT;
CREATE INDEX idx_memories_identity ON memories(identity_key);
CREATE INDEX idx_memories_active_trigger ON memories(status, lifecycle_triggers);
```

`identity_key` is redefined as semantic identity `H(type, scope_glob, signature_key, normalizeSummary(summary))` with `normalizeSummary` = NFKC, lowercase, collapsed whitespace, trailing punctuation stripped; `content_hash` stays exact. `019-backfill-identity.ts` recomputes it for all rows, keeping the oldest row on collision and marking the rest `superseded` with `stale_reason = 'identity_merge_v019'`. `promotion_source` maps onto `authority` (`manual` to `human`, `auto` to `auto`) and is kept one release.

Memory status machine, `transitionMemory(db, {memoryId, to, actor, reason, proposalId?, claimId?})`, actors `human | auto_rule | expiry | import`:

| From | To | Allowed actor | Guard |
|---|---|---|---|
| candidate | active | human; auto_rule | auto_rule only if `autoActivateEligible` (section 6) |
| candidate | rejected | human; expiry (30 days) | |
| active | stale | human; auto_rule; expiry | auto_rule and expiry only for `authority = 'auto'`; a human row needs actor human and an accepted `proposalId` |
| active | superseded | human; auto_rule | same authority guard; replacement becomes active in the same transaction |
| stale | active | human; auto_rule | auto_rule only for `authority = 'auto'` on a new `reinforce` |
| superseded | active | human (`memory:restore`) | |
| rejected | - | terminal | |

Every transition inserts a `memory_transitions` row; any other combination throws `AuthorityViolationError`, and no other code writes `memories.status`.

Invariants: M1 at most one `active` row per `identity_key`. M2 human rows have `ttl_expires_at IS NULL`. M3 active auto rows have `ttl_expires_at NOT NULL`. M4 extraction-sourced active rows have `evidence_count >= 1`. M5 `policy` rows are never `authority = 'auto'`. M6 for extraction-sourced rows `confidence = min(0.99, max(linked claim confidence) + 0.05 * (evidence_count - 1))`; manual and import rows keep the given value. M7 `superseded` rows have `superseded_by_memory_id NOT NULL`.

### 3.4 Proposals and transitions (migration 020)

```sql
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,                 -- H('proposal', kind, target_memory_id, claim_key)
  kind TEXT NOT NULL CHECK(kind IN ('supersede','stale','promote_policy','promote_global','promote_candidate','merge')),
  status TEXT NOT NULL CHECK(status IN ('open','accepted','rejected','withdrawn','expired')),
  target_memory_id TEXT REFERENCES memories(id),
  replacement_memory_id TEXT REFERENCES memories(id),   -- candidate created with the proposal
  origin_claim_id TEXT REFERENCES claims(id),
  reason TEXT NOT NULL,
  support_count INTEGER NOT NULL DEFAULT 1,           -- COUNT(DISTINCT episode_id) in proposal_support
  opened_at TEXT NOT NULL, last_supported_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  decided_at TEXT, decided_by TEXT CHECK(decided_by IN ('human','auto_rule','expiry')), decision_note TEXT
);
CREATE UNIQUE INDEX ux_proposals_open ON proposals(kind, target_memory_id) WHERE status = 'open';
CREATE TABLE proposal_support (proposal_id TEXT NOT NULL REFERENCES proposals(id), episode_id TEXT NOT NULL, claim_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(proposal_id, episode_id));

CREATE TABLE memory_transitions (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id),
  from_status TEXT NOT NULL, to_status TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(actor IN ('human','auto_rule','expiry','import')),
  proposal_id TEXT, claim_id TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_transitions_memory ON memory_transitions(memory_id, created_at);
```

Proposal machine: `open` to `accepted` (human, or auto_rule when the target is `authority = 'auto'`, non-policy, and `support_count >= 2`), to `rejected` (human), to `withdrawn` (target left `active` by another path), to `expired` (30 days). The partial unique index turns a repeated proposal into an upsert into `proposal_support`: a new episode raises `support_count`, the same episode is a no-op.

### 3.5 Policy rules, meta, ops (migrations 021-022)

```sql
ALTER TABLE policy_rules ADD COLUMN tool_pattern TEXT;        -- regex on canonical tool name, NULL = any
ALTER TABLE policy_rules ADD COLUMN command_pattern TEXT;     -- regex on command_text
ALTER TABLE policy_rules ADD COLUMN arg_path_glob TEXT;       -- glob on path args; falls back to scope_glob
ALTER TABLE policy_rules ADD COLUMN derived_from_updated_at TEXT;
ALTER TABLE policy_rules ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- 'generation', 'snapshot_generation', 'extractor_version'
CREATE TABLE write_ops (id TEXT PRIMARY KEY, kind TEXT NOT NULL, generation INTEGER NOT NULL, applied_at TEXT NOT NULL);
```

`write_ops` records every applied batch by deterministic id (`extraction_runs.id`, `H('consolidate', day)`, `H('decision', proposal_id, decided_at)`, `H('import', file_sha256)`); a writer that finds its id present returns without writing. Migration 023 renames `dream_evidence_events`, `dream_runs`, `dream_memory_evidence_links` to `legacy_*`, moves `evidence` rows with `source_kind = 'session'` to `legacy_evidence`, keeps `evidence` for `manual_note` rows, and sets `PRAGMA user_version = 23`.

### 3.6 Activation snapshot (materialized view, not a table)

`rebuildSnapshot(db)` writes `activation-snapshot.json`: `{generation, built_at, memories: [every column the engine reads, for active rows of both tiers, plus embedding_summary_b64], policy_rules: [...], failure_index: {failure_signature: [memory_id]}, lexical_index: MiniSearch.toJSON()}`. Invariant S1: `snapshot.generation == meta.generation`, else the hot path falls back to the DB (section 8).

## 4. Write path

### 4.1 Capture (hooks to ledger)

Each capturing hook appends one JSON line (`{ts, event, role, tool_name, host_tool_name, tool_use_id, scope_ref, command_text, exit_code, failure_signature, is_correction, explicit_marker, text, text_sha256, truncated}`) with a single `fs.appendFileSync`; lines are capped at 8 KB so appends do not interleave. Credentials are redacted before writing by a new `redactCredentials(text)` built on the scanner's patterns.

- `UserPromptSubmit`: `role = 'user'`, `text = prompt`. `is_correction = 1` when the previous non-marker span is a `tool_failure` or the prompt matches the correction lexicon (`don't|do not|never|stop|instead|not that|wrong|아니|하지 마|말고|대신|틀렸`); `explicit_marker = 1` for `remember|always|never|from now on|rule|기억|항상|절대|앞으로`. If the cursor shows an open episode, it is closed with `close_reason = 'next_prompt'`.
- `PostToolUse`: `role = 'tool_result'`; `scope_ref = extractScopeRef(tool_input)` (`file_path`, `path`, `notebook_path`, or the first path-like token of a bash command); `command_text = tool_input.command` for bash-like tools; `exit_code` parsed from `tool_response`; `failure_signature = normalizeFailureSignature(text)` (ordered rules: errno codes, `TS\d{4}`, `exit:<code>:<first command word>`, `npm ERR!`, `ModuleNotFoundError`, `AssertionError`, else NULL); `text` = first 4 KB of the stringified `tool_response`.
- `PostToolUseFailure` (Claude Code only): `role = 'tool_failure'`, `text = error`. Codex has no such event; failures come from exit codes in `PostToolUse`.
- `Stop`: `role = 'assistant'` with `last_assistant_message`, then a `turn_end` marker, then the extractor runs in-process (registered `async`, section 7).
- `PreCompact`, `SessionEnd`: one marker line (`compact`, `session_end`). `SessionEnd` has a 1.5 s budget on Claude Code and 1 s on Codex, so it does nothing else.
- `PreToolUse`: writes nothing; arguments arrive at `PostToolUse` as `tool_input`.

### 4.2 Segmentation and eligibility (`segmentLedger`, deterministic over file order)

A `turn` episode spans from a `user` span to the following `turn_end` marker (or the next `user` span, `compact`, or `session_end`). A turn whose opening span has `is_correction = 1` becomes `kind = 'correction'` with `related_episode_id` = the previous turn, whose last eight tool spans and assistant span join the extraction prompt. A failure signature `S` first seen at seq `a` is resolved at the first later span of the same canonical tool whose `scope_ref` shares a path prefix with the failing span and has no failure signature, provided `S` does not recur before the turn ends; that episode gets `has_resolution = 1` and `kind = 'failure_resolution'` unless it is already a correction.

Eligibility is E3. Deviation: the brief says extraction runs per closed episode; here a plain turn with no correction, resolution, explicit marker, or mutating tool is closed and `skipped`. An LLM call per read-only turn costs money and yields mem0-style trivia; the brief's three semantic capture moments are exactly the flags that make salience positive.

### 4.3 Extraction

`buildEpisodePrompt(episode, spans, candidates)` emits one line per span prefixed by its reference `S<seq>` (`S12 [bash exit:1 ENOENT] npm test -> Error: ENOENT fixtures/`), the scope set, tool set, failure signatures with resolution pointers, and up to 12 candidate existing memories chosen by scope-glob intersection with `scope_set_json` plus BM25 over the digest, printed as `[M:<id>] [type] [status/authority] summary`. The system prompt asks only for durable operating knowledge of the five types and forbids preferences without a scope or tool. `prompt_sha256` covers the whole prompt including candidates.

Providers implement `ExtractionProvider.extract(prompt, schema)`: `claude-cli` runs `claude -p --output-format json --json-schema <EXTRACTION_SCHEMA> --bare --no-session-persistence --max-turns 1 --model <configured>` (flags verified in the CLI reference); `codex-cli` runs `codex exec --output-schema <schema file> -o <out file> --ephemeral --sandbox read-only -` with the prompt on stdin (verified); `opencode-sdk` keeps the current `createOpencode()` call; `replay` reads a recorded response. No provider grants tools.

Extraction output schema (`EXTRACTION_SCHEMA`, passed verbatim to both structured-output flags):

```json
{"type":"object","required":["claims"],"additionalProperties":false,
 "properties":{"claims":{"type":"array","maxItems":8,"items":{"type":"object",
  "required":["action","type","summary","details","scope_glob","relevant_tools","trigger_signature","lifecycle_triggers","confidence","evidence_refs"],
  "properties":{
   "action":{"enum":["create","reinforce","propose_supersede","propose_stale"]},
   "target_memory_id":{"type":["string","null"]},
   "type":{"enum":["policy","workflow","pitfall","architecture_constraint","decision"]},
   "summary":{"type":"string","maxLength":200},
   "details":{"type":"string","maxLength":1200},
   "scope_glob":{"type":"string"},
   "relevant_tools":{"type":"array","items":{"type":"string"}},
   "trigger_signature":{"type":["object","null"],"properties":{
     "tool":{"type":"string"},"command_pattern":{"type":["string","null"]},
     "path_glob":{"type":["string","null"]},"failure_signature":{"type":["string","null"]}}},
   "lifecycle_triggers":{"type":"array","items":{"enum":["session_start","before_model","before_tool","after_tool"]}},
   "confidence":{"type":"number","minimum":0,"maximum":1},
   "evidence_refs":{"type":"array","minItems":1,"items":{"type":"string","pattern":"^S[0-9]+$"}},
   "rationale":{"type":"string","maxLength":300}}}}}}
```

`parseExtraction` inserts the `extraction_runs` row (`status = 'parsed'`, raw response saved) and one `claims` row per item with `scan_result` from `scanMemoryContent(summary, details)`.

### 4.4 Reconcile (`reconcileRun(db, runId)`, deterministic and idempotent)

One `withWriteLock` transaction:

```
if write_ops has runId: return              -- whole-run idempotence
E = episode(run); spanIds = ids of spans where episode_id = E.id
for claim c in run.claims ordered by ordinal:
  normalize: scope_glob slashes; relevant_tools -> canonical lowercase sorted (alias table);
             trigger_signature -> canonical JSON (tool lowercase, regex compile check, path_glob normalized)
  c.evidence_refs = c.evidence_refs ∩ spanIds        -- drop refs outside this episode
  if c.evidence_refs empty or scope_glob invalid or lifecycle_triggers empty -> rejected_invalid; continue
  if c.scan_result = 'blocked' -> rejected_unsafe; continue
  identity = H(type, scope_glob, signature_key(c.trigger_signature), normalizeSummary(summary))
  m  = memories WHERE identity_key = identity AND status IN ('candidate','active','stale') ORDER BY created_at, id LIMIT 1
  t  = memories WHERE id = c.target_memory_id (NULL if absent, rejected, or superseded)
  if m is NULL and action = 'create':
     m = findSemanticNeighbor(c)   -- same type, intersecting scope globs, max(jaccard(tokens), cosine(embedding_summary) if present) >= 0.85; ties by created_at, id
  switch action:
    create:
      if m: goto reinforce(m)
      insert memory {id = createMemoryId(identity), identity_key = identity, status 'candidate', authority 'human',
                     source_kind 'extraction', confidence c.confidence, importance by type (policy .9, pitfall .8, arch .8, workflow .6, decision .6),
                     lifecycle_triggers, relevant_tools, scope_glob, trigger_signature_json, signature_key,
                     activation_class = scope_glob in ('**','**/*') ? 'baseline' : 'scoped'}
      provenance rows (relation 'origin') for every evidence ref -> INSERT OR IGNORE; outcome created
    reinforce(target = t ?? m):
      if no target: downgrade to create
      provenance rows (relation 'reinforce'); recompute evidence_count, distinct_session_count, confidence (M6); last_verified_at = E.closed_at
      if target.authority = 'auto' and target.status = 'active':
         ttl_expires_at = E.closed_at + 14d, revalidate_after = +7d, validation_count = evidence_count - 1     -- D4
      if target.status = 'stale' and target.authority = 'auto' and stale_reason = 'ttl_expired': transitionMemory(stale -> active, auto_rule)
      outcome reinforced
    propose_supersede(target = t ?? m) / propose_stale(target):
      if no target: rejected_no_target; continue
      replacement = supersede ? insert candidate exactly as in 'create' with supersedes_memory_id = target.id : NULL
      provenance rows on target (relation 'contradict')
      p = openOrSupportProposal(kind, target, replacement, c)   -- upsert via partial unique index; support keyed by episode
      if target.authority = 'auto' and target.type <> 'policy' and p.support_count >= 2:
         decideProposal(p, accepted, auto_rule); transitionMemory(target -> superseded|stale, auto_rule, proposalId = p.id)
         if replacement: transitionMemory(replacement -> active, auto_rule) with authority 'auto'; outcome applied_auto
      else outcome proposal_opened | proposal_supported
  set c.reconcile_outcome, c.resulting_memory_id, c.resulting_proposal_id
autoActivateEligible(db, touched memory ids)       -- section 6
derivePolicyRules(db); consolidateSweep(db, now)   -- TTL and expiry pass
run.status = reconciled; episode.status = extracted; write_ops += runId; meta.generation += 1
```

Why re-running is a no-op: the run id is a function of episode content and prompt, so an unchanged DB yields the same id and returns at the first line. If the DB changed, the candidate list and therefore the prompt changed, and the new run is new information, not a replay. Even when a different run re-emits the same claims, every write is keyed (memories by `identity_key`, provenance by `(memory_id, span_id, relation)`, support by `(proposal_id, episode_id)`) and every number is recomputed from those sets (P7), so a second application changes no row. A duplicate fact cannot throw (R5): the identity lookup precedes the insert and turns it into `reinforce`; `DuplicateMemoryContentError` stays in `MemoryRepository` but is unreachable from reconcile.

### 4.5 Consolidation (`consolidate(db, now)`)

Invoked as a sweep at the end of every reconcile, by `dream:consolidate`, and by the `SessionStart` catch-up. It merges `auto` rows with semantic similarity above 0.92 into the older row (provenance union via `mergeMemories`), marks `auto` rows with `ttl_expires_at < now` as `stale` with `stale_reason = 'ttl_expired'`, expires candidates and proposals older than 30 days, regenerates `session_summaries` from episodes, and rebuilds the snapshot. It creates no memories from heuristics (R6).

## 5. Read path

All four triggers read the snapshot; `loadSnapshot(path, meta.generation)` opens the DB instead when the stamp mismatches or the file is missing.

- `session_start` (`SessionStart`): `activate({lifecycleTrigger: 'session_start', scopeRef: '.', activationMode: 'startup'})` over snapshot memories with embedding service `null`; output `hookSpecificOutput.additionalContext` via the existing `formatActivatedMemoryAdvisory`. If `episodes.status IN ('queued','failed')` exist, it spawns `harness-memory episode:extract --all-queued` detached.
- `before_model` (`UserPromptSubmit`): query tokens from `prompt`, `scopeRef` = first path-like token or `.`, default mode with BM25 over the serialized MiniSearch index plus scope matching. Deviation: dense retrieval does not run on hook hosts, because loading transformers.js costs seconds per process; the hybrid engine is untouched and is used by the long-lived OpenCode plugin and at write time (`findSemanticNeighbor`).
- `before_tool` (`PreToolUse`), `matchBeforeTool(snapshot, ctx)`:
  1. `ctx = {tool: alias(host_tool_name), scope_ref: extractScopeRef(tool_input), command_text, args_json}`.
  2. Candidates: snapshot memories with `before_tool` in `lifecycle_triggers`, plus `policy_rules` with `trigger_kind = 'before_tool'`.
  3. Tool filter: `relevant_tools` is NULL or contains `ctx.tool`.
  4. Scope filter: `matchesScope(scope_glob, scope_ref)` when `scope_ref` exists; otherwise match when the glob is global or a path-like token in `command_text` matches it.
  5. Signature: a present `command_pattern` must match `command_text` (case-insensitive regex, compiled only for survivors of step 3) and a present `path_glob` must match `scope_ref`; a hit adds 0.3 and marks an event-class hit.
  6. Rank: signature hits first, then `authority = 'human'`, then `calculateMemoryScore` with its unchanged trust multipliers. Deviation: the request passes `maxMemories: 5, maxPayloadBytes: 2048`; engine defaults of 10 and 8 KB are unchanged for `before_model` and `session_start`. A tool-boundary warning that fills 8 KB is noise at the moment the wedge must be sharp.
  7. Output: `hookSpecificOutput.additionalContext` with the warnings block (supported on `PreToolUse` by both hosts). Human-authority `policy` rows with `policy_subtype = 'hard'` add `permissionDecision: "ask"` with `permissionDecisionReason` on Claude Code only; Codex lacks `ask`, so it gets `additionalContext` plus `systemMessage`. Warning-first remains the default.
- `after_tool` (`PostToolUse`, `PostToolUseFailure`): no general activation and no evidence rows (D7). When a failure's `failure_signature` is in `snapshot.failure_index`, return `additionalContext` with the matching pitfall's mitigation. Deviation: `after_tool` stays in the trigger vocabulary, but on hook hosts it fires only through the failure index.

Latency plan for `PreToolUse`: Node startup 35-45 ms, snapshot read and parse 2-4 ms, matching under 5 ms: 50-60 ms typical. The fallback adds `initSqlJs` plus a full DB read (60-120 ms) and occurs only after a writer crashed between rename and snapshot rebuild. The hook has `timeout: 5` and no `onFailure: "block"`, so it never blocks a tool. `npx` is never on the hot path: install writes an absolute `node <path>/dist/bin/hook.js` command.

## 6. Authority model

`authority` is `human` (created, imported, promoted, or accepted by a person) or `auto` (promoted by rule from extraction evidence). Policy rows and global-scope baseline rows are always human.

`autoActivateEligible(memory)`: `type IN ('pitfall','workflow')`, `scope_glob NOT IN ('**','**/*')`, `lifecycle_triggers` contains `before_tool` or `before_model`, `relevant_tools` or `trigger_signature` non-empty, scan safe, `confidence >= 0.8`, and `evidence_count >= 2` distinct episodes, or `>= 1` when the origin episode is a `correction` with `has_explicit_marker = 1` (the user said "never do X again" after a failure). On success: `transitionMemory(candidate -> active, auto_rule)`, `authority = 'auto'`, `ttl_expires_at = now + 14d`, `revalidate_after = now + 7d`.

| Event | Auto row (pitfall/workflow, scoped) | Human row, any policy, any global baseline |
|---|---|---|
| create | candidate, auto-activated when eligible | candidate; `promote_policy` or `promote_global` proposal for review |
| reinforce | TTL extended, `validation_count` recomputed, TTL-stale rows revived | `last_verified_at` updated only |
| propose_supersede / propose_stale | proposal; auto-accepted at 2 distinct-episode supports | proposal; human decision only |
| TTL lapse | `stale`, `stale_reason = 'ttl_expired'` | never |
| contradiction | counts as a support | counts as a support; never applied |

The guard in `transitionMemory` is the single enforcement point: an `auto_rule` or `expiry` actor on a human row throws before any write, so "the LLM never deletes or demotes human-approved memory" is a property of the write path, not a prompt instruction. `proposal:accept <id>` runs the transitions as `human` (an accepted replacement becomes `authority = 'human'`); `proposal:reject <id>` leaves the target untouched and rejects the replacement candidate.

## 7. Host adapters

Verified facts this design depends on:

- Claude Code stdin: common `session_id`, `transcript_path`, `cwd`, `hook_event_name`; per event `tool_name`/`tool_input`/`tool_use_id` (`PreToolUse`), `tool_response` (`PostToolUse`), `error` (`PostToolUseFailure`), `prompt` (`UserPromptSubmit`), `stop_hook_active`/`last_assistant_message` (`Stop`), `source` (`SessionStart`), `reason` (`SessionEnd`, 1.5 s default timeout), `trigger` (`PreCompact`).
- Claude Code stdout: `hookSpecificOutput.additionalContext` on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`; `permissionDecision` `allow|deny|ask|defer` on `PreToolUse`; `systemMessage` is user-visible; matchers are names, `|` lists, or regex; matching hooks run in parallel; `"async": true` hooks run unblocked without timeout enforcement; plugins ship `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}`. The transcript JSONL schema is undocumented, so `transcript_path` is opaque.
- Codex: events `SessionStart`, `SessionEnd`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`, `PreModelRequest`, `PostModelRequest` (no `PostToolUseFailure`); config in `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, or `config.toml`, trusted via `/hooks`; common fields `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `turn_id`; `additionalContext` on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`; `permissionDecision` `allow|deny` only; `SessionEnd` timeout 1 s (max 3); `async: true` hooks, eight concurrent; `apply_patch` also matches `Edit` and `Write`. (unverified) exact `tool_name` strings and rollout location; `hosts/tool-aliases.json` is editable.

| Core action | Claude Code | Codex | OpenCode plugin |
|---|---|---|---|
| session_start activation, catch-up | `SessionStart` | `SessionStart` | first `chat.message` of a session |
| before_model activation, user span, correction detection | `UserPromptSubmit` | `UserPromptSubmit` | `chat.message` + `experimental.chat.system.transform` |
| before_tool matching | `PreToolUse` (matcher `Bash|Edit|Write|MultiEdit|NotebookEdit`) | `PreToolUse` (matcher from alias table) | `tool.execute.before` |
| tool_result span | `PostToolUse` | `PostToolUse` | `tool.execute.after` |
| tool_failure span, failure hint | `PostToolUseFailure` | derived from `PostToolUse` exit code | derived from output |
| close episode, extract | `Stop` (`async: true`) | `Stop` (`async: true`) | `session.idle` (in-process) |
| compact marker | `PreCompact` | `PreCompact` | `session.compacted` |
| session_end marker | `SessionEnd` (`timeout: 1`) | `SessionEnd` | none |

Hook I/O: `hosts/<host>.ts` normalizes stdin into `HostEvent {host, sessionId, cwd, transcriptPath, event, tool?, toolInput?, toolResponse?, error?, prompt?, lastAssistantMessage?}`; `handleHookEvent` returns `{}` or `{"hookSpecificOutput": {"hookEventName": "<event>", "additionalContext": "..."}}` plus `permissionDecision` where applicable. Exit code is always 0; `ask` and `deny` use JSON, never exit 2.

Install: `harness-memory install --host claude-code` writes the `hooks` block into `.claude/settings.json` (or ships `hooks/hooks.json` with `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/hook.js" --host claude-code` as a plugin); timeouts `PreToolUse`/`UserPromptSubmit`/`PostToolUse` 5, `SessionStart` 10, `SessionEnd` 1, `Stop` async. `--host codex` writes `<repo>/.codex/hooks.json` with absolute paths and reminds about `/hooks`; `--host opencode` keeps the `opencode.json` entry. All run migrations, build the snapshot, and run `import`. Distribution: one npm package plus a `.claude-plugin/plugin.json` manifest.

## 8. Concurrency and crash safety

Writers: extractor, consolidate, review and proposal decisions, import, migrator. Readers: hooks (snapshot, fallback DB) and listing CLIs. `withWriteLock(dbPath, fn)`:

1. Create `memory.sqlite.lock` with `fs.openSync(path, 'wx')` containing `{pid, hostname, started_at}`. On `EEXIST`, if the pid is dead (`process.kill(pid, 0)` throws) or the file is older than 120 s, unlink and retry; otherwise wait with jittered backoff up to 5 s, then throw `LockBusyError`.
2. Load the DB, read `meta.generation = g`.
3. Run `fn` inside `BEGIN ... COMMIT`; on throw, `ROLLBACK` and release.
4. `db.export()` to `memory.sqlite.tmp-<pid>`, `fsync`, `renameSync` over `memory.sqlite` (atomic replace on POSIX and via `MoveFileEx` semantics on Windows), with `meta.generation = g + 1` written inside the transaction.
5. `rebuildSnapshot` to `activation-snapshot.tmp-<pid>`, rename, release the lock.

Readers never lock; a rename never yields a torn file, so a reader sees generation `g` or `g + 1`. The ledger is written only by hooks of one session and only by append; the importer processes lines in file order, skips a malformed trailing line (crash mid-append), and records `ledger_lines_imported`, so import is prefix-stable and replayable.

| Failure | Effect | Recovery |
|---|---|---|
| Writer crashes before rename | temp file left, DB unchanged, stale lock | next writer removes both |
| Crash after rename, before snapshot | `snapshot.generation < meta.generation` | hooks fall back to DB; next writer rebuilds |
| Two CLIs at once | second waits up to 5 s | then `LockBusyError`, printed |
| Extractor and `memory:review` at once | serialized | review sees extracted rows after release |
| Host kills async `Stop` hook mid-extraction | episode stays `queued`/`extracting`, stale lock | catch-up re-runs the same `extraction_runs.id` |
| `memory:review` during an in-process plugin session (D1) | plugin opens under the same lock per operation, holds nothing | no lost writes |
| Hook cannot read snapshot or DB | returns `{}` | never blocks the host |

The global DB has its own lock; its writers are CLI-only.

## 9. Policy engine and rule derivation

`derivePolicyRules(db)` runs at the end of every write transaction and makes `policy_rules` a derived table: for every active `policy` memory and each of its `lifecycle_triggers`, upsert `rule_code = 'POL-' || substr(id,1,8) || '-' || trigger`, `memory_id`, `severity = policy_subtype = 'hard' ? 'warning' : 'info'`, `trigger_kind`, `scope_glob`, `tool_pattern = '^(' || relevant_tools.join('|') || ')$'` or NULL, `command_pattern = trigger_signature.command_pattern`, `arg_path_glob = trigger_signature.path_glob`, `message = summary`, `derived_from_updated_at = updated_at`. Rules whose memory is no longer active are deleted; rules with `memory_id IS NULL` are untouched. Invariant: `policy_rules WHERE memory_id IS NOT NULL` equals `derive(memories)` after every commit. `PolicyEngine.evaluate({lifecycleTrigger, scopeRef, toolName, commandText})` matches scope, tool pattern, and command pattern together; scope-only matching survives only for rows without patterns. The `PolicyWarning` shape is unchanged.

## 10. CLI surface and review UX

`harness-memory` keeps `verb:noun`: `install --host`, `hook --host`, `status`, `episode:list [--status]`, `episode:show <id>`, `episode:extract [--session <id> | --all-queued] [--provider] [--dry-run]`, `dream:consolidate`, `memory:add|list|promote|reject|demote|restore|history|export|export-skill|stats|why`, `memory:review`, `memory:trace <id>`, `proposal:list|accept|reject <id>`, `import --from claude-md|agents-md|cursorrules|memory-md [--path]`, `policy:check`, `db:migrate|inspect|rebuild-snapshot`, `eval:baseline|memory|replay`.

Review is exception handling and never enters model context. `SessionStart` returns a one-line user-visible `systemMessage` at most once per day per project when open proposals target human rows or `policy` candidates exist: `harness-memory: 2 proposals and 1 policy candidate await review (harness-memory memory:review)`. `memory:review` lists candidates and proposals with `evidence_count`, `distinct_session_count`, the first provenance span, and the transcript pointer, and accepts `a` (accept or promote), `r` (reject), `s` (skip), `t` (trace). `memory:why` gains `--tool` and `--command` so `before_tool` matching is explainable offline.

Import (`src/cli/import.ts`): bullets and headed sections from `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, and Claude Code `MEMORY.md` become `authority = 'human'`, `source_kind = 'import'`, `activation_class = 'baseline'`, type `policy` when the bullet contains a modal (`must|never|always|do not`) else `workflow`; `identity_key` makes re-import idempotent; `source_ref` records file and line; the op id is `H('import', file_sha256)`.

## 11. Migration from v0.5 databases and from the current module code

Migrations 017-023 run through the existing migrator, extended with one post-migration TypeScript step per version (`src/db/post-migrations/<version>.ts`) for hashing work SQL cannot do. 017 capture tables; 018 extraction tables; 019 alter `memories`, backfill `identity_key`, map `promotion_source` to `authority`, set `source_kind = 'manual'`; 020 proposals and transitions, with one `memory_transitions` row per existing memory (`actor = 'import'`, `reason = 'v019 backfill'`); 021 alter `policy_rules`, then derive rules from active policies; 022 `meta` (`generation = 1`) and `write_ops`; 023 legacy renames plus one synthetic session `legacy:v05` with one `tool_result` span per `legacy_dream_evidence_events` row and one `skipped` episode per legacy session id, and `legacy_dream_memory_evidence_links` converted to `memory_provenance` rows (`relation = 'origin'`, `claim_id = NULL`) so existing candidates keep provenance. Old candidates stay for one review pass and then expire via consolidate. `db:migrate` writes `memory.sqlite.bak-v16` before 017 and builds the first snapshot after 023; downgrade is unsupported.

Code: the keep/rewrite/delete split is the module map in section 2. `MemoryRepository` gains the new columns in `MEMORY_SELECT_COLUMNS` and `mapMemoryRow`; the 315 existing tests are kept wherever their module survives, and `test/zz-repro*.test.ts` become regression tests asserting the opposite outcomes.

## 12. Defect coverage matrix

| ID | Structural elimination |
|---|---|
| R1 | Auto-activation reads `evidence_count` from `memory_provenance`, which `reconcileRun` writes before a memory can exist (M4); no promotion code reads `evidence`. |
| R2 | `scope_glob`, `relevant_tools`, `trigger_signature`, `lifecycle_triggers` are required by `EXTRACTION_SCHEMA` and copied verbatim into `memories`; a claim lacking a valid scope or triggers is `rejected_invalid`. Nothing defaults them. |
| R3 | No `minSessions` gate and no process-lifetime counter; eligibility is `episodes.status = 'queued'`, evaluated per episode by the `Stop` hook, catch-up, or CLI. |
| R4 | `transitionMemory` throws `AuthorityViolationError` for `auto_rule`/`expiry` actors on human rows; the LLM vocabulary is `propose_supersede`/`propose_stale`, which write only `proposals`. |
| R5 | Identity lookup precedes every insert, so a duplicate becomes `reinforce`; writes are keyed and set-derived, so a repeated run is a no-op; one transaction plus atomic file replace means partial writes cannot leak. |
| R6 | `DreamWorker` is deleted; `consolidate` only merges, stales, and expires. Regex survives only as span flags (`failure_signature`, `is_correction`, `explicit_marker`). |
| R7 | One queue (`episodes.status`) and one consumer (`reconcileRun`); nothing else reads or marks episodes. |
| D1 | No process holds the DB across hook calls; every write is load-apply-save under `memory.sqlite.lock` with atomic rename, plugin included; output-text detection of CLI calls is gone. |
| D2 | The prompt is an episode digest with span ids, scopes, tools, commands, and failure signatures; the output schema carries every activation field. |
| D3 | Spans keep 4 KB each, episodes close at semantic boundaries (`Stop`, correction, resolution, compact), and `session_id` is a column of every span. |
| D4 | `reinforce` recomputes `ttl_expires_at`, `revalidate_after`, and `validation_count` for auto rows inside reconcile; consolidate enforces TTL on every run. |
| D5 | `derivePolicyRules` runs at every commit from active `policy` memories; `PolicyEngine.evaluate` matches tool and command patterns, not scope alone. |
| D6 | No hook returns review content in `additionalContext`; the only in-host review surface is a rate-limited user-visible `systemMessage`. |
| D7 | `PostToolUse` appends one ledger line and performs no activation; provenance rows are created only by reconcile from claims the LLM cited. |

## 13. Eval plan

1. Read-path regression: the existing 12-scenario harness replay (`eval:memory`) must pass unchanged, since the activation engine is unchanged.
2. Write-path replay (`eval:replay`, new): a fixture corpus of 12 ledgers, one per corpus scenario, each containing the episode that should produce that scenario's memory (two sessions with the Prisma stringify failure for scenario 7), with recorded extractor responses under `provider = 'replay'`. Assertions: the resulting memory has the expected `scope_glob`, `lifecycle_triggers`, and `trigger_signature`; it activates in the matching read-path scenario (closing the loop from 7 to 4); applying the replay twice yields byte-identical `memories`, `memory_provenance`, and `proposals` exports; a hallucinated `propose_supersede` against a human row opens a proposal and changes no status.
3. Live A/B on the same corpus, three seeds each: `md_only` (CLAUDE.md), `native_auto_memory` (`MEMORY.md` seeded from the `import` output), `md_plus_memory` (this design), scored with the existing miss taxonomy and annotation rubric: important (critical plus high) misses, false-warning rate, stale activations, and hot-path p95 from `activation_logs.duration_ms`. The continue threshold stays at a 30% reduction of important misses versus `md_only`; the claim against native auto-memory is measured on the five `before_tool` scenarios, where `MEMORY.md` structurally cannot fire.
4. Dogfood metrics from `audit_log`: episodes closed, queued, extracted per day; claims per outcome; proposals opened versus accepted; `before_tool` hits per 100 tool calls.

## 14. Risks, effort estimate, open questions

Risks: the snapshot can drift (mitigated by the generation stamp and fallback); failure-signature rules and correction lexicons cover English and Korean only (editable JSON); `--json-schema` and `--output-schema` may differ across installed versions (fallback: parse the first JSON object from text); async `Stop` hooks may be killed at exit (the ledger keeps this safe but delays extraction); each `PostToolUse` costs a Node startup of about 40 ms that the host waits on, so the append must stay trivial.

Effort (solo developer): ledger, segmenter, importer, migrations 017-023 with tests, 2 weeks; extractor, providers, schema, reconcile, consolidate, 2.5 weeks; transitions, proposals, auto-activation, rule deriver, 1 week; hook adapter, host normalizers, install, snapshot, locking, 2 weeks; CLI review, trace, import, 1 week; replay eval and live A/B tooling, 1.5 weeks. About 10 weeks to a dogfood-ready 0.6.0.

Open questions: exact Codex `tool_name` values and whether Codex `tool_response` exposes shell exit codes; whether Codex `transcript_path` is readable JSONL and where rollouts live; whether a Claude Code async `Stop` hook survives `SessionEnd`; whether to compute `embedding_summary` at reconcile time when the model is absent; default extractor model and daily cost ceiling; whether global-scope proposals land in `global.sqlite` or in the project DB as `baseline`; whether `after_tool` leaves the public trigger vocabulary in 0.7 if the failure index remains its only consumer.
