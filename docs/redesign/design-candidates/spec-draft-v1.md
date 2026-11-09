# harness-memory v0.6 통합 재설계 명세

입력: `redesign-brief.md`, `harness-memory-core-review.md`(R1–R7, D1–D7), 후보 설계 4종(`hook-native-minimal`, `episode-data-model`, `autonomy-with-guardrails`, `operations-robustness`), 심사 3종(product-fidelity, engineering, operations-and-portability). 참조 코드는 v0.5.1 클론(`C:\Users\choey\AppData\Local\Temp\hm-src\repo`, 읽기 전용)이며, 이 문서의 코드 사실 인용은 모두 그 클론에서 직접 확인했다.

골격은 종합 1위인 `hook-native-minimal`이다. 그 위에 세 심사관이 공통으로 추천한 접목을 올리고, 심사관이 지적한 치명 결함 여덟 가지를 설계 결정으로 제거했다: before_tool 전달 타이밍(§7), Codex `ask` 오용(§7.2), 단일 LLM 주장에 의한 auto 강등(§5.7), `identity_key` UNIQUE 충돌(§4.1), 열린 파일 rename(§5.2), 훅의 sql.js 폴백(§6.2), shell-form 설치(§8.7), transcript 파싱(§5.1). 브리프와 다른 결정은 §15.1에 근거와 함께 모았다.

호스트 사실 출처 주의: `design-candidates/host-hook-facts.md`는 끝내 작성되지 않았다. §8의 호스트 사실은 세 심사관이 2026-11-08에 `code.claude.com/docs/en/{hooks,cli-reference,headless,memory,settings-reference}`, `learn.chatgpt.com/docs/{hooks,non-interactive-mode}`, `opencode.ai/docs/build/plugins/{,server,migrate-v1}`에서 독립적으로 검증해 일치한 항목만 "검증"으로 표기했고, 불일치하거나 아무도 확인하지 못한 항목은 "(미검증)"으로 표기했다. 구현 전에 §15.2의 미검증 목록을 사실 시트로 확정해야 한다.

---

## 1. 목표와 비목표

### 1.1 목표

- **G1 wedge를 실제로 전달한다.** 추출된 지식이 툴이 실행되기 *전에* 모델 또는 사용자에게 도달해야 한다. 검증된 사실로 Claude Code `PreToolUse`의 `additionalContext`는 툴 결과와 함께 도달하고, 실행 전에 작동하는 출력은 `permissionDecision: "ask"`/`"deny"`뿐이다. 따라서 "경고 우선"과 "실수 직전에 멈춘다"는 메모리 단위 `enforcement` 사다리(§7)로 결정한다.
- **G2 쓰기 경로 하나.** 에피소드 → 구조화 추출 → 결정적 reconcile → 권한 티어 활성화. 정규식 후보 공장, 대화 버퍼, 세션 카운터 게이트, dream evidence 상태 머신은 수리하지 않고 삭제한다.
- **G3 권한은 쓰기 경로의 불변식.** `authority` 컬럼과 단일 전이 함수 `transitionMemory`가 사람 메모리의 상태를 LLM 경로가 바꿀 수 없게 만든다. 관례가 아니라 타입과 테스트로 보장한다.
- **G4 핫패스는 파일 하나를 읽는다.** `PreToolUse` 프로세스는 sql.js, minimatch, MiniSearch, transformers.js를 로드하지 않는다. 프로세스 내부 p50 ≤ 70 ms, p95 ≤ 90 ms(300 메모리 기준, CI 게이트). 데몬 없음.
- **G5 "아무것도 저장되지 않는다"에 답한다.** 훅 호출마다 한 줄 로그, `doctor`/`status`/`trace`가 결함 위치를 이름으로 말한다.
- **G6 v0.5 데이터베이스를 손실 없이 올린다.** R2 피해자는 `fix_scope` 제안으로, 미처리 `conversation-batch`는 레거시 에피소드로 한 번 재추출된다.
- **G7 첫 사용자(긴 `CLAUDE.md`를 가진 Claude Code 파워 유저)가 2주 안에 가치를 본다.** `import`가 첫날 scope와 시그니처를 가진 규칙을 만들고, 사용자 교정 한 번이 다음 턴의 `PreToolUse`에서 발화한다.

### 1.2 비목표

범용 관찰 로그·검색(claude-mem의 영역), 상주 데몬이나 임베딩 사이드카, 핫패스의 밀집 검색, 시스템 프롬프트 리뷰 인박스, transcript 파싱, Codex `PreModelRequest` 주입(0.7), heeded-fire 추론(0.7), 글로벌 메모리 자동 승격, 다중 머신 동기화, 신뢰 티어·모순 예산·일일 활성화 캡 같은 보조 노브(§15.3).

---

## 2. 유지 / 제거 / 변경 요약표

| 구분 | 항목 | 비고 |
|---|---|---|
| 유지 | 다섯 타입, 네 트리거, 상태 어휘 `candidate/active/stale/superseded/rejected` | 제안 상태는 `proposals` 테이블에 둠 |
| 유지 | `ActivationEngine`(dense+BM25+RRF, scope glob, 예산, 타입 쿼터, 4 모드, 4 클래스) | 생성자 타입을 `MemoryReader`로 넓히고 lexical 지연 생성(§6.4); 훅 호스트는 dense 비활성 |
| 유지 | 보안 스캐너, audit/file 로거, eval 인프라, 어댑터 타입, 마이그레이션 001–016, `revalidateMemory`, 신뢰 배수 | 스캐너에 추출 소스 모드(§5.6), 신뢰 배수는 `authority` 기준 |
| 유지 | 마이그레이터(SQL 파일 순차 실행) | `runMigrationsOnDb(db)`로 분리해 원자적 writer 안에서 `.bak-v16` 선행 실행 |
| 유지 | sql.js, MiniSearch, minimatch(쓰기 측), MIT, 텔레메트리·계정 없음 | — |
| 제거 | `DreamWorker` 후보 합성, `ConversationBuffer`, 게이트 파일, `isHarnessMemoryCliCall`/`reloadDbFromDisk`, 리뷰 다이제스트 주입, `summary-generator.ts`, `dream-*` CLI, `fixtures-add-policy-rules`(테스트로) | R3, R6, R7, D1, D3, D6 |
| 제거 | 툴 호출당 evidence 행(2 KB) | D7; 발화는 ledger 한 줄 |
| 제거 | `@xenova/transformers` 필수 의존 | `optionalDependencies` + `install --with-embeddings`; sharp 네이티브 바이너리가 "zero native deps"를 깨뜨림 |
| 변경 | 추출: 에피소드 단위, 구조화 스키마(§5.5), V1–V9, 결정적 reconcile, `write_ops` 멱등성 | R1, R2, R4, R5, D2 |
| 변경 | 저장소: `memories` 재구축(017), `episodes/extraction_runs/write_ops/meta`(018), `proposals/proposal_support/memory_provenance/memory_transitions`(019), `policy_rules`(020), 레거시 폴드(021); `user_version = 21` | §4 |
| 변경 | 정책 엔진: 툴 + 인자 시그니처, 커밋마다 `policy_rules` 파생 재구축 | D5 |
| 변경 | 호스트: Claude Code·Codex 훅(exec-form, 절대 node 경로), OpenCode V2 | §8 |
| 변경 | 동시성: 훅은 스냅샷 읽기 + ledger append, writer는 worker와 CLI, lock + tmp/fsync/rename + `.prev` | D1 |
| 변경 | 리뷰: CLI 예외 처리, 세션에는 사용자용 `systemMessage` 한 줄만 | D6 |

---

## 3. 아키텍처 (모듈, 프로세스 모델, 상태의 위치)

### 3.1 프로세스

| 프로세스 | 진입점 | 수명 | 로드 | 쓰기 |
|---|---|---|---|---|
| hook | `dist/hook.js <event>` (단일 번들, `module.enableCompileCache()`) | 50–90 ms, 이벤트당 1회 | `snapshot/active.v1.json`; `prompt`/`session-start`만 `lexical.v1.json` + MiniSearch | `ledger/*.jsonl` append, `state/*.json`(prompt/stop만), `queue/*.json`(stop), `logs/hooks.log` |
| worker | `dist/worker.js extract\|dream\|reindex\|import` | 1–120 s, 분리 실행 1회 | sql.js, 선택적 임베딩, 호스트 headless CLI | `memory.sqlite` + 스냅샷(lock 하), `raw/*.json`, `logs/worker.log` |
| CLI | `dist/bin/harness-memory.js`(직접 디스패치, `spawnSync` 이중 기동 제거) | 대화형 | sql.js | 동일 lock 규율 |
| OpenCode 플러그인 | `dist/plugin/index.js`(V2 `Plugin.define`) | 호스트 수명 | 스냅샷(mtime 캐시) | DB 상주 없음; 쓰기는 worker 스폰 |

"분리 실행 1회 worker"는 `spawn(process.execPath, [workerPath, ...], {detached: true, stdio: 'ignore', env: {...process.env, HARNESS_MEMORY_DISABLE: '1'}}).unref()`로 띄우고 1분 안에 끝난다. 포트도 다음 이벤트도 기다리지 않으므로 데몬이 아니다. 검증된 사실로 Claude Code는 `-p` 종료 시 실행 중인 async 훅을 죽이고 "완전히 분리된 프로세스로 시작하라"고 안내하며 Codex는 세션 종료 시 미완료 async 훅을 취소하므로, 추출을 async 훅 안에서 돌리는 설계(`episode-data-model`)는 채택하지 않는다.

### 3.2 상태의 위치 (`<repo>/.harness-memory/`)

| 경로 | 내용 | writer | reader |
|---|---|---|---|
| `memory.sqlite`, `.prev`, `.bak-v16` | 진실의 원천 | worker, CLI (lock) | worker, CLI |
| `snapshot/active.v1.json` | active 메모리(임베딩 제외, 사전 컴파일 scope regex, 시그니처), 정책 규칙, `failure_index`, 카운트, `source {mtime_ms, size}`, `db_generation` | 모든 DB writer, 저장 직후 tmp+rename | 모든 훅 |
| `snapshot/lexical.v1.json` | `MiniSearch.toJSON()` + `recent_summaries` | 동일 | `prompt`, `session-start` 훅만 |
| `ledger/<host>-<session_key>.jsonl` | 세션의 원시 이벤트, append-only, 세션 중 rename 없음 | 훅 | `stop` 훅(바이트 범위), worker |
| `state/<host>-<session_key>.json` | `{turn_key, turn_start_offset, last_scope_ref, pending_failures[]}`, tmp+rename | `prompt`, `stop` 훅만 | 모든 훅 |
| `queue/<episode_id>.json` | 에피소드 디스크립터(= 큐 항목) | `stop`/`precompact`/`session-end` 훅 | worker |
| `raw/<run_id>.json` | provider 원본 출력 캐시(24 h; `suspect`는 7 d) | worker | worker, `episodes:show` |
| `locks/{db,worker,reindex}.lock/` | `mkdirSync` 원자 디렉터리 lock, 내부 `owner.json` | 획득자 | — |
| `logs/hooks.log`, `logs/worker.log`, `config.json`, `install-manifest.json` | 호출당 한 줄 로그(5 MB × 3 회전), 설정, 설치가 건드린 파일과 해시 | 전원 / install | `doctor`, eval |
| `worker/` | headless CLI용 빈 cwd(`CLAUDE.md`, `.claude/`, `.codex/` 없음) | — | provider 자식 |
| `~/.harness-memory/global.sqlite` + `snapshot/` | 글로벌 baseline(human 전용) | CLI `--global` | 훅(두 번째 읽기 전용 스냅샷) |

### 3.3 모듈 맵 (분해 유지, 내부 재작성)

| 모듈 | 신규/재작성 | 삭제 |
|---|---|---|
| `src/activation` | `MemoryReader` 인터페이스, `snapshot-reader.ts`, `signature.ts`(공용 매처), `tool-vocabulary.ts`, `signature_mismatch`, lazy lexical; engine·modes·fusion·lexical·scope 유지 | — |
| `src/dream` | `ledger.ts`, `episode.ts`, `extract/{schema,prompt,validate}.ts`, `extract/providers/{claude,codex,opencode,replay}.ts`, `reconcile.ts`, `consolidate.ts`, `worker.ts`(진입점) | 구 `worker.ts`, `llm-extract.ts`, `repository.ts`(evidence 상태 기계) |
| `src/promotion` | `transitions.ts`(`transitionMemory`, `AuthorityViolationError`), `authority.ts`(`decideTier`, `enforcementDefault`), `proposals.ts`; `revalidateMemory` 유지 | `auto-promoter.ts` |
| `src/policy` | `engine.ts`(툴+시그니처), `derive.ts`(커밋마다 재구축) | — |
| `src/security` | `scanMemoryContent(..., {source: 'extraction'})`, `self-reference.ts` | — |
| `src/adapters` | `hook-core.ts`(무상태 이벤트 코어), `hosts/{claude-code,codex}.ts`, `hook-io.ts`, `opencode-adapter.ts`(얇게); `types.ts` 확장 | 플러그인 시대 세션 추적 |
| `src/db` | `migrations/017–021`, `store.ts`(`withWriteLock`, `saveAtomic`, `verifyHeader`, `recoverFromPrev`), `locks.ts`, `snapshot.ts`, `post-migrate.ts`; 마이그레이터는 `runMigrationsOnDb(db)`로 분리 | — |
| `src/cli` | `install/uninstall/doctor/status/review/proposals-*/episodes-*/trace/import/snapshot-rebuild/bench-hook/eval-latency/eval-replay` | `dream-*`, `fixtures-add-policy-rules` |
| `src/retrieval`, `src/audit` | 세션 요약은 worker가 `episode_summary`로 upsert; audit 이벤트 `episode_closed/extraction/reconcile_action/proposal/transition/auto_activation_shadow`(훅은 파일 로그만) | `summary-generator.ts`, `buffer_*`/`gate_check` 이벤트 |
| `src/plugin`, 루트 | V2 `Plugin.define` 위의 얇은 매핑; `src/hook.ts`, `src/worker.ts` 단일 번들 진입 | 버퍼, 다이제스트, DB 상주 |

