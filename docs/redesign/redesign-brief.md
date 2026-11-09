# harness-memory redesign brief: keep the concept, rebuild the core

This brief is the shared input for every agent in the redesign workflow. Read it fully before doing anything else.

## 1. Context and reference material

- Read-only reference clone of the current code (v0.5.1, last commit 2026-04-09): `C:\Users\choey\AppData\Local\Temp\hm-src\repo`
  Do not modify anything under that path. `node_modules` is installed there; `npx vitest run --config vitest.config.ts` passes (315 tests). Two extra files `test/zz-repro.test.ts` and `test/zz-repro2.test.ts` are reproduction tests for the defects listed in section 5 (not part of the original repo).
- Full code review with confirmed defects (Korean): `C:\Users\choey\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\scratch-workspaces\feca061f-39ea-4807-ad72-f5d97afb93b0\17046915-36cb-456f-961c-3631b047dc8c\scratch-2026-11-07-f2d868\harness-memory-core-review.md`
- Original product thinking, in the clone: `docs/product/final-positioning.md`, `docs/product/wedge.md`, `docs/product/roadmap.md`, `docs/spec/lifecycle-triggers.md`, `docs/spec/dream-cycle.md`, `docs/spec/promotion-rubric.md`, `docs/spec/memory-taxonomy.md`, `research/eval/continue-kill-memo.md`, `README.md`.
- Key source files to read before designing: `src/plugin/opencode-plugin.ts` (host wiring, conversation buffer, gates, auto-promotion, review digest), `src/adapters/types.ts` and `src/adapters/opencode-adapter.ts` (the host-agnostic core boundary), `src/dream/worker.ts`, `src/dream/llm-extract.ts`, `src/dream/repository.ts`, `src/cli/dream-extract.ts` (gates), `src/promotion/auto-promoter.ts`, `src/activation/engine.ts`, `src/activation/mode-default.ts`, `src/activation/retrieval-helpers.ts`, `src/policy/engine.ts`, `src/memory/repository.ts`, `src/db/migrations/*.sql`, `src/db/schema/types.ts`, `src/security/scanner.ts`, `src/cli/install.ts`.

## 2. The product in one paragraph (what the redesign must keep)

harness-memory is local-first project memory for AI coding harnesses. Its wedge is not "remember more"; it is **timing**: durable project knowledge (policies, pitfalls, workflows, architecture constraints, decisions) surfaces at the lifecycle boundary where it matters, especially **before a tool runs**, instead of being dumped into the system prompt at session start. Its second idea is **evidence is not memory**: raw signals are captured cheaply and continuously, but memories are curated knowledge with a type, a scope, lifecycle triggers, a confidence, and a status lifecycle. Its third idea is **governed autonomy**: the LLM does the extraction, but authority over behavior-changing rules and over human-approved memories stays with the human. It is MIT, zero native dependencies (sql.js WASM, transformers.js e5-small embeddings, MiniSearch BM25), no telemetry, no account, no daemon, and no LLM call in the per-tool-call hot path.

Competitive context (already decided, do not re-litigate): claude-mem (114k stars) is an observation log with search, run by a second LLM agent per tool call, with a Bun worker + Chroma sidecar and a paid observer tier. Claude Code also ships native auto-memory (MEMORY.md, on by default). harness-memory positions itself as complementary: "claude-mem remembers what happened; harness-memory stops the agent at the moment it is about to repeat a known mistake." Mem0/Hindsight/Basic Memory/agentmemory/Supermemory occupy the generic-memory space.

## 3. Hard constraints

Keep:
1. The five memory types: `policy`, `workflow`, `pitfall`, `architecture_constraint`, `decision`. Policy = behavior-changing rule, warning-first, never hard-block by default.
2. The four lifecycle triggers as the activation vocabulary: `session_start`, `before_model`, `before_tool`, `after_tool`.
3. The memory status lifecycle: `candidate`, `active`, `stale`, `superseded`, `rejected`, plus whatever is needed for proposals (see section 4).
4. The module layout: `src/activation`, `src/dream`, `src/promotion`, `src/policy`, `src/security`, `src/adapters`, `src/db`, `src/cli`, `src/retrieval`, `src/audit`. Modules may be renamed or internally rewritten, but the decomposition stays recognizable.
5. The ActivationEngine design: hybrid dense + BM25 + RRF, scope glob matching, budgets (10 memories / 8 KB payload), type quotas, progressive disclosure, baseline/startup/scoped/event activation classes, 4 activation modes. It is well built and well tested.
6. Security scanner, migrator (16 migrations, `PRAGMA user_version = 16`), audit logger, file logger, eval/benchmark infrastructure, the adapter interface types (`AdapterBeforeModelInput`, `AdapterBeforeToolInput`, `AdapterAfterToolInput`, ...) as the host-agnostic boundary.
7. Zero native deps, local-first, MIT, no telemetry, no account, no daemon as the default runtime, zero LLM calls per tool call.
8. Extraction and consolidation use the host's own headless CLI (`claude -p`, `codex exec`) or OpenCode SDK behind one provider interface; no API keys required.

Decided in conversation with the author (treat as settled):
- Target hosts are **Claude Code and Codex first**; OpenCode becomes the third adapter. Hook-based hosts run each hook event as a fresh, short-lived process that reads JSON on stdin and writes JSON on stdout. There is no long-lived plugin process to hold state in.
- **Human judgment is kept but inverted and minimal.** Auto-activate low-risk types (`pitfall`, `workflow`) when they carry scope + trigger and have enough evidence; mark them `authority = auto` with TTL and automatic stale-on-contradiction. Human gate only for: (a) `policy` type, (b) supersede/stale of a human-approved memory (LLM may only propose), (c) global-scope baseline memories. The LLM never deletes or demotes human-approved memory on its own.
- **Save triggers are semantic, not count-based.** Three capture moments: correction events (user message after a tool failure, or containing correction language), failure→resolution pairs within a scope, and turn boundaries (Stop). Extraction runs per closed episode, not per 5 buffered lines. Dream consolidation runs at idle/session end over episodes and only merges, reconciles, and stales; it does not invent candidates from regex.
- Hot path target: PreToolUse end-to-end under ~100 ms on a typical repo, without a daemon.

## 4. Redesign scope (what must change)

A. **Host integration and process model.** Claude Code and Codex hooks (stateless processes) as first-class; OpenCode in-process plugin as an adapter over the same core. Design where state lives between hook invocations (SQLite file, transcript file, small JSON state), how the embedding model is avoided or amortized on the hot path, and how session identity is resolved.
B. **One write path.** Episode capture → structured LLM extraction → deterministic reconcile → authority-tiered activation. Define the extraction output schema so that it carries everything activation needs: `type`, `summary`, `details`, `scope_glob`, `relevant_tools`, `trigger_signature` (tool + args/command pattern for before_tool matching), `lifecycle_triggers`, `confidence`, `evidence_refs`, and the proposed action (`create` / `reinforce` / `propose_supersede` / `propose_stale`).
C. **Data model.** Episodes, trigger signatures, authority, proposals, provenance links, TTL/revalidation that actually runs, and a migration path from existing v0.5 databases.
D. **Concurrency and crash safety.** Several short-lived hook processes and CLI commands touch one SQLite file; sql.js has no file locking and writes the whole file. Design a safe scheme (lock file + load/apply/save, append-only ops log applied by the next writer, or another justified approach) with explicit failure modes.
E. **Policy engine.** Match on tool name and args/command signature, not scope alone. A production writer for rules (derived from `policy` memories), not fixtures.
F. **Review and CLI UX.** No review inbox injected into the system prompt. Review is exception handling: CLI digest, `memory:review`, proposals queue.
G. **Import.** Baseline import from `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, and Claude Code native `MEMORY.md`.

## 5. Confirmed defects the redesign must structurally eliminate

Reproduced with tests against the current code:

- R1. LLM-created candidates can never be auto-promoted: `executeExtractionActions` creates no evidence links, and `auto-promoter` counts the `evidence` table, so the count is always 0 against a `>= 3` gate. Candidates expire after 30 days.
- R2. LLM-created memories are hard-coded to `scopeGlob = "**/*"` and `lifecycleTriggers = ["before_model"]`, so none of them can ever fire at `before_tool`. The product's wedge receives no LLM-extracted knowledge.
- R3. Extraction runs at most once per process lifetime: the `minSessions >= 1` gate counter is incremented only at plugin init and reset to 0 after each extraction.
- R4. LLM `supersede` / `stale` actions immediately demote human-approved active memories without review, while `create` requires review. A single hallucination removes an approved memory and leaves only a candidate.
- R5. Re-extracting an identical fact throws `DuplicateMemoryContentError`; the whole batch fails before `markEvidenceEventsConsumed`, so the same batch is retried forever and partial writes leak.
- R6. Deterministic DreamWorker candidates are template text ("Pitfall around route.ts (pitfall:...:enoent)") with raw evidence lines as details. They carry no knowledge.
- R7. Manual `dream:run` consumes `conversation-batch` evidence as a workflow candidate, starving the LLM extraction queue. The two write paths destroy each other's inputs.

Confirmed by reading:

- D1. The OpenCode plugin holds the sql.js DB in memory and overwrites the whole file on every tool call; a `memory:review` run in another terminal is silently lost. Detection relies on spotting the string "harness-memory" in bash tool output.
- D2. The extraction prompt asks for mem0-style "user preferences, architecture decisions, constraints, workflows" and its output schema has no scope, tools, trigger, or command signature.
- D3. Capture is count-based (flush every 5 entries), tool output truncated to 300 chars, batch capped at 4000 chars, session attribution taken from the last entry.
- D4. `reinforce` never calls `revalidateMemory`, so auto-promoted memories die at the 14-day TTL regardless of reinforcement.
- D5. Policy engine matches scope glob only; nothing in production writes `policy_rules`.
- D6. The review inbox is injected into the system prompt every session with instructions for the model to nag the user.
- D7. Every tool call writes one 2 KB evidence row per activated memory.

Not a problem: activation hot path is ~18 ms per call with 300 active memories (lists all memories and rebuilds the MiniSearch index per call).

## 6. Host facts

A facts agent verifies these against current documentation and produces a fact sheet; designers must use that fact sheet, not this section. Prior knowledge to verify:

Claude Code hooks: configured in `settings.json` (`hooks` key) or in a plugin's `hooks/hooks.json`. Events include `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`. Input is JSON on stdin with fields such as `session_id`, `transcript_path` (JSONL of the conversation), `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `prompt`, `stop_hook_active`. Output: exit code 0 with optional JSON on stdout; `hookSpecificOutput.additionalContext` (SessionStart, UserPromptSubmit, PostToolUse, and PreToolUse in recent versions) injects context; `PreToolUse` can return `hookSpecificOutput.permissionDecision` = `allow` / `deny` / `ask` with `permissionDecisionReason`; exit code 2 blocks with stderr fed back to the model; `systemMessage` shows a warning to the user; `decision: "block"` with `reason` on `Stop` makes Claude continue. Hooks have a default timeout (60 s) configurable per hook. Plugins are distributed via marketplaces (`/plugin marketplace add owner/repo`) with a `.claude-plugin/plugin.json` manifest.