### 3.4 세션·턴 식별

`session_key = sha1(host + ':' + session_id).slice(0, 16)`; `session_id`는 Claude Code·Codex stdin 공통 필드, OpenCode는 `sessionID`. 턴 키는 Claude Code `prompt_id`, Codex `turn_id`(둘 다 검증된 공통 입력), OpenCode는 메시지 id. 에피소드 id는 `createDeterministicId('episode:' + host + ':' + session_id + ':' + turn_key)`이므로 같은 턴을 두 번 닫아도 같은 id가 나온다. 서브에이전트 이벤트(`agent_id`)는 부모 세션 ledger에 `agent_id`를 달아 기록하고, 기본적으로 에피소드에서 제외한다(`capture.subagents=true`로 포함). 프로젝트 루트는 `cwd`의 조상 중 `.harness-memory/`가 있는 첫 디렉터리, 없으면 `.git/`.

---

## 4. 데이터 모델 (DDL 수준, 상태 머신, 마이그레이션 017+)

마이그레이션은 기존 관례(SQL 파일 하나, 마이그레이터가 `PRAGMA user_version` 설정)를 따른다. 최종 `user_version = 21`. 모든 마이그레이션은 §9의 원자적 writer 안에서 `memory.sqlite.bak-v16` 생성 후 메모리 내 DB에 적용되고, 실패하면 백업이 복원된다(현재 마이그레이터는 트랜잭션 없이 `writeFileSync`로 저장하므로 이 래핑이 필수다).

### 4.1 `017_memories_authority.sql`: `memories` 재구축

마이그레이션 007의 `identity_key TEXT UNIQUE`는 같은 fact의 `superseded` 행과 새 행을 충돌시키므로 테이블을 재구축해 "살아 있는 상태에 한정한 부분 유니크 인덱스"로 바꾼다. `identity_key` 공식은 그대로 두어 `MemoryRepository`와 기존 테스트가 계속 동작하고, 중복 판정은 새 `semantic_key`가 맡는다.

```sql
PRAGMA foreign_keys = OFF;

CREATE TABLE memories_new (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  identity_key TEXT,                                 -- 기존 공식 유지, UNIQUE 제거
  semantic_key TEXT,                                 -- sha256(type|scope_glob|signature_key|normalize(summary))
  type TEXT NOT NULL CHECK(type IN ('policy','workflow','pitfall','architecture_constraint','decision')),
  summary TEXT NOT NULL,
  details TEXT NOT NULL,
  scope_glob TEXT NOT NULL,
  activation_class TEXT NOT NULL DEFAULT 'scoped' CHECK(activation_class IN ('baseline','startup','scoped','event')),
  lifecycle_triggers TEXT NOT NULL,
  embedding BLOB,
  embedding_summary BLOB,
  relevant_tools_json TEXT,
  trigger_signature_json TEXT,                       -- §4.6
  signature_key TEXT NOT NULL DEFAULT '',            -- 시그니처 정규 직렬화, 없으면 ''
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  importance REAL NOT NULL CHECK(importance >= 0 AND importance <= 1),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','active','stale','superseded','rejected')),
  status_reason TEXT,                                -- 'ttl_expired' | 'proposal:<id>' | 'human:<cmd>' | 'import:removed'
  supersedes_memory_id TEXT REFERENCES memories(id),
  superseded_by_memory_id TEXT,
  promotion_source TEXT NOT NULL DEFAULT 'manual',   -- 읽기 전용, 한 릴리스 유지
  authority TEXT NOT NULL DEFAULT 'human' CHECK(authority IN ('human','auto')),
  enforcement TEXT NOT NULL DEFAULT 'advise' CHECK(enforcement IN ('advise','confirm','soft_deny','deny')),
  source_kind TEXT NOT NULL DEFAULT 'manual' CHECK(source_kind IN ('manual','import','extraction','legacy')),
  source_ref TEXT,                                   -- 'import:CLAUDE.md#L12' | 'episode:<id>'
  ttl_expires_at TEXT,
  revalidate_after TEXT,
  validation_count INTEGER NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,         -- 파생: COUNT(DISTINCT episode_id) in memory_provenance
  evidence_score REAL NOT NULL DEFAULT 0,            -- 파생: SUM(episodes.evidence_weight), origin/reinforce
  distinct_session_count INTEGER NOT NULL DEFAULT 0,
  fire_count INTEGER NOT NULL DEFAULT 0,
  last_fired_at TEXT,
  contested INTEGER NOT NULL DEFAULT 0,
  open_proposal_id TEXT,
  needs_scope INTEGER NOT NULL DEFAULT 0,
  policy_subtype TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT
);

INSERT INTO memories_new (id, content_hash, identity_key, type, summary, details, scope_glob, activation_class,
  lifecycle_triggers, embedding, embedding_summary, relevant_tools_json, confidence, importance, status,
  supersedes_memory_id, promotion_source, ttl_expires_at, validation_count, policy_subtype,
  created_at, updated_at, last_verified_at)
SELECT id, content_hash, identity_key, type, summary, details, scope_glob, activation_class,
  lifecycle_triggers, embedding, embedding_summary, relevant_tools_json, confidence, importance, status,
  supersedes_memory_id, promotion_source, ttl_expires_at, validation_count, policy_subtype,
  created_at, updated_at, last_verified_at
FROM memories;

DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;

CREATE INDEX idx_memories_scope_glob ON memories(scope_glob);
CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_created_at ON memories(created_at);
CREATE INDEX idx_memories_content_hash ON memories(content_hash);
CREATE INDEX idx_memories_status_authority ON memories(status, authority);
CREATE UNIQUE INDEX ux_memories_identity_live ON memories(identity_key)
  WHERE identity_key IS NOT NULL AND status IN ('candidate','active','stale');
CREATE UNIQUE INDEX ux_memories_semantic_live ON memories(semantic_key)
  WHERE semantic_key IS NOT NULL AND status IN ('candidate','active','stale');

UPDATE memories SET authority = CASE promotion_source WHEN 'auto' THEN 'auto' ELSE 'human' END;
UPDATE memories SET source_kind = 'legacy'
  WHERE id IN (SELECT memory_id FROM dream_memory_evidence_links);
UPDATE memories SET status = 'rejected', status_reason = 'v05_template_candidate',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE status = 'candidate'
    AND (summary LIKE 'Pitfall around %' OR summary LIKE 'Workflow around %'
         OR details LIKE 'Dream consolidation candidate built from recent evidence:%');
UPDATE memories SET needs_scope = 1
  WHERE source_kind = 'legacy' AND scope_glob IN ('**','**/*') AND lifecycle_triggers = '["before_model"]';

PRAGMA foreign_keys = ON;
```

`semantic_key` 백필은 SQL이 해시를 계산할 수 없으므로 `db/post-migrate.ts`가 맡는다. 017 이후 첫 writer가 `meta.semantic_key_backfill = 'pending'`을 보면 lock 안에서 모든 행의 키를 채우고, 살아 있는 행끼리 충돌하면 **파괴하지 않고** 가장 오래된 행만 키를 받고 나머지는 `merge` 제안을 연다. `normalize(summary)` = NFKC → 소문자 → 공백 축약 → 따옴표/백틱 제거 → 끝 구두점 제거.

### 4.2 `018_episodes_runs.sql`

```sql
CREATE TABLE episodes (
  id TEXT PRIMARY KEY,                       -- createDeterministicId('episode:host:session_id:turn_key')
  host TEXT NOT NULL CHECK(host IN ('claude-code','codex','opencode','legacy','import')),
  session_id TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  started_at TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  close_reason TEXT NOT NULL CHECK(close_reason IN ('stop','precompact','session_end','idle','recovered','legacy_batch','import')),
  ledger_ref TEXT NOT NULL,                  -- 'ledger/<file>#<byte_start>-<byte_end>' | 'legacy:<evidence_id>' | 'import:<path>'
  scope_refs_json TEXT NOT NULL DEFAULT '[]',
  tools_json TEXT NOT NULL DEFAULT '[]',
  failure_signatures_json TEXT NOT NULL DEFAULT '[]',   -- [{sig, seq, resolved_seq}]
  flags_json TEXT NOT NULL DEFAULT '{}',     -- {correction, failure, resolution, remember, decision_marker}
  evidence_weight REAL NOT NULL DEFAULT 0,   -- remember 3, correction 2, resolution 2, failure 1 (합)
  event_count INTEGER NOT NULL DEFAULT 0,
  fired_json TEXT NOT NULL DEFAULT '[]',     -- [{memory_id, tool, target, delivery}]
  status TEXT NOT NULL CHECK(status IN ('queued','leased','extracted','skipped','failed','dead')),
  skip_reason TEXT,                          -- 'no_signal' | 'daily_cap' | 'suspect_run' | 'no_provider'
  lease_until TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  extraction_run_id TEXT
);
CREATE INDEX idx_episodes_status ON episodes(status, next_attempt_at);
CREATE INDEX idx_episodes_session ON episodes(host, session_id, closed_at);

CREATE TABLE extraction_runs (
  id TEXT PRIMARY KEY,                       -- createDeterministicId('run:' + episode_id + ':' + extractor_version + ':' + prompt_sha256)
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('claude','codex','opencode','replay')),
  model TEXT,
  extractor_version TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  input_chars INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  status TEXT NOT NULL CHECK(status IN ('started','ok','invalid_output','suspect','timeout','provider_error','no_provider')),
  facts_total INTEGER NOT NULL DEFAULT 0,
  facts_accepted INTEGER NOT NULL DEFAULT 0,
  outcomes_json TEXT NOT NULL DEFAULT '[]',  -- fact별 {ordinal, action, outcome, memory_id?, proposal_id?, rejection?}
  raw_output_ref TEXT,
  error TEXT
);
CREATE INDEX idx_extraction_runs_episode ON extraction_runs(episode_id);

CREATE TABLE write_ops (
  id TEXT PRIMARY KEY,                       -- run id | 'decision:<proposal_id>' | 'import:<file_sha256>' | 'dream:<YYYY-MM-DD>'
  kind TEXT NOT NULL,
  generation INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta (key, value) VALUES ('db_generation','1'), ('extractor_version','1'),
  ('semantic_key_backfill','pending'), ('last_dream_at',''), ('installed_version','0.6.0');
```

### 4.3 `019_proposals_provenance.sql`

```sql
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,                       -- createDeterministicId('proposal:' + kind + ':' + target + ':' + (candidate ?? semantic_key))
  kind TEXT NOT NULL CHECK(kind IN ('supersede','stale','activate_policy','activate_global','fix_scope','merge')),
  target_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,   -- activate_*/fix_scope는 자기 자신
  candidate_memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,         -- supersede/merge의 상대
  rationale TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_by TEXT NOT NULL CHECK(created_by IN ('extractor','consolidator','migration','import')),
  support_count INTEGER NOT NULL DEFAULT 0,  -- 파생: COUNT(DISTINCT episode_id) in proposal_support
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','rejected','expired','withdrawn')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT CHECK(decided_by IN ('human','auto_rule','expiry')),
  decision_note TEXT
);
CREATE UNIQUE INDEX ux_proposals_open
  ON proposals(kind, target_memory_id, COALESCE(candidate_memory_id, '')) WHERE status = 'open';
CREATE INDEX idx_proposals_status ON proposals(status, created_at);

CREATE TABLE proposal_support (
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL,
  extraction_run_id TEXT,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (proposal_id, episode_id)
);

CREATE TABLE memory_provenance (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('origin','reinforce','contradict','import','legacy')),
  excerpt TEXT NOT NULL DEFAULT '' CHECK(length(excerpt) <= 500),
  extraction_run_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, episode_id, event_seq, relation)
);
CREATE INDEX idx_provenance_episode ON memory_provenance(episode_id);

CREATE TABLE memory_transitions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(actor IN ('human','auto_rule','expiry','import','migration')),
  proposal_id TEXT,
  extraction_run_id TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_transitions_memory ON memory_transitions(memory_id, created_at);

INSERT INTO proposals (id, kind, target_memory_id, rationale, confidence, created_by, status, created_at, expires_at)
SELECT 'fixscope-' || id, 'fix_scope', id,
       'v0.5 extraction stored scope **/* and trigger before_model only; set a real scope, trigger and signature',
       0.5, 'migration', 'open',
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 days')
FROM memories WHERE needs_scope = 1 AND status IN ('candidate','active');
```

### 4.4 `020_policy_rules_v2.sql`

```sql
ALTER TABLE policy_rules ADD COLUMN tool_pattern TEXT NOT NULL DEFAULT '*';     -- 정규 툴 glob: 'bash', 'edit|write', 'mcp:*'
ALTER TABLE policy_rules ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'any' CHECK(target_kind IN ('command','path','url','any'));
ALTER TABLE policy_rules ADD COLUMN pattern_kind TEXT CHECK(pattern_kind IN ('cmd','glob','regex','substring'));
ALTER TABLE policy_rules ADD COLUMN arg_pattern TEXT;
ALTER TABLE policy_rules ADD COLUMN enforcement TEXT NOT NULL DEFAULT 'advise' CHECK(enforcement IN ('advise','confirm','soft_deny','deny'));
ALTER TABLE policy_rules ADD COLUMN derived_at TEXT;                            -- NULL = 수동/픽스처 규칙
```

### 4.5 `021_legacy_fold.sql`

```sql
ALTER TABLE dream_evidence_events RENAME TO legacy_dream_evidence_events;
ALTER TABLE dream_runs RENAME TO legacy_dream_runs;
ALTER TABLE dream_memory_evidence_links RENAME TO legacy_dream_memory_evidence_links;

INSERT OR IGNORE INTO episodes (id, host, session_id, turn_key, started_at, closed_at, close_reason,
  ledger_ref, event_count, evidence_weight, status)
SELECT 'legacy-' || id, 'legacy', session_id, 'legacy:' || id, created_at, created_at, 'legacy_batch',
  'legacy:' || id, 1, 1, 'queued'
FROM legacy_dream_evidence_events
WHERE tool_name = 'conversation-batch' AND status IN ('pending','retained','grouped','latent');

UPDATE legacy_dream_evidence_events
  SET status = 'discarded', discarded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE status IN ('pending','retained','grouped','latent');

UPDATE memories SET evidence_count = (
  SELECT COUNT(DISTINCT e.session_id)
  FROM legacy_dream_memory_evidence_links l
  JOIN legacy_dream_evidence_events e ON e.id = l.evidence_event_id
  WHERE l.memory_id = memories.id)
WHERE source_kind = 'legacy';

DROP TABLE IF EXISTS topic_summaries;        -- 한 번도 채워지지 않음
```

`legacy_*` 테이블은 `memory:history`가 한 릴리스 동안 읽고 0.7에서 삭제한다(마이그레이션은 사용자가 들여다볼 수 있는 데이터를 파괴하지 않는다). `evidence` 테이블은 `manual_note`용으로 남고, 추출 출처는 `memory_provenance`가 맡는다. `session_summaries`, `activation_logs`, `audit_log`는 변경 없음.

### 4.6 트리거 시그니처 (`memories.trigger_signature_json`)

```json
{ "tool": "bash", "target": "command", "pattern_kind": "cmd", "pattern": "git push --force", "negate": false }
```

`tool`은 정규 어휘 glob(`bash`, `edit|write`, `mcp:github/*`, `*`), `target ∈ {command, path, url, any}`, `pattern_kind ∈ {cmd, glob, regex, substring}`. `cmd`는 셸 인지 매칭이다: 명령을 따옴표를 존중해 `&&`, `||`, `;`, `|`로 단순 명령으로 나누고, 앞의 환경 대입과 래퍼(`npx`, `pnpm`, `yarn`, `bunx`, `sudo`, `time`)를 벗긴 뒤, 패턴의 첫 토큰이 프로그램 basename과 같고 나머지 토큰이 모두 명령 토큰에 포함되면 일치한다(`--force`/`-f` 같은 대안은 시그니처 두 개). `glob`은 `target=path`에서 minimatch 의미(스냅샷 빌드 시 regex로 사전 컴파일), `regex`는 V5 통과분만, `substring`은 대소문자 무시. `signature_key`는 이 객체의 정규 직렬화다. 메모리는 시그니처를 최대 1개 가진다(여러 개가 필요하면 메모리를 나눈다; autonomy 설계의 4개 배열은 발화 면적이 커지고 `why`가 어려워져 채택하지 않음).

### 4.7 상태 머신

`memories.status`(어휘 불변, 모든 전이는 `transitionMemory`만 수행):

```
candidate ─(human promote | auto_rule: decideTier 통과)──────────▶ active
candidate ─(human reject | expiry 45d)──────────────────────────▶ rejected
active    ─(accepted stale proposal | expiry: TTL, auto만 | auto_rule: 2-support, auto만)─▶ stale
active    ─(accepted supersede proposal | auto_rule: 2-support, auto만)──▶ superseded (대체 행 active)
stale     ─(human promote | auto_rule: reinforce, auto만)────────▶ active
superseded─(human restore)──────────────────────────────────────▶ active
```

`actor ∈ {human, auto_rule, expiry, import, migration}`. `auto_rule`·`expiry`가 `authority='human'` 행을 건드리면 `AuthorityViolationError`를 던지고 아무것도 쓰지 않는다. 모든 전이는 `memory_transitions` 행을 남긴다. `MemoryRepository.update()`(910행, 현재 어떤 호출자의 어떤 status도 받음)는 `status`를 거부하고, 소스 grep 테스트가 `UPDATE memories SET status`가 `transitions.ts` 밖에 없음을 보장한다.

`episodes.status`: `queued → leased → extracted | skipped | failed`; `leased → queued`(lease 만료); `failed → queued`(1 h/6 h/24 h 백오프, 3회) `→ dead`. `proposals.status`: `open → accepted | rejected | expired(30 d) | withdrawn`.

### 4.8 스냅샷 파일

`snapshot/active.v1.json`: `{schema: 1, built_at, db_generation, source: {mtime_ms, size}, memories: [...], rules: [...], failure_index: {<failure_class>: [memory_id]}, buckets?: {"<tool>|<scope_prefix>": [idx]}, counts: {candidates, open_proposals, auto_active}}`. 메모리 항목은 엔진이 읽는 모든 컬럼(임베딩 제외, `details` 600자) 더하기 `scope_regex`, `signature`(regex 소스 포함), `authority`, `enforcement`, `contested`. `buckets`는 active 메모리 1,000개 초과 시에만 생성된다. 300 메모리에서 약 170 KB, 파싱 1–2 ms. `lexical.v1.json`은 `MiniSearch.toJSON()`과 최근 세션 요약 10건이며 `before_tool` 경로는 열지 않는다.

---

## 5. 쓰기 경로 (에피소드 → 추출 → reconcile → 활성화)

### 5.1 캡처 (훅, DB 없음)

ledger 라인(모두 `{ts, seq, turn_key, agent_id}` 포함, 한 줄 ≤ 32 KB, `appendFileSync` 1회):

| kind | writer | 필드 |
|---|---|---|
| `prompt` | `prompt` 훅 | `text`(≤4,000), `correction`, `remember` |
| `fired` | `pre-tool` 훅 | `memory_ids[]`, `rule_codes[]`, `tool`, `target`, `delivery ∈ {before, with_result, none}`, `decision ∈ {advise, ask, soft_deny, deny}` |
| `tool_ok` | `post-tool` 훅 | `tool_use_id`, `tool`(정규), `host_tool`, `input_digest`(command 또는 path, ≤500), `scope_refs[]`, `output_head`(≤2,000), `output_tail`(≤1,000), `output_bytes`, `resolution_of: tool_use_id\|null` |
| `tool_fail` | `post-tool-failure` 훅(Claude Code), `post-tool`에서 `tool_response`로 유도(Codex) | `tool_ok`와 동일 + `error`(≤1,500), `failure_sig` = `<tool>\|<class>\|<scope_ref>` |
| `assistant` | `stop` 훅 | `last_assistant_message`(≤2,000) |
| `marker` | `precompact`, `session-end` | `kind: compact\|session_end` |

자격 증명 패턴(스캐너의 `CREDENTIAL_PATTERNS`)은 기록 전에 `<redacted>`로 치환한다. 교정 감지(`prompt` 훅): 직전 비마커 라인이 `tool_fail`이거나 텍스트가 이중 언어 어휘(`don't|do not|never|stop|instead|wrong|undo|revert|아니|하지 ?마|말고|대신|틀렸|되돌려`)에 맞으면 `correction=1`; `remember|from now on|always|기억|앞으로|항상|절대`면 `remember=1`. 해결 감지(`post-tool` 훅): `state.pending_failures`에 같은 `(tool, scope_ref)`가 있으면 `resolution_of`. 실패 클래스는 순서 있는 정규식 표(`enoent`, `eaddrinuse`, `econnrefused`, `timeout`, `assertion`, `type_error`, `module_not_found`, `permission`, `exit_<n>`, `other`). 정규식은 여기서만 살아남는다: 시그니처와 플래그를 뽑을 뿐 후보를 만들지 않는다(R6).

### 5.2 에피소드 닫기와 큐 (`stop`, `precompact`, `session-end`)

`stop` 훅은 `stop_hook_active=true`면 즉시 종료한다. 아니면 `state.turn_start_offset`부터 ledger 끝까지(≤4 MB)를 읽어 scope 집합, 툴 집합, 실패 시그니처(해결 포인터 포함), 플래그, `evidence_weight`(remember 3, correction 2, resolution 2, failure 1의 합), `fired` 롤업을 계산하고 `queue/<episode_id>.json`을 tmp+rename으로 쓴 뒤 worker를 분리 스폰하고 종료한다(약 50 ms). 열린 파일을 rename하지 않으므로 병렬 `PostToolUse` 훅이 ledger를 append 중이어도 Windows `EPERM`이 나지 않는다(hook-native의 rename 결함 수정). `precompact`는 같은 일을 `close_reason='precompact'`로, `session-end`는 1.5 s(Claude Code)/1 s(Codex) 예산 안에서 큐 파일 하나와 worker 스폰만 한다. Stop·PreCompact에는 stdout을 쓰지 않는다(Stop의 `additionalContext`/`decision`은 턴을 계속시키고 PreCompact stdout은 압축 지시가 된다).

### 5.3 적격성과 비용 상한

LLM 추출 자격: `evidence_weight ≥ 1`(실패·교정·해결·remember 중 하나) 또는 `last_assistant_message`에 결정 마커(`decided|we'll use|switch to|from now on|결정|이제부터|전환`). 읽기 전용 턴은 `skipped(no_signal)` 행만 남는다(브리프의 "닫힌 에피소드마다 추출"에서 벗어남: 턴마다 headless 호출은 구독 비용이고 잡동사니의 주원인이라고 네 설계 모두 판단). `extraction.maxRunsPerDay`(기본 40)는 **교정·remember 에피소드에는 적용하지 않는다**(바쁜 날 늦은 교정을 버리는 결함 수정). `minSessions`, `minHours`, 게이트 파일은 없다(R3).

### 5.4 추출 worker

`worker extract`는 §9.3의 두 짧은 lock 세션 사이에서 provider를 호출한다. 프롬프트(`extract/prompt.ts`): 에피소드 헤더(host, 플래그, 툴·파일 집합), 모든 라인을 `e<seq>`로 번호 매겨 렌더(실패·해결 라인은 전문, 나머지 `tool_ok`는 한 줄), `fired` 라인은 "경고가 표시됨", 마지막 assistant 메시지, scope가 교차하는 기존 메모리 ≤ 40건(`[M:<id>] [type] [status/authority] scope sig summary`), 정규 툴 어휘, 타입 정의, 그리고 **표현 정규화 지시**("from now on", "always do ... run" 문구를 명령형으로 바꿀 것: 스캐너 65–75행이 이를 프롬프트 주입으로 차단한다). 하드 캡 24,000자, 교정과 실패가 마지막에 잘린다. `prompt_sha256`은 전체 프롬프트의 해시이고 `run_id`에 들어간다.

```ts
interface ExtractionProvider {
  name: 'claude' | 'codex' | 'opencode' | 'replay';
  probe(): Promise<boolean>;                                    // 바이너리 존재, --version ≤ 5 s
  extract(prompt: string, schema: object, opts: { timeoutMs: number }): Promise<{ raw: string; model?: string }>;
}
```