Codex (OpenAI) hooks: a hooks system exists with events named like Claude Code's (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SubagentStart`, `Stop`), configured in `~/.codex/hooks.json` or `config.toml`, JSON on stdin with `cwd`, `hook_event_name`, `tool_name`, `tool_input`; session transcripts ("rollouts") are JSONL files under `~/.codex/sessions/`. `codex exec` is the headless CLI. Verify names, fields, and output contract.

## 7. Deliverables

### 7.1 Designers (four independent designs)

Each designer writes a complete design to `C:\Users\choey\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\scratch-workspaces\feca061f-39ea-4807-ad72-f5d97afb93b0\17046915-36cb-456f-961c-3631b047dc8c\scratch-2026-11-07-f2d868\design-candidates\<slug>.md` in English, 3000 to 6000 words, with exactly these sections:

1. Angle and principles
2. Architecture: modules, processes, where state lives
3. Data model: DDL-level tables and columns, status machines, indexes
4. Write path: capture → extraction → reconcile → activation, with the extraction JSON schema
5. Read path: the four triggers, `before_tool` matching algorithm, budgets, latency plan
6. Authority model: what is automatic, what is gated, how proposals work
7. Host adapters: event mapping tables for Claude Code, Codex, OpenCode; hook I/O; install/distribution
8. Concurrency and crash safety
9. Policy engine and rule derivation
10. CLI surface and review UX
11. Migration from v0.5 databases and from the current module code
12. Defect coverage matrix: R1–R7 and D1–D7, each with how the design makes it structurally impossible
13. Eval plan: how to prove it beats markdown-only and native auto-memory on the 12-scenario corpus
14. Risks, effort estimate (solo developer, weeks), open questions

Designs must be concrete: name tables, columns, functions, files, hook event names, JSON fields. Where you change a decision from the brief, say so explicitly and justify it.

### 7.2 Final spec

Written in **Korean** (code identifiers, schema names, hook names in English) to `C:\Users\choey\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\scratch-workspaces\feca061f-39ea-4807-ad72-f5d97afb93b0\17046915-36cb-456f-961c-3631b047dc8c\scratch-2026-11-07-f2d868\harness-memory-redesign-spec.md`, 5000 to 9000 words, sections:

1. 목표와 비목표
2. 유지 / 제거 / 변경 요약표
3. 아키텍처 (모듈, 프로세스 모델, 상태의 위치)
4. 데이터 모델 (DDL 수준, 상태 머신, 마이그레이션 017+)
5. 쓰기 경로 (에피소드 → 추출 → reconcile → 활성화), 추출 JSON 스키마 포함
6. 읽기 경로 (4 트리거, before_tool 매칭 알고리즘, 예산, 지연 계획)
7. 권한 모델 (auto / human, 제안 큐)
8. 호스트 어댑터 (Claude Code, Codex, OpenCode 매핑표, 훅 I/O, 설치 및 배포)
9. 동시성과 크래시 안전성
10. 정책 엔진과 규칙 파생
11. CLI 표면과 리뷰 UX
12. 결함 커버리지 매트릭스 (R1–R7, D1–D7)
13. 평가 계획
14. 구현 로드맵 (마일스톤, 주 단위, 솔로 개발자 기준)
15. 열린 질문과 결정 필요 사항