- `claude`: `claude -p --output-format json --json-schema <schema> --tools "" --disallowedTools "mcp__*" --max-turns 1 --no-session-persistence --settings '{"disableAllHooks":true}' --model <cfg>`; 프롬프트는 stdin(Windows 명령줄 8,191자 한계), cwd `.harness-memory/worker/`, env `HARNESS_MEMORY_DISABLE=1`. 결과는 `structured_output`에서 읽고 없으면 `invalid_output`. **`--bare`는 쓰지 않는다**: 검증된 사실로 bare 모드는 OAuth 자격 증명을 읽지 않고 `ANTHROPIC_API_KEY`를 요구하므로 브리프 제약 8을 위반한다.
- `codex`: `codex exec - --output-schema <file> --ephemeral --sandbox read-only --skip-git-repo-check --json`(저장된 ChatGPT 인증 재사용); 같은 cwd·env. `-c features.hooks=false`는 문서에 없으므로 최선 노력으로만 붙이고, 실제 재귀 방어는 env 가드와 `.codex/`가 없는 격리 cwd다.
- `opencode`: 기존 SDK 호출, `tools: {}`.
- `replay`: 기록된 응답(eval).

재귀 가드 3중: (1) 모든 훅 진입점이 `HARNESS_MEMORY_DISABLE === '1'`이면 스냅샷을 열기 전에 exit 0; (2) worker가 `worker.pid`를 쓰고 훅은 `process.ppid` 체인이 그 pid에 닿으면 exit 0(호스트가 env를 벗기는 경우 대비); (3) 위의 `disableAllHooks`/격리 cwd. 벽시계 캡 120 s, 초과 시 자식 kill, `timeout`. `probe()` 실패는 하루 한 번 `no_provider`를 기록하고 에피소드를 `queued`로 둔다.

### 5.5 추출 JSON 스키마 (verbatim, `--json-schema`/`--output-schema`에 그대로 전달)

```json
{"type":"object","required":["episode_summary","nothing_to_learn","facts"],"additionalProperties":false,
 "properties":{
  "episode_summary":{"type":"string","maxLength":400},
  "nothing_to_learn":{"type":"boolean"},
  "facts":{"type":"array","maxItems":8,"items":{"type":"object","additionalProperties":false,
   "required":["action","target_memory_id","type","summary","details","scope_glob","relevant_tools",
               "trigger_signature","lifecycle_triggers","confidence","evidence_refs","knowledge_kind","rationale"],
   "properties":{
    "action":{"enum":["create","reinforce","propose_supersede","propose_stale"]},
    "target_memory_id":{"type":["string","null"]},
    "type":{"enum":["policy","workflow","pitfall","architecture_constraint","decision"]},
    "summary":{"type":"string","minLength":12,"maxLength":160},
    "details":{"type":"string","maxLength":1200},
    "scope_glob":{"type":"string","minLength":1,"maxLength":200},
    "relevant_tools":{"type":"array","maxItems":6,
      "items":{"enum":["bash","edit","write","read","grep","glob","fetch","task","mcp","other"]}},
    "trigger_signature":{"type":["object","null"],"additionalProperties":false,
      "required":["tool","target","pattern_kind","pattern"],
      "properties":{
        "tool":{"type":"string","maxLength":60},
        "target":{"enum":["command","path","url","any"]},
        "pattern_kind":{"enum":["cmd","glob","regex","substring"]},
        "pattern":{"type":"string","minLength":1,"maxLength":200},
        "negate":{"type":"boolean"}}},
    "lifecycle_triggers":{"type":"array","minItems":1,"maxItems":4,
      "items":{"enum":["session_start","before_model","before_tool","after_tool"]}},
    "confidence":{"type":"number","minimum":0,"maximum":1},
    "evidence_refs":{"type":"array","minItems":1,"maxItems":8,
      "items":{"type":"string","pattern":"^e[0-9]{1,4}$"}},
    "knowledge_kind":{"enum":["correction","failure_resolution","convention","decision","observation"]},
    "rationale":{"type":"string","maxLength":300}}}}}}
```

프롬프트 규칙: 미래 턴의 행동을 바꾸는 지식만; 인용 없는 fact 없음; 가장 좁은 참 scope(`**/*`는 정말 전역일 때만); 툴이 실행되기 직전에 떠올라야 하는 지식은 `trigger_signature`와 `before_tool`을 반드시 가짐; 기존 메모리와 같은 말이면 `reinforce`, 틀렸음이 증명되면 `propose_*`(편집·삭제 불가, 제안만); `confidence = P(참 ∧ 지속 ∧ 올바른 scope)`, 0.6 미만은 생략.

### 5.6 검증 (`extract/validate.ts`, fact별 거부 코드 기록)

V1 스키마(직접 작성한 소형 검증기, 새 의존성 없음); V2 `evidence_refs`가 이 에피소드의 `e<seq>`로 해석됨(환각 검사); V3 `scope_glob`이 에피소드 `scope_refs` 중 하나와 교차하거나, **`trigger_signature`가 있는 fact는 전역 scope 허용**(명령 피트폴 "never git push --force"는 저장소 전역이 맞다. ops V3의 완화), 시그니처 없는 `**/*`는 `decision`/`architecture_constraint`만 허용하고 사람 게이트로; V4 시그니처의 `tool`이 에피소드 툴 집합에 있음; V5 regex는 컴파일되고, 중첩 수량자(`(a+)+`, `(.*)*` 휴리스틱)가 없으며, 4 KB 샘플에서 2 ms 안에 끝남(핫패스는 Node에 regex 타임아웃이 없으므로 여기서만 막을 수 있다); V6 `scanMemoryContent(summary, details, {source: 'extraction'})` 안전 + `self-reference`(`.harness-memory`, 훅 설정, `settings.json`을 편집하라는 지시 거부); V7 `reinforce`/`propose_*`는 실재하는 `target_memory_id` 필요(없으면 `create`로 강등, `propose_*`는 `rejected_no_target`); V8 `summary` 비어 있지 않고 프롬프트 재진술 아님; V9 배치 내 `semantic_key` 중복 접기. 브레이커: 비 JSON, fact > 8, 거부율 > 50 % → run `suspect`, 원본 7일 보존, 에피소드 `skipped(suspect_run)`, 자동 재시도 없음.

### 5.7 reconcile (`reconcile.ts`, 결정적, lock 세션 2 안에서 한 트랜잭션, fact별 SAVEPOINT)

1. `write_ops`에 `run_id`가 있으면 에피소드를 `extracted`로 표시하고 반환(전체 run 멱등성: 크래시, CLI 재시도, 중복 worker 모두 무해).
2. fact를 정규화한다: 슬래시, `./` 제거, 저장소 밖 glob 거부, `relevant_tools` 정규 어휘, 타입별 트리거 보정(`pitfall`/`policy`에 시그니처가 있으면 `before_tool` 포함; `decision`/`architecture_constraint`는 `session_start` 또는 `before_model` 포함), `semantic_key` 계산.
3. 대상 해석: `t = target_memory_id`의 행(`rejected`/`superseded`면 `superseded_by` 체인을 따라가 살아 있는 행). `m = semantic_key가 같은 살아 있는 행`. 둘 다 없고 `action='create'`면 이웃 탐색: 같은 타입, scope 교차, 정규화 summary의 토큰 Jaccard ≥ 0.6, 또는 임베딩이 있으면 코사인 ≥ 0.85.
4. `create`: `m`이 있으면 `reinforce(m)`로 전환. 없으면 `MemoryRepository.create`(try/catch로 `DuplicateMemoryContentError`를 잡아 기존 행이 살아 있으면 reinforce로, `rejected` 30일 이내면 `skipped_recent_reject`로, 그 외 terminal이면 새 행 생성 허용(부분 유니크 인덱스가 허용함)). 행은 `status='candidate'`, `source_kind='extraction'`, `source_ref='episode:<id>'`, `importance`는 타입 기본(policy .9, pitfall .8, architecture .8, workflow .6, decision .6), `enforcement`는 §7.3 기본. `memory_provenance(origin)` 행을 `evidence_refs`마다 `INSERT OR IGNORE`.
5. `reinforce(target = t ?? m)`: `memory_provenance(reinforce)` 행; 파생 카운터 재계산(`evidence_count`, `evidence_score`, `distinct_session_count`, `confidence = min(0.99, max(provenance confidence) + 0.05·(evidence_count−1))`); `last_verified_at = closed_at`; 대상이 `auto`·`active`면 `revalidateMemory`(TTL 연장 `ttlDays(validation_count) = min(90, 7·2^v)`, `validation_count = evidence_count − 1`)(D4); `stale(ttl_expired)`인 auto 행은 `transitionMemory(stale→active, auto_rule)`; human 행은 `last_verified_at`과 카운터만 바뀐다.
6. `propose_supersede` / `propose_stale(target)`: `supersede`면 대체 행을 4단계처럼 `candidate`로 삽입하고 `supersedes_memory_id`를 건다. `memory_provenance(contradict)` 행. `openOrSupportProposal`: 부분 유니크 인덱스 덕에 같은 (kind, target, candidate)의 열린 제안은 upsert되고 `proposal_support(proposal_id, episode_id)`가 같은 에피소드면 no-op, 다른 에피소드면 `support_count`가 오른다. **대상이 `auto`이고 `type ≠ policy`이며 `support_count ≥ 2`(서로 다른 에피소드)일 때만** `decideProposal(accepted, auto_rule)` + `transitionMemory(target → stale|superseded, auto_rule)`(대체 행은 `active`, `authority='auto'`). 대상이 `human`이면 제안만 열고 `contested=1`, `open_proposal_id`를 설정한다. 단일 LLM 주장으로 auto 메모리가 사라지는 hook-native 결함은 이렇게 닫힌다.
7. 4단계에서 만든 후보마다 `decideTier`(§7.4)를 적용해 `active/auto`로 올리거나 `candidate`로 두고 필요한 `activate_policy`/`activate_global` 제안을 연다. `autonomy_level='shadow'`면 결정을 `audit_log(auto_activation_shadow)`에만 쓴다.
8. `extraction_runs.outcomes_json`에 fact별 결과를, `episodes.status='extracted'`, `session_summaries` upsert(`summary_short = episode_summary`), `write_ops(run_id)`, `meta.db_generation += 1`. 커밋 후 writer가 `derivePolicyRules(db)`(§10)와 스냅샷 재구축을 수행한다.

### 5.8 consolidate (`worker dream`; `session-end`, 마지막 실행 6 h 경과 후의 `stop`, `hm dream`)

메모리를 발명하지 않는다. TTL 지난 auto 행 → `stale(ttl_expired)`(TTL이 실제로 돈다); `candidate` 45일 → `rejected`; 제안 30일 → `expired`; auto↔auto 근중복(Jaccard ≥ 0.8 또는 코사인 ≥ 0.92) 병합(provenance 합집합), human이 얽히면 `merge` 제안; 임베딩 백필(모델은 여기서만 로드); `fire_count`/`last_fired_at` 롤업; 종결 에피소드의 ledger 세그먼트 14일 후 삭제(excerpt ≤ 500자는 `memory_provenance`에 남아 `trace`가 계속 해석된다); `raw/` 24 h, `*.tmp-*` 10분, `audit_log` 30일 GC; 스냅샷 재구축.

---

## 6. 읽기 경로 (4 트리거, before_tool 매칭 알고리즘, 예산, 지연 계획)

### 6.1 트리거 매핑

| 트리거 | Claude Code | Codex | 모드 | 소스 | 예산 | 전달 |
|---|---|---|---|---|---|---|
| `session_start` | `SessionStart` | `SessionStart` | `startup` | 스냅샷 + lexical + `recent_summaries` | 10 / 8 KB | `additionalContext` |
| `before_model` | `UserPromptSubmit` | `UserPromptSubmit` | `classifyQueryType(prompt)` | 스냅샷 + lexical(BM25만) | 10 / 8 KB | `additionalContext` |
| `before_tool` | `PreToolUse` | `PreToolUse` | `default` + 시그니처 단계 | 스냅샷 | **3 / 2 KB** | enforcement 사다리(§7.2) |
| `after_tool` | `PostToolUse`, `PostToolUseFailure` | `PostToolUse`(실패 유도) | `failure_index` 조회만 | 스냅샷 | 2 / 1 KB | `additionalContext`(실패 힌트) |

`before_model`은 훅 호스트에서 "사용자 턴당 한 번"이다(Claude Code에 추론 전 훅이 없고 Codex `PreModelRequest`는 주입 미지원; OpenCode V2 `context` 훅만 모델 호출 단위). dense 레그는 훅 호스트에서 끄고(transformers import만 116–204 ms) 쓰기 측, OpenCode 상주 플러그인, CLI `why`에서만 쓴다. `after_tool`은 훅 호스트에서 캡처 지점 + 실패 힌트 채널이다.

### 6.2 `before_tool` 알고리즘 (`hook.ts pre-tool`, 번호는 실행 순서, 괄호는 예산)

```
0  env 가드: HARNESS_MEMORY_DISABLE=1 또는 ppid 체인이 worker.pid → exit 0                         (0.1 ms)
1  stdin 전체 읽기(2 s 가드, 1 MB 캡) → JSON 파싱; 실패 → 로그 'bad_stdin', exit 0                    (1 ms)
2  정규화: canonical = toolVocabulary(host, tool_name); target = pickTarget(canonical, tool_input)
   (bash→command, edit/write/read→file_path, fetch→url, mcp→JSON ≤2,000); scopeRefs = 경로형 토큰, 없으면 []  (0.5 ms)
3  스냅샷: readFileSync + JSON.parse(active.v1.json); statSync(memory.sqlite) ≠ snapshot.source → reindex 스폰
   (reindex.lock 60 s) 하되 현재 스냅샷 사용; 없음/파싱 실패 → 빈 결과 + reindex 스폰. sql.js는 절대 열지 않음  (1–3 ms)
4  턴 상태: state/<session>.json의 turn_start_offset부터 ledger 꼬리(≤256 KB) → firedKeys {memory_id|tool|target}  (1 ms)
5  후보: before_tool ∈ lifecycle_triggers인 스냅샷 메모리(1,000개 초과 시 buckets[tool|prefix] ∪ buckets[tool|*] ∪ baseline)
6  필터(mode-default의 before_tool 분기, 순서 고정): status/TTL → trigger → relevant_tools(null 또는 canonical 포함)
   → scope(사전 컴파일 regex × scopeRefs; 전역 glob은 통과; scopeRefs가 비면 전역만) → 시그니처: 있으면 tool glob +
   pattern_kind 매처가 target(≤4 KB)에 일치해야 함(불일치 → 'signature_mismatch', 일치 → +0.5); 없으면 type ∈ {policy, pitfall}만  (2–3 ms)
7  정책 규칙: PolicyEngine.evaluate({lifecycleTrigger:'before_tool', scopeRef, toolName: canonical, toolTarget: target})  (1 ms)
8  중복 억제: firedKeys에 있는 (memory|tool|target) 제외(enforcement=deny는 유지)
9  순위: enforcement(deny > confirm > soft_deny > advise) → 시그니처 일치 → authority=human → calculateMemoryScore
   → 쿼터 policy 2 / pitfall 2 / workflow 1 → 예산 3개 / 2,048 B
10 결정: 선택 항목의 최고 enforcement를 §7.2로 매핑; soft_deny는 firedKeys에 없을 때만 deny, 재시도는 advise로 통과
11 fired 라인 append(delivery: ask/deny→'before', additionalContext→'with_result', 없음→'none'); stdout JSON 1개; exit 0  (1 ms)
12 어떤 예외든: hooks.log 한 줄, 출력 없음, exit 0 (exit 2 금지: Git Bash 없는 Windows에서 0/2 이외는 툴 차단)
```

`memory:why --trigger before_tool --tool bash --target "git push --force" --scope src/x.ts`는 같은 함수를 호출해 활성·억제 이유를 출력한다.

### 6.3 지연 예산 (측정치: hook-native 번들 기준 Windows 11, Node 24, 300 메모리)

| 구성 요소 | 측정 | 핫패스 포함 |
|---|---:|---|
| Node 프로세스 시작+종료 | 36–50 ms | 예(불가피) |
| 300 KB 번들 컴파일(compile cache 있을 때 축소) | 5–8 ms | 예 |
| stdin, 스냅샷 파싱(170 KB), stat, ledger 꼬리 | 3–5 ms | 예 |
| 300 × 사전 컴파일 `RegExp.test` + ≤50 시그니처 | 2–3 ms | 예 |
| 출력 포맷, append, stdout | 1 ms | 예 |
| sql.js require+WASM init+open 1.3 MB | +53–54 ms | **아니오** |
| `import('minimatch')` + 300 × minimatch | +11.5 + 8 ms | **아니오**(regex 사전 컴파일) |
| MiniSearch import+build+search | 18 ms | `prompt`, `session-start`만 |
| `import('@xenova/transformers')` | +116–204 ms | **절대 아니오** |

합계 47–67 ms. 목표 p50 ≤ 70 ms, p95 ≤ 90 ms(프로세스 내부). 호스트 측 spawn 오버헤드(Windows Defender, exec-form이 아닌 셸 래퍼)는 10–30 ms를 더하므로 설치는 반드시 exec-form(§8.7). `eval:latency`가 CI에서 `dist/hook.js pre-tool`을 300·2,000 메모리 픽스처로 50회 스폰해 p95 > 90 ms(300) / > 120 ms(2,000)면 실패시킨다.

### 6.4 엔진 변경(최소 diff)

`engine.ts:93`의 생성자는 구체 클래스 `MemoryRepository`(private 멤버 보유)를 받으므로 스냅샷 리더는 구조적으로 대입 불가다. 변경: `MemoryReader = Pick<MemoryRepository, 'list' | 'getById' | 'listLineageConflicts'>` 인터페이스로 생성자와 `ActivationContext.repository`의 타입을 넓힌다(`MemoryRepository`는 자동으로 만족, 315 테스트 무변경). `prepareActivation`(187–194행)의 `LexicalIndex.rebuild`는 `queryText`가 비어 있지 않거나 모드가 `startup/temporal/cross_session`일 때만 수행하고, 스냅샷 리더는 `lexical.v1.json`에서 `MiniSearch.loadJSON`으로 대체한다. `ActivationRequest`에 `toolTarget?: string`, `toolInput?: unknown`을 더하고 `ActivationSuppressionKind`에 `signature_mismatch`를 추가하며, `calculateMemoryScore`의 신뢰 배수를 `authority === 'human' ? 1 : validation_count...`로 바꾼다. `getPayloadBytes`는 그대로.

### 6.5 피로 제어

트리거별 예산은 `config.json`; 같은 에피소드 안에서 같은 `(memory|tool|target)`는 한 번만; `fire_count ≥ 20 ∧ evidence_score < 3`인 메모리는 `status`/`review`에 "noisy"로 보고(자동 강등 없음). 한 번 발화한 soft_deny는 같은 턴의 동일 호출에 다시 개입하지 않는다.

---

## 7. 권한 모델 (auto / human, 제안 큐)

### 7.1 두 축

`authority ∈ {human, auto}`: 누가 상태를 바꿀 수 있는가. `human`은 수동 추가, import, 승격, 제안 수락으로 생기며 TTL이 없고 신뢰 배수 1.0, 상태는 사람(또는 사람이 수락한 제안)만 바꾼다. `auto`는 `decideTier`가 올린 행으로 TTL·재검증·2-support 강등을 받는다. `enforcement ∈ {advise, confirm, soft_deny, deny}`: before_tool에서 어떻게 전달되는가. `deny`는 사람만 설정할 수 있고(`memory:enforce <id> deny`), LLM은 enforcement를 올릴 수 없다.

### 7.2 전달 사다리 (검증된 호스트 채널에 매핑)

| enforcement | Claude Code | Codex | OpenCode V2 | 타이밍 |
|---|---|---|---|---|
| `advise` | `hookSpecificOutput.additionalContext` | `additionalContext` | 다음 `context` 훅에 추가 | with_result(Claude Code 검증), Codex·OpenCode 미검증 |
| `confirm` | `permissionDecision: "ask"` + `permissionDecisionReason`(사용자가 결정; `-p`에서는 거부되고 사유가 모델에 전달) | **soft_deny로 강등**(`ask`는 파싱되지만 미지원이며 훅 실행을 실패 처리) | soft_deny로 강등 | before |
| `soft_deny` | `permissionDecision: "deny"` + 사유(첫 시도만; 같은 에피소드의 동일 호출 재시도는 통과) | 동일 | `execute.before`에서 throw(사유 메시지)(미검증, 실패 시 advise) | before |
| `deny` | `permissionDecision: "deny"` + 사유, 매번 | 동일 | throw | before |

`soft_deny`의 의미: 모델은 툴이 실행되기 전에 사유를 읽고, 적용되지 않는다고 판단하면 같은 호출을 다시 내면 된다. 호스트 중립적이고(Bash뿐 아니라 Edit/Write/MCP에도 작동), 별도 프로토콜 학습이 필요 없으며, 비용은 메모리가 실제로 관련 있을 때 한 번의 모델 라운드트립뿐이다. autonomy 설계의 `HM_OVERRIDE=<id>` 접두사는 Bash 전용이라 채택하지 않는다. 사유 텍스트는 ≤ 600자, `systemMessage`에는 `harness-memory: <memory id> fired (<enforcement>)` 한 줄.

### 7.3 기본 enforcement (`enforcementDefault(memory)`, 사람이 언제든 덮어씀)

| 메모리 | authority | 기본 | 이유 |
|---|---|---|---|
| `policy`, `policy_subtype='hard'`, 시그니처 있음 | human | `confirm` | 사람이 승인한 하드 규칙은 실행 전에 사람이 봐야 한다 |
| `policy` soft 또는 시그니처 없음 | human | `advise` | 정밀도가 낮은 scope-only 일치에 프롬프트를 띄우지 않는다 |
| import된 규칙 중 `never|must not|always|do not|절대|반드시|항상`을 포함하고 시그니처 있음 | human | `confirm` | 첫 사용자의 "하지 말라" 규칙이 첫날부터 실행 전에 작동한다 |
| 그 외 import | human | `advise` | — |
| `auto` `pitfall`/`workflow`, 시그니처 있음 | auto | `soft_deny` | 시그니처 일치는 구성상 고정밀이며, 실행 뒤 경고는 wedge가 아니다 |
| `auto` scope-only | auto | `advise` | scope-only는 거짓 양성이 많다 |
| `decision`, `architecture_constraint` | human | `advise` | before_tool 대상이 아님 |

`config.json`의 `before_tool.auto_enforcement = soft_deny | advise`(기본 soft_deny), `before_tool.hard_policy = confirm | advise | deny`(기본 confirm)로 전역 조정한다.

### 7.4 자동 티어 (`decideTier(memory, episode)`, 순수 함수)

| 조건 | 결과 |
|---|---|
| `type ∈ {pitfall, workflow}` ∧ `scope_glob` 유효 ∧ (`trigger_signature` ∨ `relevant_tools`) ∧ `before_tool ∈ triggers ∨ (좁은 scope ∧ before_model ∈ triggers)` ∧ `confidence ≥ 0.7` ∧ `evidence_score ≥ 2` ∧ 스캔 안전 ∧ `autonomy_level='standard'` | `active`, `authority='auto'`, `validation_count = evidence_count − 1`, `ttl_expires_at = now + ttlDays(validation_count)`(단일 에피소드면 7 d), `revalidate_after = now + ttl/2`, 신뢰 배수 0.65 |
| 위와 같으나 `evidence_score < 2`(맨 실패 1건) | `candidate`, 다음 강화 에피소드에서 활성화 |
| `type ∈ {decision, architecture_constraint}` | `candidate`, CLI 다이제스트 |
| `type = policy` | `candidate` + `proposals(activate_policy)` |
| 시그니처 없는 `**/*`(`activation_class='baseline'`) | `candidate` + `proposals(activate_global)` |

"충분한 증거"는 에피소드 수가 아니라 가중치 합이다. 교정 한 번 또는 실패→해결 쌍 하나(각 가중 2)면 즉시 활성화된다. 교정은 그 순간 포착된 사람의 판단이고, 두 번째 발생을 기다리면 에이전트가 같은 실수를 설계상 한 번 더 반복한다. 비용은 7일 TTL, 0.65 신뢰 배수, **강등에만** 적용되는 2-support 규칙으로 묶인다.

### 7.5 제안 큐

종류 6개: `supersede`, `stale`, `activate_policy`, `activate_global`, `fix_scope`(마이그레이션), `merge`(consolidate). 열린 제안은 (kind, target, candidate)당 하나이며 새 에피소드가 같은 주장을 하면 `support_count`만 오른다. 제안이 열린 human 행은 `active`로 남고 `contested=1`이 붙어 주입 시 `(contested, see hm review)` 접미사가 달린다: LLM은 사람 지식을 제안으로 숨길 수 없고 사용자는 불일치를 본다. `proposals:accept`는 lock 안에서 `transitionMemory(actor='human', proposalId)`를 수행하고 대체 행은 `authority='human'`을 상속한다. `reject`는 대상에 `manual_note`를 남기고 같은 `semantic_key`의 재제안은 30일간 건너뛰며, 그 뒤 재제안은 `decided_at`보다 새로운 에피소드를 가져야 한다.

### 7.6 `autonomy_level` (`config.json`, 기본 `standard`)

`off`: `decideTier`가 아무것도 올리지 않는다. `shadow`: 결정을 `audit_log(auto_activation_shadow)`에만 기록해 저자가 정밀도를 보정할 수 있다. `standard`: §7.4 그대로. shadow를 **기본값으로 출하하지 않는다**(autonomy 설계): 브리프가 확정한 governed autonomy를 v0.6.0에서 꺼 두면 첫 사용자의 "교정 → 다음 턴 발화" 순간이 존재하지 않는다. `memory:promote|demote <id>`는 어떤 행이든 `authority='human'`으로 바꾼다.

---

## 8. 호스트 어댑터 (Claude Code, Codex, OpenCode 매핑표, 훅 I/O, 설치 및 배포)

### 8.1 사용한 호스트 사실 요약

설계를 결정한 검증 사실: Claude Code 명령 훅 기본 타임아웃 600 s(UserPromptSubmit 30 s, SessionEnd 1.5 s), `-p` 종료 시 async 훅 kill, 일치 훅 병렬 실행; `PreToolUse` 출력 `hookSpecificOutput{hookEventName, permissionDecision allow|deny|ask, permissionDecisionReason, additionalContext, updatedInput}`에서 `additionalContext`는 툴 결과와 함께 추가, `systemMessage`는 사용자 가시 전용; Stop 입력 `stop_hook_active`, `last_assistant_message`(transcript는 비동기 기록이라 불완전할 수 있음); PreCompact stdout은 압축 지시; 공통 입력 `session_id, transcript_path, cwd, hook_event_name, prompt_id, permission_mode`; exec-form `{command, args}`는 셸 없이 실행(Windows는 실제 .exe 필요), shell-form은 Git Bash 없으면 PowerShell. Codex: 이벤트 14종(PostToolUseFailure 없음), `permissionDecision` `allow|deny`만(`ask`는 훅 실패), `additionalContext` 10,000자 캡, 셸 `tool_name="Bash"`, `apply_patch`는 `Edit|Write`에 매칭, 설정 `~/.codex/hooks.json`·`<repo>/.codex/hooks.json`(신뢰된 `.codex/` 계층만)·`config.toml`, `/hooks` 해시 결속 신뢰, `commandWindows`, SessionEnd 1 s(최대 3 s), 공통 `turn_id`. OpenCode: V2 `Plugin.define({id, setup(ctx)})`만 문서화, V1 구현은 V2에서 실행되지 않음(1.18.29 이후 shim). 미검증 항목은 §15.2.

### 8.2 Claude Code 매핑

| 이벤트 | matcher | 명령 | 읽는 stdin 필드 | stdout | timeout |
|---|---|---|---|---|---|
| `SessionStart` | `startup\|resume\|clear\|compact` | `hook session-start` | `session_id, cwd, source` | `additionalContext`(session_start 활성화); `systemMessage` "N proposals await review" 하루 1회; 마이그레이션 필요/스냅샷 없음이면 worker 스폰 | 10 |
| `UserPromptSubmit` | — | `hook prompt` | `prompt, prompt_id, session_id` | `additionalContext`(before_model); `prompt` 라인; `turn_start_offset` 갱신 | 10 |
| `PreToolUse` | `Bash\|Edit\|MultiEdit\|Write\|NotebookEdit\|mcp__.*` | `hook pre-tool` | `tool_name, tool_input, tool_use_id, cwd, prompt_id` | §7.2 사다리 + `systemMessage`; `fired` 라인 | 5 |
| `PostToolUse` | `.*` | `hook post-tool` | `tool_name, tool_input, tool_response, tool_use_id, duration_ms` | `tool_ok` 라인; 출력 없음 | 5 |
| `PostToolUseFailure` | `.*` | `hook post-tool-failure` | `tool_name, tool_input, error, is_interrupt, tool_use_id` | `tool_fail` 라인; `failure_index` 일치 시 `additionalContext` | 5 |
| `Stop` | — | `hook stop` | `session_id, stop_hook_active, last_assistant_message, prompt_id` | **없음**; 에피소드 닫기, 큐, worker 스폰 | 10 |
| `PreCompact` | `manual\|auto` | `hook precompact` | `session_id, trigger` | **없음**; 조기 닫기 | 5 |
| `SessionEnd` | — | `hook session-end` | `session_id, reason` | 없음; 큐 파일 + `worker dream` 스폰만 | 1 |

`SubagentStop`, `Notification`, `PermissionRequest`는 등록하지 않는다. `PostToolUse`는 `async`로 두지 않는다(append 1 ms뿐이고 async는 `-p` 종료 시 손실).

### 8.3 Codex 매핑

| 이벤트 | 명령 | 차이점 |
|---|---|---|
| `SessionStart` | `hook session-start` | 동일; `source` 사용 |
| `UserPromptSubmit` | `hook prompt` | `turn_id`를 턴 키로 |
| `PreToolUse` | `hook pre-tool` | `Bash`→`bash`, `apply_patch`→패치 헤더 `*** Add File:`면 `write` 아니면 `edit`(scopeRefs는 `*** Update File:` 경로), `mcp__s__t`→`mcp:s/t`; `confirm`은 `soft_deny`로 강등, `ask` 절대 미출력; `additionalContext` ≤ 3 KB |
| `PostToolUse` | `hook post-tool` | `tool_response`에서 exit code/오류 문자열로 `tool_fail` 유도(픽스처 코퍼스 필요, §15.2) |
| `Stop` | `hook stop` | 출력 없음(평문 stdout은 무효); `last_assistant_message`(미검증, 없으면 `assistant` 라인 생략) |
| `PreCompact`, `SessionEnd` | `hook precompact`, `hook session-end` | SessionEnd 1 s: 큐 파일 + 스폰만 |

`PreModelRequest`는 0.7 검토 대상(현재 `additionalContext` 미지원).

### 8.4 OpenCode V2 매핑

| 코어 단계 | V2 API |
|---|---|
| `before_model` + 턴 시작 + 교정 감지 | `ctx.session.hook("prompt")` |
| 주입(session_start, before_model, advise) | `ctx.session.hook("context")`: `event.system`에 추가(모델 호출 단위 before_model이 실제로 존재하는 유일한 호스트) |
| `before_tool` | `ctx.tool.hook("execute.before")`: 텍스트 주입 불가 → advise는 다음 `context` 훅에 싣고 `soft_deny`/`deny`는 throw(미검증) |
| 캡처 | `ctx.tool.hook("execute.after")`, `event.status === 'error'`로 실패 |
| 에피소드 닫기 | `ctx.event.subscribe()`의 idle 이벤트(이름 미검증) 또는 다음 `prompt` 훅에서 이전 턴 닫기; worker 스폰 |
| 압축 | `ctx.session.hook("compaction")` 마커 |
| 세션 커서 | `ctx.storage` |

V1 객체 진입점은 shim으로 한 릴리스 유지한다. 플러그인은 DB를 들고 있지 않고 스냅샷을 mtime으로 캐시하며 쓰기는 worker로 보낸다(D1, F24).

### 8.5 정규 툴 어휘

`bash, edit, write, read, grep, glob, fetch, task, mcp:<server>/<tool>, other`. Claude Code: `Bash→bash`, `Edit|MultiEdit|NotebookEdit→edit`, `Write→write`, `Read→read`, `Grep→grep`, `Glob→glob`, `WebFetch|WebSearch→fetch`, `Task|Agent→task`, `mcp__s__t→mcp:s/t`. Codex: §8.3. OpenCode: 소문자 이름 그대로, `webfetch→fetch`. 메모리는 정규 이름만 저장하므로 Codex에서 배운 피트폴이 Claude Code에서 발화한다.

### 8.6 훅 I/O 계약과 예시

stdin 전체 읽기(2 s 가드, 1 MB 캡), stdout에 JSON 객체 정확히 하나, 로그는 파일로, exit는 항상 0. 결정은 JSON으로만 전달한다.

```json
// stdin (PreToolUse)
{"session_id":"abc","prompt_id":"p_8f3","cwd":"C:/repo","hook_event_name":"PreToolUse","permission_mode":"default",
 "tool_name":"Bash","tool_input":{"command":"npm test"},"tool_use_id":"toolu_01"}

// stdout: auto pitfall, soft_deny 첫 시도
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
  "permissionDecisionReason":"[harness-memory] PITFALL (auto, provisional): Run scripts/seed.js before npm test; tests read fixtures/seed.json (learned 2026-11-08 from a correction). If this does not apply, re-issue the same command to proceed."},
 "systemMessage":"harness-memory: pitfall 3f9a fired (soft_deny)"}

// stdout: human hard policy, confirm
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask",
  "permissionDecisionReason":"[harness-memory] POLICY: Never force-push to shared branches (CLAUDE.md L12)."}}

// stdout: advise
{"hookSpecificOutput":{"hookEventName":"PreToolUse",
  "additionalContext":"[harness-memory] PITFALL: Prisma migrations in db/migrations/** must be generated with --create-only first."}}
```

### 8.7 설치와 배포

`harness-memory install --host claude|codex|opencode|all [--user] [--with-embeddings]`:

- Claude Code: 기본 대상 `.claude/settings.local.json`(기계별 절대 경로가 들어가므로 커밋되는 `settings.json`이 아니라), `--user`면 `~/.claude/settings.json`. 항목은 exec-form `{"type":"command","command":"<process.execPath>","args":["<abs>/dist/hook.js","pre-tool"],"timeout":5}`. 설치 시점의 서명된 `node.exe`를 가리키므로 PATH, nvm/volta 이동, npm `.cmd` shim, Smart App Control 문제를 피하고 `doctor --fix`가 이동을 고친다. 플러그인 배포(`.claude-plugin/plugin.json`, `hooks/hooks.json`의 `"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/dist/hook.js","pre-tool"]`, `commands/review.md|status.md|why.md`)는 PATH의 `node`에 의존하므로 `doctor`가 호출 기록으로 검증한다. 번들은 `dist/` + `sql-wasm.wasm`; `@xenova/transformers`는 `--with-embeddings`에서만.
- Codex: `<repo>/.codex/hooks.json`(또는 `~/.codex/hooks.json`)에 `command`와 `commandWindows`를 절대 node 호출로 기록, `SessionEnd` timeout 1. 설치 후 `/hooks` 신뢰 단계를 출력하고 `doctor`는 한 번도 호출되지 않은 Codex 훅을 경고한다.
- OpenCode: `opencode.json` plugins 항목.

모든 설치는 `db:migrate`, 스냅샷 빌드, `import`를 실행하고 건드린 파일과 항목 해시를 `install-manifest.json`에 기록한다. `uninstall [--purge]`은 매니페스트 항목만 제거한다.

---

## 9. 동시성과 크래시 안전성

### 9.1 역할

reader: 모든 훅(스냅샷만, lock 없음, SQLite를 절대 열지 않음), `memory:list` 같은 읽기 CLI(스냅샷 또는 DB 읽기 전용 복사). writer: worker(`extract`, `dream`, `reindex`, `import`)와 CLI. ledger append는 세션당 파일 하나에 한 줄 `appendFileSync`(≤ 32 KB)라 병렬 `PostToolUse` 훅끼리 lock이 필요 없다. `state/*.json`은 `prompt`와 `stop` 훅만 tmp+rename으로 쓴다.

### 9.2 writer 프로토콜 (`db/store.ts` `withWriteLock(dir, purpose, waitMs, fn)`)

```
1  mkdirSync(locks/db.lock) (원자) → owner.json {pid, hostname, purpose, started_at, heartbeat_at}; 보유 중 5 s마다 heartbeat 갱신
   EEXIST → owner.json 읽기: 같은 host ∧ kill(pid,0)이 ESRCH → 인수(로그 'lock_takeover');
     같은 host ∧ 살아 있음 → 25–250 ms 지터 대기, waitMs(CLI 5 s, worker 30 s; 훅은 대기하지 않음) 초과 → LockBusyError(CLI exit 75);
     다른 host → heartbeat_at가 120 s 이상 오래됐을 때만 인수
2  bytes = readFileSync(memory.sqlite); verifyHeader("SQLite format 3\0"); 실패 또는 open 실패 → recoverFromPrev(.prev 복원, 손상본은 .corrupt-<ts>)
3  user_version < 21 → copyFileSync(→ memory.sqlite.bak-v<N>) → runMigrationsOnDb(db) → post-migrate(semantic_key 백필); 실패 시 백업 유지, 예외 전파
4  BEGIN; fn(db); derivePolicyRules(db); 파생 카운터 재계산; meta.db_generation += 1; write_ops 삽입; PRAGMA quick_check(1); COMMIT — 예외 시 ROLLBACK, 7로
5  export → memory.sqlite.tmp-<pid> → fsync → copyFileSync(memory.sqlite → .prev) → renameSync(tmp → memory.sqlite) (5회 재시도 20 ms; EPERM/EBUSY면 copy 폴백 + 경고)
6  buildSnapshot(db) → snapshot/active.v1.json.tmp-<pid> → rename; lexical.v1.json 동일 (source = 새 파일의 {mtime_ms, size})
7  finally: heartbeat 타이머 해제, rmSync(locks/db.lock, {recursive: true})
```

sql.js는 파일 lock이 없고 전체 파일을 export하므로 lock은 load→apply→save 전체를 직렬화하지만, 보유 시간은 수 초 이내다. **lock은 LLM 호출을 감싸지 않는다**(hook-native의 결함 수정).

### 9.3 `worker extract`의 두 lock 세션

```
A  worker.lock 획득(저장소당 worker 하나; 인수 규칙은 db.lock과 동일). 실패 → 즉시 종료
B  lock 세션 1 (≤ 1 s): queue/*.json → episodes INSERT OR IGNORE; fired_json → fire_count/last_fired_at;
   자격 있는 queued 에피소드를 교정 우선 → 오래된 순으로 ≤ 3개 lease(now + 180 s); 일일 캡 적용(교정·remember 제외); 해제
C  lock 없이: raw/<run_id>.json 캐시가 있으면 사용, 없으면 probe → provider 호출(≤ 120 s) → 캐시 기록
D  lock 세션 2 (≤ 2 s): write_ops에 run_id 있으면 extracted 표시; 아니면 V1–V9 → reconcile(§5.7) → 커밋(§9.2)
E  처리한 queue 파일 삭제; 남은 자격 에피소드가 있으면 B로(실행당 최대 10); worker.lock 해제
```

`memory:review`는 결정을 모아 10건마다 또는 종료 시 짧은 lock 한 번으로 적용하며, 프롬프트를 띄운 채 lock을 쥐지 않는다.

### 9.4 실패 모드와 정해진 행동

| # | 실패 | 행동 |
|---|---|---|
| F1 | writer 둘 동시 | 두 번째가 waitMs 대기 후 CLI exit 75, worker는 30 s 뒤 재시도 |
| F2 | 저장 중 크래시(rename 전) | tmp 고아, DB 무결; 다음 writer가 10분 지난 `*.tmp-*` 삭제 |
| F3 | DB 손상(헤더/quick_check) | `.prev` 복원, 손상본 보관, `doctor`가 손실 세대 보고 |
| F4 | lock 보유자 사망 | pid 생존 검사(같은 host) 또는 heartbeat 120 s(다른 host)로 인수 |
| F5 | 스냅샷 없음/손상 | 훅은 빈 결과, reindex worker 스폰(reindex.lock 60 s); SQLite를 열지 않음 |
| F6 | 스냅샷이 DB보다 오래됨 | stat 비교로 감지, 기존 스냅샷 사용 + reindex 스폰(빈 결과보다 한 세대 뒤가 낫다) |
| F7 | ledger 줄 찢김(훅 kill) | 파서가 건너뛰고 카운트, `doctor`에 `ledger_bad_lines` |
| F8 | worker가 배치 중 kill | lease 180 s 뒤 `queued`, 3회 후 `dead`; raw 캐시로 LLM 재지불 없음 |
| F9 | provider 느림/행 | 자식 120 s에 kill, `timeout`, 1 h/6 h/24 h 재시도 |
| F10 | provider 없음 | `no_provider` 하루 1회, 에피소드 `queued` 유지, `status`가 "N episodes waiting" |
| F11 | 쓰레기 추출 | V1–V9, 브레이커 → `suspect`, raw 7일, 재시도 없음 |
| F12 | 700 MB transcript / 거대한 툴 출력 | transcript는 열지 않음(`last_assistant_message`만); 출력은 head 2 KB + tail 1 KB |
| F13 | 2,000 메모리 | 스냅샷 buckets, lazy lexical, p95 ≤ 120 ms 게이트, `maxActiveMemories` 1,500 경고 |
| F14 | Windows rename 거부(AV, 열린 핸들) | 재시도 5회 후 copy 폴백 + 경고 |
| F15 | 디스크 가득(ENOSPC) | 훅은 삼키고 exit 0; worker는 rename 전에 중단, DB는 잘리지 않음 |
| F16 | 훅 재귀(headless 세션) | env 가드 + ppid 체인 + disableAllHooks/격리 cwd |
| F17 | `node` 이동/부재(nvm, volta) | `process.execPath` 기록, `doctor --fix` |
| F18 | DB가 코드보다 새로움(`user_version` > 21) | 읽기 전용; 훅은 스냅샷을 계속 읽음, CLI "upgrade harness-memory" |
| F19 | 중복 훅 등록(user+project) | `tool_use_id`로 ledger 중복 제거, `doctor` 경고 |

관측성: 훅마다 `2026-11-08T09:12:33Z PreToolUse claude:abc12 tool=bash scope=src/api/route.ts gen=42 activated=2 suppressed=17 decision=soft_deny delivery=before dur=63ms ok` 한 줄(`ok | bad_stdin | snapshot_missing | disabled | error:<code>`). `HARNESS_MEMORY_DEBUG=1`이면 전체 JSON을 `hooks-debug.jsonl`에. `doctor`는 매니페스트 대 실제 등록, node 경로, 이벤트별 마지막 호출, 큐 깊이, 마지막 `extraction_runs`, provider probe, lock 상태, `quick_check`, `user_version`, `db_generation` 대 스냅샷, `hooks.log`의 p95를 교차 확인하고 Claude Code `~/.claude/debug/<session>.txt`의 `Hooks: PreToolUse ... finished with status 0 (63ms)` 줄로 호스트가 우리를 실행했음을 증명한다(`doctor --host-debug <path>`).

---

## 10. 정책 엔진과 규칙 파생

`PolicyEvaluationRequest`는 `{lifecycleTrigger, scopeRef, toolName?, toolTarget?, toolInput?}`로 넓어지고, `PolicyEngine.evaluate`는 `trigger_kind` 일치 ∧ `tool_pattern` glob이 정규 툴에 일치 ∧ (scope regex 일치 ∨ 전역) ∧ (`arg_pattern`이 null이거나 `pattern_kind` 매처가 `target_kind`로 고른 target에 일치)인 규칙을 반환한다. 매처는 `activation/signature.ts` 하나를 엔진과 공유하므로 규칙과 피트폴이 어긋날 수 없고 `memory:why`가 둘 다 설명한다. `PolicyWarning`은 `enforcement`를 실어 어댑터가 §7.2로 매핑한다. 현재 35–46행의 scope-only 매칭은 `arg_pattern IS NULL` 규칙에만 남는다.

`policy/derive.ts`의 `derivePolicyRules(db)`는 **모든 writer 커밋 끝에서** `derived_at IS NOT NULL` 행을 지우고 active `policy` 메모리마다 다시 쓴다(이벤트 구동 파생은 편집·import·마이그레이션 뒤에 어긋나고, 커밋당 재구축은 함수 하나와 불변식 테스트 하나다). 규칙: `rule_code = 'POL-' + memory_id.slice(0,8) + '-' + trigger`, 트리거마다 한 행, `severity = enforcement === 'advise' ? 'info' : 'warning'`, `scope_glob`, `tool_pattern = signature.tool ?? relevant_tools.join('|') ?? '*'`, `target_kind = signature.target ?? 'any'`, `pattern_kind/arg_pattern = signature`, `enforcement = memory.enforcement`, `message = summary (+ ' — ' + details.slice(0,200) when enforcement ≠ advise)`, `derived_at = now`. `derived_at IS NULL`인 손으로 쓴 규칙(`policy:add`)은 보존된다. 불변식 테스트: `policy_rules WHERE derived_at IS NOT NULL == derive(active policies)`. eval 픽스처 `NO_COMMIT_SECRETS`는 시그니처 `{write|edit, path, glob, "**/.env*"}`, `enforcement='confirm'`의 human policy 메모리가 된다.

---

## 11. CLI 표면과 리뷰 UX

바이너리 `harness-memory`(별칭 `hm`), 프로세스 내 직접 디스패치, 모든 명령에 `--json`, `--db`.

| 그룹 | 명령 |
|---|---|
| 설치 | `install --host claude\|codex\|opencode\|all [--user] [--with-embeddings]`, `uninstall [--purge]`, `doctor [--fix] [--host-debug <path>]`, `db:migrate`, `snapshot:rebuild`, `bench:hook` |
| 상태 | `status`(한 줄: `active 212 (auto 61, provisional 9) \| candidates 7 \| proposals 3 \| queue 2 \| last extraction 2h ago ok \| snapshot gen 42 fresh \| p95 71ms`) |
| 리뷰 | `review`(사람 메모리 대상 제안 → policy 후보 → 전역 후보 → 최근 auto 활성화; 키 `a`ccept `r`eject `e`dit `s`kip `t`race `p`romote-as-human), `proposals:list\|accept\|reject\|withdraw` |
| 메모리 | `memory:list\|show\|add\|promote\|demote\|reject\|restore\|edit\|enforce <id> <level>\|history\|export\|export-skill\|stats\|why --trigger --tool --target --scope`, `memory:trace <id>`(memory → provenance → episode → ledger excerpt) |
| 파이프라인 | `episodes:list\|show\|retry`, `queue list\|retry-dead\|drop`, `extract [--now] [--provider] [--dry-run]`, `dream`, `trace <session_key>`(이벤트, 캡처 순간, 닫힘, 큐 결정, run, fact 결과 타임라인) |
| import | `import [--from CLAUDE.md AGENTS.md .cursorrules MEMORY.md] [--yes] [--sync]` |
| eval | 기존 `eval:*` + `eval:latency`, `eval:replay`, `eval:live` |

리뷰는 예외 처리다. 모델 컨텍스트에 리뷰 텍스트는 들어가지 않는다(D6); 세션 내 표면은 `SessionStart`의 사용자 가시 `systemMessage` 한 줄(하루 1회)뿐이다. `review`의 각 항목은 대상, 후보, 근거, 신뢰도, `support_count`, 첫 provenance excerpt를 보여 준다.

`import`: 파일을 불릿·헤딩 단위로 쪼개 `import` 에피소드(`e<N>` = 줄 번호)로 렌더하고 **같은 추출기**를 `action = create`로 제한해 통과시킨다. 결과 표(type, scope, signature, triggers, 제안 enforcement)를 확인(또는 `--yes`)한 뒤 `active`, `authority='human'`, `source_kind='import'`, `source_ref='import:<file>#L<n>'`, 전역 scope면 `activation_class='baseline'`로 삽입하고 정책 규칙을 파생한다. 확인 단계가 사람 게이트이므로 후보로 두지 않는다. 네이티브 `MEMORY.md`는 기계가 쓴 것이므로 `candidate`로 들어가 `decideTier`를 거친다. 재실행은 줄 해시로 멱등이며 삭제된 불릿은 보고만 하고 `--sync`일 때 `stale(import:removed)`. 현재 `install.ts`가 불릿을 scope `**`·`before_model` policy로 만드는 경로는 삭제된다(툴 경계에서 발화할 수 없는 바로 그 형태다).

---

## 12. 결함 커버리지 매트릭스 (R1–R7, D1–D7)

| ID | 결함 | 구조적 제거 |
|---|---|---|
| R1 | LLM 후보가 자동 승격 불가(evidence 0) | `memory_provenance` 행이 fact 적용과 같은 트랜잭션에서 `evidence_refs`마다 쓰이고(스키마 `minItems: 1`), `evidence_count/evidence_score`는 그 집합에서 재계산된다. `decideTier`는 그 컬럼만 읽는다 |
| R2 | `**/*` + `before_model` 하드코딩 | `scope_glob`, `lifecycle_triggers`, `relevant_tools`, `trigger_signature`는 스키마 필수이고 V3·V4가 검증하며 reconcile에 기본값 코드가 없다. 시그니처 없는 `**/*`는 사람 게이트. 레거시 피해자는 `needs_scope=1` + `fix_scope` |
| R3 | 프로세스 수명당 추출 1회 | 게이트는 "자격 있는 queued 에피소드가 있는가" 하나. 카운터·게이트 파일 없음. `Stop`마다 worker 스폰 |
| R4 | LLM supersede/stale이 사람 메모리 즉시 제거 | `transitionMemory`가 `auto_rule`/`expiry`의 human 행 전이에 `AuthorityViolationError`. `update()`는 `status` 거부, grep 테스트가 다른 `UPDATE memories SET status` 금지. LLM 어휘는 `propose_*`뿐 |
| R5 | 중복 fact가 throw, 배치 영구 재시도 | `semantic_key` 조회가 삽입에 선행해 중복은 `reinforce`; `DuplicateMemoryContentError`는 잡혀 전환. fact별 SAVEPOINT, 소비와 적용이 한 트랜잭션, `write_ops`로 run 멱등, 재시도 3회 후 `dead` |
| R6 | 템플릿 문장 후보 | `DreamWorker` 삭제; 정규식은 시그니처·플래그 추출에만. 레거시 템플릿 후보는 017에서 `rejected` |
| R7 | `dream:run`이 conversation-batch 소비 | 입력 스트림 하나(ledger → episodes), 소비자 하나(`worker extract`); `dream`은 `memories`/`proposals`만 읽음. 레거시 배치는 021에서 에피소드로 폴드 |
| D1 | 플러그인이 DB를 상주시키고 덮어씀 | 어떤 프로세스도 훅 호출 사이에 DB를 들지 않는다. writer는 lock → load → apply → save → rename → snapshot, 훅은 원자 교체되는 스냅샷의 reader. bash 출력 감지 삭제 |
| D2 | mem0식 프롬프트, scope/tool/trigger 없는 스키마 | §5.5 스키마와 §5.4 프롬프트가 에피소드 구조에서 조립되고 scope·툴·시그니처·트리거·인용을 강제 |
| D3 | 5개 단위 flush, 300/4,000자 절단, 세션 귀속 오류 | 에피소드 = `Stop`/`PreCompact`에서 닫는 턴(교정·해결 플래그), 발췌 2 KB + 1 KB, 오류 1.5 KB, 프롬프트 24 KB, 모든 라인에 `session_id`·`turn_key` |
| D4 | `reinforce`가 재검증하지 않음 | §5.7 5단계가 `revalidateMemory`로 TTL을 `ttlDays(v)` 연장; `consolidate`가 만료를 집행 |
| D5 | scope-only 정책 엔진, 규칙 writer 부재 | `signature.ts`로 툴 + target 매칭; `derivePolicyRules`가 모든 커밋에서 실행 |
| D6 | 리뷰 인박스를 시스템 프롬프트에 주입 | 어떤 훅도 리뷰 텍스트를 `additionalContext`에 넣지 않음; 표면은 CLI와 사용자 가시 한 줄 |
| D7 | 툴 호출마다 2 KB evidence 행 | 훅은 SQLite를 쓸 수 없다; 발화는 ≤ 200 B ledger 한 줄, worker가 `fire_count`로 롤업 |

---

## 13. 평가 계획

1. **읽기 경로 회귀(결정적).** `eval:replay`가 12 시나리오(`research/eval/task-corpus.md` s01–s12)를 실제 훅 진입점에 합성 stdin 시퀀스로 구동한다. 픽스처는 시그니처·`authority`·`enforcement`를 갖는다(s03: `{write|edit, path, glob, "**/.env*"}` confirm → `permissionDecision: ask`; s06: `signature_mismatch`로 침묵; s09: stale 억제; s12: 3 / 2 KB 예산). 기존 기준(중요 누락 0, stale·conflict 마커)에 더해 **어떤 시나리오에서도 auto 경로가 human 행의 status를 바꾸지 않음**.
2. **쓰기 경로 재생(결정적).** 12개 ledger 픽스처(s07은 두 세션에 걸친 실패→해결 쌍)와 `replay` provider의 기록 응답. 단언: 결과 메모리의 `scope_glob`·`lifecycle_triggers`·`trigger_signature` 일치; 그 메모리가 대응 읽기 시나리오에서 발화(7 → 4 루프); 같은 run 2회 적용 시 export 바이트 동일; 환각된 `propose_supersede`는 human 행에 제안만; 1-support `propose_stale`은 auto 행을 바꾸지 않고 2-support가 바꿈.
3. **지연 게이트.** `eval:latency`(§6.3); `bench:hook`은 같은 측정을 개발자 기계에서 출력.
4. **운영 스위트(vitest, Windows 러너 포함).** `writeFileSync(tmp)`와 `rename` 사이 `SIGKILL`; 병렬 훅 20개 append + CLI promote 루프(손실 0, 교착 0, exit 75 경로); 쓰레기 추출 픽스처(비 JSON, fact 40개, 환각 `evidence_refs`, 파국적 regex); v0.5 DB 픽스처(R2 피해자, pending `conversation-batch`, 템플릿 후보)의 017–021 단언; `identity_key` 충돌 픽스처; exec-form 설치의 `node.exe` 절대 경로.
5. **라이브 A/B(`eval:live`).** 12 시나리오 + "배우고 적용" 2세션 시나리오 6개(세션 A에 교정 또는 실패→해결, 세션 B가 올바른 경계에서 경고)를 `claude -p`와 `codex exec`로 세 팔, 시드 5개: **A** 마크다운 전용, **B** 네이티브 auto-memory(`MEMORY.md`에 같은 규칙), **C** `CLAUDE.md` + harness-memory(`import` 결과와 재생 에피소드로 만든 auto 메모리). 지표: (1) 중요 정책 누락률(A 대비 ≥ 30 % 감소가 계속 조건; s03은 `.env.local` 실제 기록 여부로 결정적 판정), (2) **타이밍 열**: 경고가 위험한 호출 *전* / *결과와 함께* / *전혀*(`fired.delivery` 집계; 마크다운과 `MEMORY.md`는 구조적으로 "세션 시작만"), (3) 경고 정밀도 ≥ 0.7, (4) heed rate, (5) 턴당 주입 바이트(C ≤ A의 25 %), (6) 추출 수율(시그니처 비율, auto 활성화 비율, 대응 시나리오 발화 비율). 타이밍 열은 wedge 자체를 재는 유일한 지표이며 `memory:stats`에도 노출된다.
6. **dogfood 2주.** 저자 저장소에서 같은 수치에 더해 `review`에서 거부된 auto 활성화 비율(autonomy regret)을 `memory:stats --since 14d`로 본다. 0.1을 넘으면 `before_tool.auto_enforcement`를 `advise`로 내리는 것이 첫 조정이다.

---

## 14. 구현 로드맵 (마일스톤, 주 단위, 솔로 개발자 기준)

| 주 | 마일스톤 | 산출물 |
|---|---|---|
| 1 | M0 사실 시트 + 저장소 계층 | §15.2 확인; `store.ts`, `locks.ts`, `.prev` 회전, 마이그레이션 017–021 + 픽스처, `post-migrate.ts`, `runMigrationsOnDb` |
| 2 | M1 엔진·스냅샷 | `MemoryReader`, lazy lexical, `signature.ts`, `tool-vocabulary.ts`, `snapshot.ts`, `snapshot-reader.ts`; 315 테스트 녹색 |
| 3 | M2 훅 핫패스 + Claude Code | `hook.ts` 번들, `hook-io.ts`, `ledger.ts`, `hosts/claude-code.ts`, enforcement 출력, `install --host claude`, `eval:latency` 게이트 |
| 4–5 | M3 쓰기 경로 | `episode.ts`, `worker.ts`, providers(claude, codex, replay), 스키마·V1–V9·브레이커, `reconcile.ts`, `transitions.ts`, `authority.ts`, `proposals.ts`, `derive.ts`. **5주 말: Claude Code 전용 dogfood 빌드** |
| 6 | M4 CLI·리뷰·import | `review`, `proposals:*`, `status`, `doctor`, `trace`, `episodes:*`, `import`, `uninstall` |
| 7 | M5 Codex + dream | `hosts/codex.ts`(apply_patch, 실패 유도 픽스처), `commandWindows`, `/hooks` 안내, `consolidate.ts`, TTL 집행, GC |
| 8 | M6 OpenCode V2 + 레거시 | `Plugin.define` 어댑터, V1 shim, 레거시 재추출, `eval:replay` 픽스처 12개 |
| 9–10 | M7 평가·dogfood·릴리스 | 운영 스위트, `eval:live` 3팔, 2주 dogfood, 기본값 조정, 문서, v0.6.0 |

총 10주, 위험 여유 +2주(Codex 실패 유도와 OpenCode V2 미검증 항목이 주요 변수). 삭제 약 3,900줄(`opencode-plugin.ts` 1,467, `dream/repository.ts` 774, `dream/worker.ts` 680 등), 추가 약 2,800줄(hook-native 추정 2,000에 검증·전이·제안·doctor를 더한 수치).

---

## 15. 열린 질문과 결정 필요 사항

### 15.1 브리프와 다른 결정 (심사관이 사실로 뒤집은 항목)

1. **§6 `additionalContext`로 실행 전 주입 → 틀림.** Claude Code `PreToolUse`의 `additionalContext`는 툴 결과와 함께 도달하고 실행 전 채널은 `ask`/`deny`뿐이므로 "경고 우선, 기본 하드블록 없음"을 메모리 단위 enforcement 사다리로 재정의했다(§7). 시그니처 있는 auto 피트폴의 기본 `soft_deny`는 모델이 재시도로 언제든 진행할 수 있으므로 하드블록이 아니다.
2. **§6 기본 타임아웃 60 s → 600 s**(UserPromptSubmit 30 s, SessionEnd 1.5 s/1 s), async 훅은 `-p` 종료 시 kill. 추출은 분리 실행 worker만 가능하고 Stop·PreCompact에는 아무것도 출력하지 않는다(Stop 출력은 턴을 계속시키고 PreCompact stdout은 압축 지시가 됨). 모델 가시 텍스트를 실을 수 있는 이벤트는 SessionStart, UserPromptSubmit, PreToolUse(ask/deny 사유), PostToolUse/PostToolUseFailure뿐이다.
3. **§4.D 훅 프로세스의 lock + load/apply/save → 훅은 SQLite를 열지 않는다.** sql.js init+open만 54 ms이고 훅은 병렬이다. writer는 worker와 CLI 둘뿐(§9).
4. **§5 "핫패스는 문제 아님" → 훅 호스트에서는 프로세스 시작·모듈 로드가 지배.** dense+BM25+RRF는 엔진에 남아 쓰기 측·OpenCode·CLI에서 쓰이고, 훅의 before_tool은 scope + 시그니처만, before_model은 BM25만(§6). 예산은 before_tool 3 / 2 KB, after_tool 2 / 1 KB(툴 호출당 8 KB는 50회 턴에 400 KB).
5. **제약 8 ↔ `--bare`.** bare 모드는 OAuth를 읽지 않고 API 키를 요구하므로 쓰지 않는다. 재귀 가드는 env + ppid + `disableAllHooks`/격리 cwd(§5.4). `-p` 기본이 bare로 바뀔 수 있다는 공지는 열린 위험(§15.3).
6. **제약 2의 `before_model` = 모델 호출마다 → 훅 호스트에서는 사용자 턴당 한 번.** Codex `PreModelRequest`는 주입 미지원, OpenCode V2 `context`만 모델 호출 단위.
7. **§3 "증거 ≥ 2" → 가중치 ≥ 2(교정 1회 또는 실패→해결 쌍 1회), 강등에만 2-support**(§7.4). **"닫힌 에피소드마다 추출" → 의미 신호 또는 결정 마커가 있는 에피소드만**, 교정·remember는 일일 캡 면제(§5.3).
8. **§4.G import는 부수 항목 → 첫 사용자의 첫날 경로.** 추출기를 거쳐 scope·시그니처·enforcement를 얻고, `MEMORY.md`는 auto 후보로(§11).
9. **§4.A transcript 파일을 상태 위치로 → 불투명 포인터.** `last_assistant_message`와 훅 페이로드만(§5.1).
10. **§6 Codex 설정 → `.codex/hooks.json`은 신뢰된 계층에서만 로드되고 `/hooks` 해시 신뢰가 필요.** 조용한 설치는 불가능하다(§8.7).
11. **§3 OpenCode 어댑터 → 현재 플러그인은 V1이고 V2에서 실행되지 않는다.** `Plugin.define`으로 작성(§8.4).
12. **제약 7 "zero native dependencies" → 현재 패키지는 sharp(네이티브)를 끌어온다.** "핫패스에 네이티브 코드 없음, 임베딩은 선택 설치"로 읽는다(§2).
13. **제약 6 "마이그레이터 유지" → 유지하되 원자적 writer 안에서 `.bak-v16` 선행 후 실행하고, 007의 `identity_key UNIQUE`는 017에서 부분 유니크 인덱스로 재구축**(§4.1). 해시 백필은 writer의 1회 작업이다.

### 15.2 구현 전에 사실 시트로 확정할 미검증 항목

- Codex `PreToolUse` `additionalContext`의 타이밍(실행 전인지 결과와 함께인지), Codex `systemMessage` 지원 여부, Codex Stop 입력의 `last_assistant_message` 존재, Codex `tool_response`의 exit code 형태(실패 유도 픽스처 필요), Codex `-c features.hooks=false` 동작, `permissionDecision: "defer"`(Claude Code, 한 설계만 언급).
- OpenCode V2의 idle 이벤트 이름, `execute.before`에서 throw가 툴 거부로 작동하는지와 사유 전달 방식, `context` 훅의 정확한 페이로드.
- Claude Code 플러그인의 `${CLAUDE_PLUGIN_DATA}`, 플러그인 `bin/`이 Bash 툴 PATH에 오르는지(슬래시 명령이 `hm`을 호출하려면 필요), Windows에서 플러그인 hooks.json의 `"command":"node"` PATH 해석.
- `claude -p --json-schema`에서 `structured_output`이 비는 조건, `--disallowedTools "mcp__*"` 와일드카드 지원.
- 네이티브 `MEMORY.md`의 프로젝트 슬러그 인코딩 규칙(import 경로 해석).

### 15.3 저자 결정이 필요한 항목

1. 시그니처 있는 auto 피트폴의 기본 enforcement를 `soft_deny`로 출하할지, `advise`로 출하하고 dogfood 뒤 올릴지(이 명세는 `soft_deny`, regret > 0.1이면 되돌림).
2. `confirm`(= `ask`)이 자동 승인 모드(`bypassPermissions`, `-p`)에서 거부로 바뀌는 동작을 받아들일지, 그 모드에서는 `soft_deny`로 강등할지.
3. 글로벌 DB와 `activate_global`을 v0.6에 포함할지 0.7로 미룰지.
4. 추출 모델 기본값(구독 기본 모델 대 haiku급)과 Codex 쪽 기본.
5. `-p`가 `--bare` 기본이 되면 `codex exec`/OpenCode SDK 폴백을 자동 선택할지, API 키를 선택 제공하게 할지.
6. heeded-fire 추론, 신뢰 티어, 모순 예산, 일일 활성화 캡을 0.7에서 도입할지 영구 제외할지(v0.6은 모두 제외).
7. `legacy_dream_*` 테이블을 0.7에서 삭제할지; worktree가 `.harness-memory`를 공유할지(`config.shared_db_path`); `decision` 타입을 자동 활성화 대상에 넣을지(현재 제외).
