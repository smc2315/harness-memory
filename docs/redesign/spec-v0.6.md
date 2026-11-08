# harness-memory v0.6 통합 재설계 명세 (개정 3)

입력: `redesign-brief.md`, `harness-memory-core-review.md`(R1–R7, D1–D7), 후보 설계 4종, 심사 3종, 1판에 대한 적대적 비평 4종(defect-closure, host-feasibility, concept-and-autonomy, migration-and-complexity). 참조 코드는 v0.5.1 클론(`C:\Users\choey\AppData\Local\Temp\hm-src\repo`, 읽기 전용). 골격은 `hook-native-minimal`이다: 무상태 50–90 ms 훅 프로세스가 사전 계산된 JSON 스냅샷을 읽고, 분리 실행 1회 worker가 유일한 추출 런타임이며, 에피소드가 곧 큐이고, 증거 가중치(remember 3 / correction 2 / resolution 2 / failure 1)로 단일 에피소드 자동 활성화를 한다. 개정 2는 비평의 차단·주요 결함을 모두 설계 결정으로 닫았고, 개정 3은 독립 검증(비평가 3명: 결함 닫힘·절 간 일관성·호스트 실현 가능성; 차단 0, 주요 14, 부수 34건)의 지적을 반영했다(각 절의 괄호 문장은 배제한 대안과 그 결과를 적는다); 기각·부분 수용한 비평은 §15.4에 있다. 호스트 사실 시트는 `design-candidates/host-hook-facts.md`에 있다(브리프 §6 정정 16건, 실측치, 미검증 항목). §8.1은 그중 심사관 3명과 host-feasibility 비평가가 2026-11-08에 공식 문서와 Windows 11 / Node 24.14 실측으로 확인한 항목만 담고, 미검증 항목은 §15.2이며 M0(§14)에서 확정한다.

---

## 1. 목표와 비목표

### 1.1 목표

- **G1 wedge를 실제로 전달한다.** 추출된 지식이 툴이 실행되기 *전에* 모델에 도달해야 한다. Claude Code `PreToolUse`의 `additionalContext`는 툴 결과와 함께 도달하고 실행 전 채널은 `permissionDecision: ask|deny`뿐이므로, "경고 우선"은 메모리 단위 `enforcement` 사다리(§7)로 구현한다.
- **G2 쓰기 경로 하나.** 에피소드 → 구조화 추출 → 결정적 reconcile → 권한 티어 활성화. 정규식 후보 공장, 대화 버퍼, 세션 카운터 게이트, dream evidence 상태 머신은 삭제한다.
- **G3 권한은 쓰기 경로의 불변식.** `authority`는 삽입 시 반드시 명시되는 컬럼(기본값 없음)이고 `transitionMemory` 하나가 사람 메모리의 상태를 LLM 경로가 바꿀 수 없게 한다. 호스트 에피소드(`host ≠ 'import'`)의 추출이 만든 행은 예외 없이 `authority='auto'`로 태어난다; 사람이 쓴 파일의 `import` 행만 `human`이다(`--yes`는 enforcement 상한 advise + `import_unconfirmed=1`; 기계가 쓴 `MEMORY.md`는 auto).
- **G4 핫패스는 파일 하나를 읽는다.** `PreToolUse` 프로세스는 sql.js, minimatch, MiniSearch, transformers.js를 로드하지 않는다. p50 ≤ 70 ms, p95 ≤ 90 ms(300 메모리, CI 게이트), 데몬 없음.
- **G5 "아무것도 저장되지 않는다"에 답한다.** 훅 호출마다 한 줄 로그; `doctor`/`status`/`trace`가 결함 위치를 이름으로 말한다.
- **G6 v0.5 데이터베이스를 손실 없이 올린다.** 메모리 행은 하나도 삭제하지 않는다. 추출 모양의 행(`**/*` + `["before_model"]`)은 *모양*으로 찾아 `needs_scope=1`과 `fix_scope` 제안을 받고, 미처리 `conversation-batch` 증거는 `legacy_*` 테이블에 보관한다(재추출하지 않는다).
- **G7 첫 사용자(긴 `CLAUDE.md`를 가진 Claude Code 파워 유저)가 2주 안에 가치를 본다.** `import`가 첫날 scope와 시그니처를 가진 규칙을 만들고, 교정 한 번이 다음 턴의 `PreToolUse`에서 발화한다(§13.2의 재생 단언).

### 1.2 비목표

범용 관찰 로그·검색(claude-mem), 상주 데몬, 핫패스 밀집 검색, 시스템 프롬프트 리뷰 인박스, transcript 파싱, 다중 머신 동기화; 0.7로 미룸: Codex `PreModelRequest` 주입, heeded-fire 추론, 글로벌 DB 동기화, auto↔auto 자동 병합, 스냅샷 `buckets`; 영구 제외: 레거시 배치 재추출.

---

## 2. 유지 / 제거 / 변경 요약표

| 구분 | 항목 | 비고 |
|---|---|---|
| 유지 | 다섯 타입, 네 트리거, 상태 어휘; `ActivationEngine`(dense+BM25+RRF, scope glob, 예산, 쿼터, 4 모드, 4 클래스); 보안 스캐너, audit/file 로거, eval 인프라, 어댑터 타입, 마이그레이션 001–016, 마이그레이터, sql.js, MiniSearch, minimatch, MIT, 텔레메트리·계정 없음 | 엔진은 `MemoryReader` 타입, lazy lexical, **startup 트리거 필터**(§6.4)만 변경; 마이그레이터는 `runMigrationsOnDb(db)`로 분리 |
| 제거 | `DreamWorker` 후보 합성, `ConversationBuffer`, 게이트 파일, `isHarnessMemoryCliCall`/`reloadDbFromDisk`, 리뷰 다이제스트 주입, `summary-generator.ts`, `dream-*` CLI, `fixtures-add-policy-rules`, `install.ts`의 불릿 import, 툴 호출당 evidence 행; `@xenova/transformers` 설치 의존 | R3, R6, R7, D1, D3, D6, D7; transformers는 `peerDependencies` + `peerDependenciesMeta.optional`(`optionalDependencies`는 npm이 기본 설치한다), `install --with-embeddings` |
| 재작성 | `revalidateMemory`; `MemoryRepository` | `authority==='auto' && status==='active'` 게이트, `promotion_source` 미참조(D4); `create()`에 `authority` 필수, 중복 조회 status 필터, `reviveTerminal`, `update()`의 `status` 거부, 상태 메서드 재배선(§4.7) |
| 변경 | 추출(에피소드 단위, 스키마 §5.5, V1–V11, 결정적 reconcile, `write_ops` 멱등); 저장소(017–021, `user_version = 21`); 정책 엔진(툴 + 인자 시그니처, 커밋마다 파생); 호스트(Claude Code Bash·PowerShell, Codex, OpenCode V2); 동시성(훅은 스냅샷 읽기 + ledger append, writer는 worker와 CLI); 테스트(삭제 모듈에 걸린 ≈150개 이식·퇴역, 회귀 바닥 ≈73개) | R1, R2, R4, R5, D1, D2, D5, §8, §13 |

---

## 3. 아키텍처 (모듈, 프로세스 모델, 상태의 위치)

### 3.1 프로세스

| 프로세스 | 진입점 | 수명 | 로드 | 쓰기 |
|---|---|---|---|---|
| hook | `dist/hook.js <event>`(≤ 20줄 런처: Node ≥ 22.1이면 `module.enableCompileCache()` 후 `require('./hook-bundle.js')`; 번들 자신은 컴파일 캐시 혜택을 못 받으므로 런처를 분리한다) | 50–90 ms | `snapshot/active.v1.json`; `prompt`/`session-start`만 `lexical.v1.json` | `ledger/*.jsonl` append, `state/*.json`, `queue/*.json`, `logs/hooks.log`, `snapshot/.reindex-requested`(touch) |
| worker | `dist/worker.js extract\|dream\|reindex\|import` | 1–120 s, 분리 1회 | sql.js(인라인), 선택적 임베딩, headless CLI | `memory.sqlite` + 스냅샷(lock), `raw/*.json` |
| CLI / OpenCode 플러그인 | `dist/bin/harness-memory.js` / `dist/plugin/index.js`(V2) | 대화형 / 호스트 수명 | sql.js / 스냅샷(mtime 캐시) | 동일 lock 규율 / DB 상주 없음, 쓰기는 worker 스폰 |

worker는 `spawn(process.execPath, [workerPath, ...], {detached: true, stdio: 'ignore', windowsHide: true, env: providerEnv()}).unref()`. `providerEnv()`는 `process.env`를 펼치지 않고 **허용 목록**(`PATH, HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP, TMP, SystemRoot, ComSpec, PATHEXT`, 프록시 변수, 존재하면 `ANTHROPIC_*`·`OPENAI_*`·`CODEX_HOME`, `HARNESS_MEMORY_DISABLE=1`)으로 만들고 `CLAUDECODE`, `CLAUDE_CODE_*`, 그 외 `CODEX*`는 넣지 않는다: Claude Code는 모든 훅 자식에 `CLAUDECODE=1`을 넣고 이를 상속한 중첩 `claude -p`가 거부·행된 보고(anthropics/claude-code #26190, #32618)가 있다; `{...process.env, …}`로 펼치면 그 상속 경로가 열린다. 호스트는 종료 시 async 훅을 죽이므로 추출은 분리 worker에서만 돈다; 분리 자식 생존은 Node 호스트에서만 검증됐고 실제 바이너리는 M0에서 본다.

### 3.2 상태의 위치

| 경로 | 내용 | writer |
|---|---|---|
| `<repo>/.harness-memory/memory.sqlite`, `.prev`, `.bak-v16` | 진실의 원천 | worker, CLI (lock) |
| `snapshot/active.v1.json`, `lexical.v1.json` | active 메모리(임베딩 제외, 사전 컴파일 scope regex, 시그니처, `source_file`), 정책 규칙, `failure_index`, 카운트, `source {mtime_ms, size}`, `db_generation`, `user_version`, `last_dream_at`, `last_probe`; MiniSearch 직렬화 + `recent_summaries` | 모든 DB writer, tmp+rename |
| `ledger/<host>-<session_key>.jsonl`; `state/<host>-<session_key>.json`, `.notify.json`; `queue/<episode_id>.json` | 세션 원시 이벤트(append-only, 세션 중 rename 없음); `{turn_key, turn_start_offset, segment, correction_for?}`(tmp+rename), worker→`prompt` 훅 알림(§7.4); 에피소드 디스크립터(= 큐 항목) | 훅; `prompt`·`stop`·`precompact`(호스트가 직렬화), `.notify.json`만 worker; + `session-end` |
| `raw/<run_id>.json`, `locks/*.lock/`, `logs/*.log`, `config.json`, `install-manifest.json` | provider 원본 캐시(24 h; `suspect` 7 d); `mkdirSync` 원자 lock + `owner.json`; 호출당 한 줄(5 MB × 3 회전); 설정; 매니페스트 | worker / 획득자 / 전원 / install |
| `~/.harness-memory/worker/<repo_hash>/`; `~/.harness-memory/global.sqlite` | headless CLI용 빈 cwd, **git 저장소 밖**(Claude Code는 cwd 상위 `CLAUDE.md`·auto memory·프로젝트 훅을, Codex는 git 루트까지의 `AGENTS.md`를 로드한다); v0.5 글로벌 DB는 그대로 둠 | install; CLI `--global`만(훅은 읽지 않음, 0.7) |

`last_scope_ref`와 `pending_failures`는 상태 파일에 없다: 병렬 `PostToolUse` 훅이 써야 하는 값이라 ledger 꼬리에서 파생한다(§5.1, §6.2).

### 3.3 모듈 맵

| 모듈 | 신규/재작성 (삭제는 §2) |
|---|---|
| `src/activation` | `MemoryReader`, `snapshot-reader.ts`, `signature.ts`(공용 매처: cmd 정규형, PowerShell 분할기, V5/V10), `tool-vocabulary.ts`, lazy lexical, `mode-startup.ts` 트리거 필터 |
| `src/dream` | `ledger.ts`, `episode.ts`, `extract/{schema,prompt,validate}.ts`, `extract/providers/{claude,codex,opencode,replay}.ts`, `reconcile.ts`, `consolidate.ts`, `worker.ts`, `legacy-reader.ts`(구 `worker.ts`·`llm-extract.ts`·`repository.ts` 삭제) |
| `src/promotion`, `src/policy`, `src/security` | `transitions.ts`, `authority.ts`(`decideTier`, `enforcementDefault`), `proposals.ts`, `revalidate.ts`(`auto-promoter.ts` 삭제); `engine.ts`(툴+시그니처), `derive.ts`; `scanMemoryContent(..., {source})`, `self-reference.ts` |
| `src/adapters`, `src/plugin` | `hook-core.ts`, `hosts/{claude-code,codex}.ts`, `hook-io.ts`, `opencode-adapter.ts`(얇게); V2 `Plugin.define`; `src/hook-launch.ts`(런처, `dist/hook.js`), 단일 번들 `src/hook.ts`(`dist/hook-bundle.js`)·`src/worker.ts` |
| `src/db`, `src/memory` | `migrations/017–021`, `store.ts`, `locks.ts`, `snapshot.ts`, `post-migrate.ts`, `repositories/{episodes,runs,proposals,provenance,transitions}.ts`; `memory/repository.ts` 변경 |
| `src/cli`, `src/retrieval`, `src/audit` | `install/uninstall/doctor/status/review/proposals-*/queue/trace/import/snapshot-rebuild/db-rollback/eval-latency/eval-replay`; 세션 요약은 worker가 upsert; audit 이벤트 `episode_closed/extraction/reconcile_action/proposal/transition/enforcement_downgrade/auto_activation_shadow` |

### 3.4 세션·턴·세그먼트 식별

`session_key = sha1(host + ':' + session_id).slice(0, 16)`. 턴 키는 Claude Code `prompt_id`, Codex `turn_id`, OpenCode 메시지 id(`prompt_id`가 stdin에 없거나 직전 턴의 값과 같으면 `turn_key = 'p:' + session_key + ':' + ledger_offset`을 그 턴 내내 쓴다 — 훅은 오프셋으로 ledger를 읽으므로 키 값 자체에 기대지 않고, state 파일의 writer는 `prompt`/`stop`/`precompact`로 유지된다; §15.2). 한 턴은 여러 번 닫힐 수 있으므로(턴 중간의 PreCompact, 다른 Stop 훅의 `stop_hook_active=true`) 닫을 때마다 `state.segment`를 올리고 `turn_start_offset`을 전진시키며, 에피소드 id는 `createDeterministicId('episode:' + host + ':' + session_id + ':' + turn_key + ':' + segment)`다: 같은 세그먼트의 재닫기는 같은 id, 다른 세그먼트는 다른 에피소드라 압축 뒤의 해결 부분이 `INSERT OR IGNORE`에 먹히지 않는다. 서브에이전트 이벤트(`agent_id`)는 기본 제외. 프로젝트 루트는 `cwd` 조상의 첫 `.harness-memory/`, 없으면 `.git/`.

---

## 4. 데이터 모델 (DDL 수준, 상태 머신, 마이그레이션 017+)

최종 `user_version = 21`. **마이그레이션 파일은 새 연결에서, 트랜잭션 없이, 저장소 클래스를 생성하기 전에 실행한다**(`runMigrationsOnDb`): `PRAGMA foreign_keys = OFF`는 트랜잭션 안에서 무효이고, FK가 켜진 채 `DROP TABLE memories`를 하면 `evidence`(001)와 `dream_memory_evidence_links`(005)가 CASCADE로 지워진다. 원자성은 메모리 내 적용 + tmp/rename 저장에서 오고 실행 전 `memory.sqlite.bak-v16`을 만든다; `hm db:rollback`은 확인 뒤 복원하고 `uninstall --purge`도 백업은 남긴다. 017 픽스처 테스트는 `evidence`·links 행 수 불변을 단언한다. DDL 축약 표기: 타입 없는 컬럼은 TEXT, `!`는 NOT NULL, `INT0`/`REAL0`은 `INTEGER/REAL NOT NULL DEFAULT 0`, `'x'`는 기본값, `→T(id)`는 `REFERENCES T(id) ON DELETE CASCADE`, `CHECK IN (…)`은 열거 CHECK.

### 4.1 `017_memories_authority.sql`: `memories` 재구축

007의 `identity_key TEXT UNIQUE`는 같은 fact의 `superseded` 행과 새 행을 충돌시키므로 살아 있는 상태에 한정한 부분 유니크 인덱스로 바꾼다. 기존 23개 컬럼(`id`부터 `last_verified_at`까지, `promotion_source`·`validation_count`·`policy_subtype` 포함)은 타입·CHECK 그대로 옮기고(`identity_key`의 UNIQUE만 제거) 다음을 더한다.

```sql
PRAGMA foreign_keys = OFF;
CREATE TABLE memories_new (
  <기존 23개 컬럼>,
  semantic_key,                            -- sha256(type|scope_glob|signature_key|normalize(summary))
  trigger_signature_json, signature_key! '', knowledge_kind CHECK IN ('correction','failure_resolution','convention','decision','import','manual'),
  failure_classes_json, status_reason, superseded_by_memory_id, source_ref, revalidate_after, last_fired_at, open_proposal_id,
  authority! CHECK IN ('human','auto'),    -- 기본값 없음: 삽입자가 반드시 결정
  enforcement! 'advise' CHECK IN ('advise','confirm','soft_deny','deny'), source_kind! CHECK IN ('manual','import','extraction','legacy'),
  evidence_score REAL0, evidence_count INT0, distinct_session_count INT0, fire_count INT0, override_count INT0,
  contested INT0, needs_scope INT0, import_unconfirmed INT0
);
INSERT INTO memories_new (<기존 23개 컬럼>, authority, source_kind)
SELECT <기존 23개 컬럼>, CASE WHEN promotion_source = 'auto' OR status = 'candidate' THEN 'auto' ELSE 'human' END, 'manual' FROM memories;
DROP TABLE memories; ALTER TABLE memories_new RENAME TO memories;
-- 인덱스: scope_glob, status, created_at, content_hash, activation_class(008 재생성), (status, authority) +
CREATE UNIQUE INDEX ux_memories_identity_live ON memories(identity_key) WHERE identity_key IS NOT NULL AND status IN ('candidate','active','stale');
CREATE UNIQUE INDEX ux_memories_semantic_live ON memories(semantic_key) WHERE semantic_key IS NOT NULL AND status IN ('candidate','active','stale');
UPDATE memories SET source_kind = 'import', source_ref = 'import:legacy', knowledge_kind = 'import'   -- install.ts 불릿
  WHERE type = 'policy' AND scope_glob = '**' AND activation_class = 'baseline';
UPDATE memories SET source_kind = 'legacy', needs_scope = 1                                           -- R2 피해자: 링크가 아니라 모양으로
  WHERE scope_glob IN ('**','**/*') AND lifecycle_triggers = '["before_model"]' AND activation_class <> 'baseline' AND status IN ('candidate','active');
PRAGMA foreign_keys = ON;
```

권한 규칙의 근거: LLM 생성 행(`llm-extract.ts:343-353`)과 `memory:add` 기본값은 같은 모양이라 출처를 가를 수 없으므로 *상태*로 가른다: `candidate`는 아무도 승인하지 않은 행이라 `auto`, 자동 승격이 아닌 `active`는 사람이 올린 행이라 `human`. 사람 후보가 `auto`로 분류돼도 `memory:promote`로 되돌릴 수 있지만, 기계 행을 `human`으로 봉인하면 복구가 어렵다. `post-migrate.ts`(같은 writer 세션): (1) `semantic_key` 백필 — 살아 있는 행끼리 충돌하면 가장 오래된 행만 키를 받고 나머지는 `merge` 제안; (2) DreamWorker 템플릿 후보 거부 — 술어는 `status='candidate' AND id IN (SELECT memory_id FROM legacy_dream_memory_evidence_links)`(DreamWorker 후보만 005의 링크를 가진다), 실행은 `transitionMemory(actor='migration')`. `normalize(summary)` = NFKC → 소문자 → 공백 축약 → 따옴표/백틱 제거 → 끝 구두점 제거.

### 4.2 `018_episodes_runs.sql`

```sql
CREATE TABLE episodes (
  id PK,                                   -- §3.4, 세그먼트 포함
  host! CHECK IN ('claude-code','codex','opencode','import'), session_id!, turn_key!, segment INT0, started_at!, closed_at!,
  close_reason! CHECK IN ('stop','precompact','session_end','idle','interrupted','import'),
  ledger_ref!,                             -- 'ledger/<file>#<byte_start>-<byte_end>' | 'import:<path>'
  correction_for, context_ref,             -- 교정이 가리키는 직전 에피소드; 그 턴의 마지막 ≤12 툴 라인(맥락 전용)
  scope_refs_json! '[]', tools_json! '[]', failure_signatures_json! '[]', flags_json! '{}', fired_json! '[]',
  evidence_weight REAL0, event_count INT0,
  status! CHECK IN ('queued','leased','extracted','skipped','failed','dead'), skip_reason, lease_until, attempt_count INT0, next_attempt_at, last_error, extraction_run_id
);  -- 인덱스: (status, next_attempt_at), (host, session_id, closed_at)
CREATE TABLE extraction_runs (
  id PK,                                   -- createDeterministicId('run:' + episode_id + ':' + extractor_version)
  episode_id! →episodes(id), provider! CHECK IN ('claude','codex','opencode','replay'), model, extractor_version!, prompt_sha256!,
  input_chars INT!, started_at!, finished_at, duration_ms INT,
  status! CHECK IN ('started','ok','invalid_output','suspect','timeout','provider_error','no_provider','nested_refusal'),
  facts_total INT0, facts_accepted INT0, raw_output_ref, error, outcomes_json! '[]'   -- fact별 {ordinal, action, outcome, memory_id?, proposal_id?, rejection?, relabel?}
);
CREATE TABLE write_ops (id PK, kind!, generation INT!, applied_at!);   -- id = run id | 'decision:<proposal_id>:<decided_at>' | 'import:<file_sha256>' | 'dream:<started_at ISO>'
CREATE TABLE meta (key PK, value!);        -- db_generation, extractor_version, semantic_key_backfill, last_dream_at, last_probe_at, last_probe_result, installed_version
```

run id에서 `prompt_sha256`을 뺀 이유: 프롬프트는 기존 메모리 ≤ 40건을 포함하므로 재시도 사이에 DB가 바뀌면 해시가 바뀌어 `raw/` 캐시가 빗나가고 LLM을 다시 지불한다; `dream:<started_at>`은 날짜 키가 하루 두 번째 consolidate를 무시하던 결함의 수정이다.

### 4.3 `019_proposals_provenance.sql`

```sql
CREATE TABLE proposals (
  id PK,                                   -- randomUUID(): 결정적 id는 reject/expire 뒤 재제안과 PK 충돌
  kind! CHECK IN ('supersede','stale','activate_policy','activate_global','fix_scope','fix_signature','revalidate','merge'),
  target_memory_id! →memories(id), candidate_memory_id →memories(id), rationale!, confidence REAL!,
  created_by! CHECK IN ('extractor','consolidator','migration','import'),
  support_count INT0, support_sessions INT0,            -- 파생: proposal_support
  status! 'open' CHECK IN ('open','accepted','rejected','expired'),
  created_at!, expires_at!, decided_at, decided_by CHECK IN ('human','auto_rule','expiry'), decision_note
);
CREATE UNIQUE INDEX ux_proposals_open ON proposals(kind, target_memory_id, COALESCE(candidate_memory_id, '')) WHERE status = 'open';
CREATE TABLE proposal_support (
  proposal_id! →proposals(id), episode_id!, session_id!, extraction_run_id, confidence REAL!, created_at!,
  has_human_signal INT0, deterministic INT0,   -- 에피소드 flags.correction ∨ remember; 시그니처 명령이 같은 턴에서 tool_ok·실패 없음
  PRIMARY KEY (proposal_id, episode_id)
);
CREATE TABLE memory_provenance (
  memory_id! →memories(id), episode_id!, event_seq INT!, relation! CHECK IN ('origin','reinforce','contradict','import'),
  confidence REAL!,                        -- fact.confidence: 파생 confidence의 유일한 소스
  excerpt! '' CHECK(length(excerpt) <= 500), extraction_run_id, created_at!, PRIMARY KEY (memory_id, episode_id, event_seq, relation)
);  -- 인덱스: (episode_id)
CREATE TABLE memory_transitions (
  id PK, memory_id! →memories(id), from_status!, to_status!, actor! CHECK IN ('human','auto_rule','expiry','import','migration'),
  proposal_id, extraction_run_id, reason!, created_at!
);  -- 인덱스: (memory_id, created_at)
INSERT INTO proposals (id, kind, target_memory_id, rationale, confidence, created_by, status, created_at, expires_at)
SELECT lower(hex(randomblob(16))), 'fix_scope', id, 'v0.5 stored scope **/* and trigger before_model only; set scope, trigger and signature',
  0.5, 'migration', 'open', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 days')
FROM memories WHERE needs_scope = 1;
```

017 픽스처에는 `llm-extract.ts:343-353` 모양의 행이 들어 있고 019 뒤 `fix_scope` 제안 ≥ 1건을 단언한다(링크 존재를 술어로 쓰면 LLM 생성 행에는 링크가 없어 공집합을 고른다).

### 4.4 `020_policy_rules_v2.sql`

```sql
ALTER TABLE policy_rules ADD COLUMN tool_pattern! '*';  ADD COLUMN target_kind! 'any' CHECK IN ('command','path','url','any');
ADD COLUMN pattern_kind CHECK IN ('cmd','glob','regex','substring');  ADD COLUMN arg_pattern;
ADD COLUMN enforcement! 'advise' CHECK IN ('advise','confirm','soft_deny','deny');  ADD COLUMN derived_at;   -- NULL = 수동 규칙
```

### 4.5 `021_legacy_archive.sql`

```sql
ALTER TABLE dream_evidence_events RENAME TO legacy_dream_evidence_events;
ALTER TABLE dream_runs RENAME TO legacy_dream_runs;
ALTER TABLE dream_memory_evidence_links RENAME TO legacy_dream_memory_evidence_links;
UPDATE legacy_dream_evidence_events SET status = 'discarded', discarded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE status IN ('pending','retained','grouped','latent');
DROP TABLE IF EXISTS topic_summaries;                   -- 한 번도 채워지지 않음; summary-repository.ts의 메서드 3개도 삭제
```

레거시 배치는 재추출하지 않는다: 툴 집합과 scope 참조가 빈 에피소드는 V3·V4를 통과하는 fact가 없고 업그레이드 당일 최대 40회 LLM 호출을 쓴다. `legacy_*`는 `memory:history`가 `dream/legacy-reader.ts`로 한 릴리스 읽고 0.7에서 삭제한다; `evidence` 테이블은 `manual_note`용으로 남는다.

### 4.6 트리거 시그니처 (`memories.trigger_signature_json`)

```json
{ "tool": "bash", "target": "command", "pattern_kind": "cmd", "pattern": "pm test", "negate": false }
```

`tool`은 정규 어휘 glob(`bash`, `edit|write`, `mcp:github/*`, `*`), `target ∈ {command, path, url, any}`, `pattern_kind ∈ {cmd, glob, regex, substring}`. `cmd` 매칭은 `signature.ts`의 **정규형** 위에서 저장·매칭 양쪽이 같은 함수를 쓴다: 명령을 따옴표를 존중해 `&&`, `||`, `;`, `|`로 나누고(`shell_dialect='powershell'`이면 백틱 이스케이프와 `&` 호출 연산자 처리), 환경 대입과 진짜 래퍼(`sudo`, `time`, `env`, `nice`)만 벗긴 뒤 패키지 매니저 호출을 접는다: `npm|pnpm|yarn|bun [run] <script>` → `pm <script>`, `npx|pnpm dlx|bunx <bin>` → `bin <bin>`(`pnpm`을 래퍼로 벗기는 방식은 `pnpm test`와 `npm test`를 어긋나게 한다). 패턴의 첫 토큰이 프로그램과 같고 나머지 토큰이 모두 포함되면 일치. `glob`은 minimatch 의미(regex 사전 컴파일), `regex`는 V5 통과분만, `substring`은 대소문자 무시. `signature_key`는 정규형의 직렬화; 메모리당 최대 1개. **V10 구체성**: `cmd`는 토큰 ≥ 2(단독 `npm`·`git` 거부), `substring` ≥ 8자, `glob`은 `*`·`**`·`**/*`가 아니고 경로 조각 포함, `regex`는 빈 문자열에 불일치; 실패하면 시그니처를 버리고 scope-only로 강등(§5.6).

### 4.7 상태 머신

`memories.status`의 모든 전이는 `transitionMemory(db, {memoryId, to, actor, proposalId?, reason})` 하나가 수행한다:

```
candidate ─(human promote | auto_rule: decideTier 통과, 6단계 2-support 수락의 대체 행 | human: proposals:accept)─▶ active
candidate ─(human reject | expiry 45 d, auto 행만 | migration: post-migrate 템플릿 후보)─▶ rejected
active    ─(human: demote 또는 stale 제안 수락 | import: --sync 삭제 불릿 | expiry: TTL 또는 revalidate 제안 만료, auto만 | auto_rule: 2-support, auto만)─▶ stale
candidate|active|stale ─(human: supersede·merge 제안 수락 | import: 확인된 import, 대체 행 human | auto_rule: 2-support, active·auto만)─▶ superseded (대체 행 active)
stale     ─(human promote | auto_rule: reinforce, auto만 ∧ status_reason='ttl_expired')─▶ active
superseded─(human restore)───────────────────────────────────────────────────────▶ active
```

불변식: `actor ∈ {auto_rule, expiry}`가 `authority='human'` 행에 어떤 전이를 시도해도 `AuthorityViolationError`를 던지고 아무것도 쓰지 않는다 — 상태를 불문하고 엄격하다. R1이 재발하지 않는 이유는 §4.1의 규칙(추출·MEMORY.md·마이그레이션 후보는 `auto`로 삽입)이 사람 후보를 예외로 만들기 때문이다: `memory:add`의 사람 후보는 만료되지 않고 `review`에 남는다. 모든 전이는 `memory_transitions` 행을 남긴다. `MemoryRepository.update()`는 `input.status !== undefined`면 throw하고, `rejectMemory`, `mergeMemories`, `supersedeMemory`, `markMemoryStale`와 CLI `memory:promote|demote|restore`는 `transitionMemory`를 호출하도록 재배선한다. 불변식 테스트: `transitions.ts`, `migrations/`, `db/repositories/`, `test/`를 제외한 `src/**/*.ts`에서 정규식 `UPDATE\s+memories\s+SET[^;]*\bstatus\s*=|\.update\([^)]*\bstatus\s*:`가 0건(episodes·runs·proposals의 status는 `db/repositories/`가 직접 쓴다). `episodes.status`: `queued → leased → extracted | skipped | failed`; `leased → queued`(lease 만료); `failed → queued`(1 h/6 h/24 h, 3회) `→ dead`. `proposals.status`: `open → accepted | rejected | expired`(`expires_at` 기준: 기본 30 d, 마이그레이션 `fix_scope`는 90 d).

### 4.8 스냅샷 파일

`snapshot/active.v1.json`: `{schema, built_at, db_generation, user_version, last_dream_at, last_probe: {at, result}, source: {mtime_ms, size}, memories, rules, failure_index: {<failure_class>: [memory_id]}, counts: {candidates, open_proposals, auto_active, expiring_7d, unreachable}}`(훅은 SQLite를 열지 않으므로 dream 주기·마이그레이션 필요 여부도 여기서 읽는다). 메모리 항목은 엔진이 읽는 모든 컬럼(임베딩 제외, `details` 600자) 더하기 `scope_regex`, `signature`(regex 소스·정규형 토큰), `authority`, `enforcement`, `knowledge_kind`, `source_file`. `failure_index`는 `failure_classes_json`에서 만든다. 300 메모리에서 운영 추정 ≈ 170 KB(§6.3의 실측 픽스처는 282 KB), 파싱 1–2 ms. 빌더는 V11을 위반하는 active 행을 스냅샷에서 제외하고 `counts.unreachable`에 세며, `doctor`가 나열하고 worker가 `fix_signature` 제안을 연다(데이터 한 건이 읽기 경로를 멈추지 않는다); **도달 불가 0건** 불변식은 §13.4의 픽스처 테스트에서만 단언한다. `buckets`는 0.7.

---

## 5. 쓰기 경로 (에피소드 → 추출 → reconcile → 활성화)

### 5.1 캡처 (훅, DB 없음)

ledger 라인(모두 `{ts, seq, turn_key, agent_id}` 포함, ≤ 32 KB, `appendFileSync` 1회):

| kind | writer | 주요 필드 |
|---|---|---|
| `prompt` | `prompt` | `text`(≤4,000), `correction`, `remember` |
| `fired` | `pre-tool` | `memory_ids[]`, `rule_codes[]`, `tool`, `target_digest`(≤120), `delivery ∈ {before, before_downgraded, with_result, none}`, `decision`, `enforcement` |
| `tool_ok` | `post-tool` | `tool_use_id`, `tool`(정규), `host_tool`, `shell_dialect`, `input_digest`(≤500), `scope_refs[]`, `output_head`(≤2,000)·`output_tail`(≤1,000), `resolution_of` |
| `tool_fail` | `post-tool-failure` / Codex는 `post-tool` 유도 | `tool_ok` + `error`(≤1,500), `is_interrupt`, `exit_code`, `failure_sig` |
| `assistant`, `marker` | `stop`; `precompact`, `session-end`, `stop-failure` | `last_assistant_message`(≤2,000); `kind` |

자격 증명 패턴은 기록 전에 `<redacted>`. **실패 시그니처**는 문서화된 모양에서만: Claude Code `PostToolUseFailure.error`의 첫 줄 `Exit code N`과 `is_interrupt`; 나머지 문자열은 표시용이라 클래스 표(`enoent … exit_<n>, other`)를 최선 노력으로만 적용한다. Codex는 exit code 필드가 없어 M9 픽스처 코퍼스가 유도 규칙을 정한다. `failure_sig = <tool>|<class>|<scope_ref | 정규형 프로그램 토큰>`(명령에 경로가 없으면 §4.6 정규형의 첫 토큰, `pm`·`bin`이면 두 토큰: `pm test`, `bin vitest`). **교정 감지**(`prompt` 훅): 직전 턴의 마지막 `tool_*` 라인이 `tool_fail`이거나("직전 비마커 라인"을 보면 Stop이 남긴 `assistant` 라인에 막혀 실패를 놓친다) 교정 어휘(`don't|never|instead|wrong|revert|아니|하지 ?마|말고|대신|틀렸|되돌려` 등)에 맞으면 `correction=1`. **remember**: `remember|from now on|기억|앞으로|절대`는 어디서나, `always|항상`은 문장 첫머리거나 다른 단서와 짝일 때만. **해결 감지**(`post-tool` 훅): ledger 꼬리(≤256 KB)에서 같은 `(tool, scope_ref | 정규형 프로그램 토큰)`의 `tool_fail`이 뒤따르는 `tool_ok` 없이 남아 있으면 `resolution_of`(경로 없는 `npm test` 실패를 `ls` 성공이 해결한 것으로 세지 않는다); 상태 파일을 쓰지 않아 병렬 훅 경합이 없다. 정규식은 시그니처와 플래그만 뽑는다(R6).

### 5.2 턴 경계와 에피소드 닫기

`prompt` 훅의 순서는 고정이다: (1) `offset = statSync(ledger).size`를 **append 전에** 읽는다(append 뒤에 잡으면 프롬프트 라인이 모든 에피소드 밖으로 밀려난다); (2) `state.turn_key`가 열려 있고 닫힘 기록이 없으면 그 턴을 `close_reason='interrupted'`로 닫아 큐에 넣는다(Claude Code는 인터럽트에 Stop을 실행하지 않는다); (3) `prompt` 라인 append; (4) `state = {turn_key, turn_start_offset: offset, segment: 0, correction_for: correction ? prevEpisodeId : undefined}` tmp+rename. 단위 테스트: 교정 프롬프트 한 줄만 있는 턴의 디스크립터는 `flags.correction=1`, `evidence_weight=2`.

`stop`/`precompact` 훅은 `[turn_start_offset, EOF)`(≤4 MB)를 읽어 scope·툴 집합, 실패 시그니처(해결 포인터), 플래그, `evidence_weight`, `fired_json`(발화 목록 `{memory_id, enforcement, outcome: override|heed|none}`; outcome은 §9.3 B의 정의로 여기서 계산)을 계산하고 `queue/<episode_id>.json`을 쓴 뒤 `state.turn_start_offset = EOF`, `state.segment += 1`로 전진시키고 worker를 스폰한다. `stop_hook_active=true`여도 같은 일을 한다(여기서 조기 종료하면 다른 Stop 훅을 쓰는 사용자의 모든 턴이 침묵한다). 순서는 `assistant`/`marker` 라인을 먼저 append한 뒤 EOF를 읽는다; "닫힘 기록 없음"은 `state.turn_start_offset < statSync(ledger).size`로 판정한다. `correction_for`가 있는 에피소드는 `context_ref`로 직전 에피소드의 마지막 ≤12 툴 라인을 실어 추출기가 실패와 교정을 함께 본다. `session-end`는 1.5 s(Claude Code)/1 s(Codex) 안에서 큐 파일과 `worker dream` 스폰만 한다. Stop·PreCompact·StopFailure에는 stdout을 쓰지 않는다.

### 5.3 적격성과 비용 상한

LLM 추출 자격: `evidence_weight ≥ 1` 또는 `last_assistant_message`의 결정 마커(`decided|we'll use|switch to|from now on|결정|이제부터|전환`); 읽기 전용 턴은 `skipped(no_signal)`. `extraction.maxRunsPerDay`(기본 40)는 교정 에피소드에는 적용하지 않는다; 그 외 게이트는 없다(R3). auto 활성화 캡: 에피소드당 3건, 하루 10건(`extraction.maxAutoActivationsPerDay`), 초과분은 `candidate(cap)`.

### 5.4 추출 worker

`worker extract`는 §9.3의 두 짧은 lock 세션 사이에서 provider를 호출한다. 프롬프트(`extract/prompt.ts`): 에피소드 헤더(host, 플래그, 툴·파일 집합), `context_ref` 라인("이전 턴, 인용 불가"), 모든 라인을 `e<seq>`로 번호 매겨 렌더(실패·해결 라인 전문, 나머지 한 줄), 마지막 assistant 메시지, scope가 교차하는 기존 메모리 ≤ 40건(`[M:<id>] [type] [status/authority] scope sig summary`), 정규 툴 어휘, 타입 정의와 경계 규칙(§5.5), 표현 정규화 지시(명령형으로; 스캐너가 "from now on … always"를 주입으로 차단한다). 하드 캡 24,000자.

`ExtractionProvider { name; probe(): 'ok'|'missing'|'nested_refusal'|'probe_timeout' (실제 1턴 호출, 20 s, 하루 1회 + install); extract(prompt, schema, {timeoutMs}) → {raw, model?} }`:

- `claude`: `claude -p --output-format json --json-schema <schema> --tools "" --disallowedTools "mcp__*" --strict-mcp-config --max-turns 1 --no-session-persistence --settings '{"disableAllHooks":true}' --model <cfg>`; 프롬프트는 stdin, cwd `~/.harness-memory/worker/<repo_hash>/`, env `providerEnv()`. `structured_output` 필드가 **없으면** `invalid_output`. `probe()`는 `extract()`와 같은 플래그에 1필드 스키마를 붙여 실제로 실행해(`--tools ""`와 `--json-schema`의 공존 문제가 설치 시점에 `invalid_output`으로 드러나게; §15.2) `CLAUDECODE` 상속 거부를 `nested_refusal`, 20 s 초과를 `probe_timeout`으로 구분 보고한다(둘을 `timeout` 하나로 뭉치면 `doctor`가 원인을 말할 수 없다). `--bare`는 쓰지 않는다(OAuth를 읽지 않는다); auto memory 끄기 키는 M0에서 확인.
- `codex`: `codex exec - --output-schema <file> --ephemeral --sandbox read-only --skip-git-repo-check --json -c features.hooks=false`; 같은 cwd·env. `opencode`: SDK, `tools: {}`. `replay`: 기록 응답.

재귀 가드: (1) 훅 진입점은 `HARNESS_MEMORY_DISABLE === '1'`이면 스냅샷을 열기 전에 exit 0; (2) worker가 `locks/worker.pid`를 쓰고 훅은 `process.ppid` 체인이 그 pid에 닿으면 exit 0; (3) `disableAllHooks`와 저장소 밖 cwd. 벽시계 캡 120 s → 자식 트리 kill → `timeout`.

### 5.5 추출 JSON 스키마 (verbatim, `--json-schema`/`--output-schema`에 그대로 전달)

```json
{"type":"object","required":["episode_summary","nothing_to_learn","facts"],"additionalProperties":false,
 "properties":{"episode_summary":{"type":"string","maxLength":400},"nothing_to_learn":{"type":"boolean"},
  "facts":{"type":"array","maxItems":8,"items":{"type":"object","additionalProperties":false,
   "required":["action","target_memory_id","type","summary","details","scope_glob","relevant_tools","trigger_signature",
               "lifecycle_triggers","confidence","evidence_refs","knowledge_kind","rationale"],
   "properties":{
    "action":{"enum":["create","reinforce","propose_supersede","propose_stale"]},
    "target_memory_id":{"type":["string","null"]},
    "type":{"enum":["policy","workflow","pitfall","architecture_constraint","decision"]},
    "summary":{"type":"string","minLength":12,"maxLength":160},
    "details":{"type":"string","maxLength":1200},
    "scope_glob":{"type":"string","minLength":1,"maxLength":200},
    "relevant_tools":{"type":"array","maxItems":6,"items":{"enum":["bash","edit","write","read","grep","glob","fetch","task","mcp","other"]}},
    "trigger_signature":{"type":["object","null"],"additionalProperties":false,"required":["tool","target","pattern_kind","pattern"],
      "properties":{"tool":{"type":"string","maxLength":60},"target":{"enum":["command","path","url","any"]},
        "pattern_kind":{"enum":["cmd","glob","regex","substring"]},"pattern":{"type":"string","minLength":1,"maxLength":200},"negate":{"type":"boolean"}}},
    "lifecycle_triggers":{"type":"array","minItems":1,"maxItems":4,"items":{"enum":["session_start","before_model","before_tool","after_tool"]}},
    "confidence":{"type":"number","minimum":0,"maximum":1},
    "evidence_refs":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"string","pattern":"^e[0-9]{1,4}$"}},
    "knowledge_kind":{"enum":["correction","failure_resolution","convention","decision"]},
    "rationale":{"type":"string","maxLength":300}}}}}}
```

`observation`은 어휘에서 뺐다. 프롬프트 규칙: 미래 턴의 행동을 바꾸는 지식만; 인용 없는 fact 없음; **경계 규칙** — pitfall은 실패·교정에서 배운 시그니처 있는 행동→결과 쌍, policy는 툴을 가로지르거나 시그니처 없는 상시 규칙; 툴 직전에 떠올라야 하는 지식은 `trigger_signature`와 `before_tool`을 가짐; 시그니처 없는 `before_tool`은 policy/pitfall에만; 가장 좁은 참 scope이되 명령 시그니처는 자체 정밀도를 가지므로 패턴에 경로가 없으면 `**/*`; 같은 말이면 `reinforce`, 틀렸으면 `propose_*`(편집·삭제 불가); `confidence = P(참 ∧ 지속 ∧ 올바른 scope)`, 0.6 미만 생략.

### 5.6 검증 (`extract/validate.ts`, fact별 거부 코드)

V1 스키마(소형 검증기); V2 `evidence_refs`가 이 에피소드의 `e<seq>`로 해석됨(`context_ref` 라인 불가); V3 scope: **시그니처가 있으면 유효한 저장소 내 glob이면 통과**, 없으면 에피소드 `scope_refs`와 교차해야 하고 시그니처 없는 `**/*`는 `decision`/`architecture_constraint`만; V4 시그니처 `tool`이 에피소드 툴 집합에 있음 — **`host='import'` 에피소드는 툴 집합을 정규 어휘 전체로 두고 V3 교차를 건너뛰되 패턴이 불릿 텍스트에 그대로 인용돼야 한다**(import 에피소드의 툴 집합을 비워 두면 V4가 시그니처 규칙을 전부 거부한다); **`correction_for`가 있으면 V3·V4의 교차 집합은 에피소드 자신 ∪ `correction_for` 에피소드의 `scope_refs`·툴 집합**이다(합집합이 비어 있지 않으면 이 규칙만, 인용 요건 없음); 합집합도 비는 툴 없는 교정·remember 에피소드(`tools_json='[]'`)에는 import 규칙을 적용하되 V3 교차는 import처럼 생략하고 인용 비교는 패턴과 `prompt` 텍스트를 §4.6 정규형으로 바꾼 뒤 한다(`pnpm test` ↔ `pm test`)(가장 무거운 신호가 구조적으로 거부되지 않도록); V5 regex 컴파일·중첩 수량자·4 KB 샘플 예산(2 ms, 또는 같은 프로세스에서 잰 선형 스캔의 500배); V6 `scanMemoryContent(..., {source:'extraction'})` + `self-reference`; V7 `reinforce`/`propose_*`의 실재 target(없으면 `create` 강등 / `rejected_no_target`); V8 프롬프트 재진술 아님; V9 배치 내 `semantic_key` 중복 접기; **V10 구체성**(§4.6; 실패 시 시그니처 제거 후 재검증, before_tool 전용이었으면 `trigger_unreachable`); **V11 도달 가능성**: 시그니처 없는 `before_tool`이 policy/pitfall 외 타입에 붙었거나 시그니처 툴이 훅으로 오지 않으면(`read`, `grep`, `glob`, `task`, `other`) `before_model`로 바꾸고 `relabel=tool_not_hooked`. 브레이커: 비 JSON, fact > 8, 환각 ref > 50 %만 run `suspect`(원본 7일, `skipped(suspect_run)`); 그 외 거부는 따로 세고 **통과한 fact는 적용한다**.

### 5.7 reconcile (`reconcile.ts`, 결정적, lock 세션 2의 한 트랜잭션, fact별 SAVEPOINT)

1. `write_ops`에 `run_id`가 있으면 no-op을 반환하되 에피소드가 아직 `extracted`가 아닐 때만 그 표시를 쓴다(run 멱등; §9.2는 no-op에 derive·generation·write_ops를 건너뛰고 쓰기가 없으면 저장도 생략한다).
2. 정규화: 슬래시·`./` 제거, 저장소 밖 glob 거부, `relevant_tools` 정규 어휘; **명령 시그니처 규칙**: `target='command'`이고 패턴에 경로 토큰이 없으면 `scope_glob='**/*'`, `activation_class='event'`; 트리거 보정(시그니처 있는 pitfall/policy는 `before_tool` 포함, decision/architecture_constraint는 `session_start`·`before_model`, 그 외 시그니처 없는 `before_tool`은 `before_model`로); **타입 경계 보정**: `knowledge_kind ∈ {correction, failure_resolution}`이고 시그니처가 있는데 `type='policy'`면 `pitfall`로 relabel(`outcomes_json.relabel`); `semantic_key`; `failure_classes_json` = 인용된 `tool_fail` 라인의 클래스 집합(`correction_for`가 있으면 그 에피소드의 `tool_fail` 클래스도 합친다: 인용이 아니라 결정적 메타데이터).
3. 대상 해석: `t = target_memory_id`의 행(terminal이면 `superseded_by` 체인을 따라); `m = semantic_key가 같은 살아 있는 행`; 둘 다 없고 `create`면 이웃 탐색(같은 타입, scope 교차, Jaccard ≥ 0.6 또는 코사인 ≥ 0.85); 이웃이 있으면 `m = 이웃`으로 두어 4단계가 `reinforce(m)`한다(이웃이 human 행이면 카운터만 오르고 confidence는 동결); 단 이웃에 시그니처가 없고 새 fact가 V10을 통과한 시그니처를 가지면 흡수하지 않고 `create`한다(시그니처 있는 쪽이 더 구체적이다).
4. `create`: `m`이 있으면 `reinforce(m)`. 없으면 `MemoryRepository.create({..., authority: 'auto', status: 'candidate', source_kind: 'extraction', source_ref: 'episode:<id>', knowledge_kind, importance: 타입 기본, enforcement: enforcementDefault(§7.3), reviveTerminal: true})`. `findExactDuplicate`/`getByIdentityKey`는 `status IN ('candidate','active','stale')`로 좁히고, 살아 있는 쌍둥이면 reinforce, `rejected` 30일 이내면 `skipped_recent_reject`, terminal뿐이면 `id = createMemoryId(identity_key + ':' + generation)`으로 새 행(status를 무시하는 조회와 결정적 id의 조합은 identity 충돌에서 두 번 throw한다). `memory_provenance(origin, confidence=fact.confidence)`를 `evidence_refs`마다 삽입한 **직후, 같은 SAVEPOINT 안에서** `recomputeDerived(memoryId)`로 `evidence_count`(= `relation IN ('origin','reinforce','import')`인 provenance의 COUNT(DISTINCT episode_id); `contradict`는 세지 않는다), `evidence_score`(= 그 에피소드들의 `evidence_weight` 합), `distinct_session_count`, auto 행의 `confidence = min(0.99, max(provenance.confidence) + 0.05·(evidence_count−1))`를 채운다(커밋 끝에 재계산하면 7단계가 0을 읽어 첫 교정이 활성화되지 않는다).
5. `reinforce(target = t ?? m)`: `memory_provenance(reinforce)`; `recomputeDerived`; `last_verified_at = closed_at`; 대상이 `auto`·`active`면 재작성된 `revalidateMemory`(`ttlDays(v) = min(90, 7·2^v)`, `validation_count = evidence_count − 1`, `ttl_expires_at = max(기존 값, now + max(ttlDays(v), baseTtlDays(knowledge_kind)))`로 강화가 TTL을 줄이지 않게 한다; 현 구현은 `promotionSource`를 봐 재사용 시 D4 재발); `stale(ttl_expired)`인 auto 행은 `stale→active`(auto_rule); 대상이 `auto`·`candidate`면 7단계의 `decideTier` 대상에 넣는다(강화된 후보가 영원히 후보로 남지 않도록); **human 행은 `last_verified_at`과 카운터만 바뀌고 `confidence`·`importance`는 동결**.
6. `propose_supersede` / `propose_stale(target)`: `supersede`면 대체 행을 4단계처럼 `candidate`로 삽입하고 `supersedes_memory_id`를 건다; 대체 행의 `semantic_key`가 대상과 같으면 `reinforce` + `stale` 제안으로 바꾼다. `memory_provenance(contradict)`. `openOrSupportProposal`: `ux_proposals_open`으로 열린 제안을 찾아 `proposal_support`를 upsert, 없으면 `randomUUID()`로 새 행(테스트: propose → expire → propose 성공); upsert 직후 같은 SAVEPOINT 안에서 `recomputeProposalDerived(proposalId)`(`support_count = COUNT(*)`, `support_sessions = COUNT(DISTINCT session_id)`)를 수행한 뒤 아래 규칙을 평가한다. **auto 대상 강등 규칙**: `type ≠ policy` ∧ `support_sessions ≥ 2` ∧ (대상의 origin이 correction/remember 에피소드면 지지 에피소드 중 하나가 `has_human_signal=1`이거나 `deterministic=1`) ∧ `target.status = 'active'` 일 때만 `decideProposal(accepted, auto_rule)` + `target → stale|superseded`(auto_rule) — 에이전트가 자기 메시지로 사람의 교정을 두 턴 만에 지우지 못한다. human 대상은 제안만 열고 `contested=1`, `open_proposal_id` 설정.
7. 4·5·6단계에서 생성되거나 강화된 `authority='auto'`·`status='candidate'` 행마다 `decideTier(memory, episode, evidenceScore)`(§7.4): 단 **`supersedes_memory_id`가 살아 있는 행을 가리키거나 자신이 열린 제안의 `candidate_memory_id`면 항상 `candidate`** — 대체 행은 제안 수락(human) 또는 6단계의 auto 규칙으로만 활성화된다(이 예외가 없으면 환각된 대체 행이 `soft_deny`로 사람 규칙 위에서 툴을 거부할 수 있다). §5.3 캡 적용; `shadow`면 `audit_log`에만.
8. `extraction_runs.outcomes_json`, `episodes.status='extracted'`, `session_summaries` upsert; reconcile은 `opId = run_id`를 돌려주고 `write_ops`·`db_generation`·`derivePolicyRules`(§10)·스냅샷은 §9.2 4–6단계가 한 번만 수행한다. 커밋 끝 재계산은 테스트의 `assertDerivedConsistent`로만 남는다.

### 5.8 consolidate (`worker dream`; `session-end`, 마지막 실행 6 h 경과 후 `stop`, `hm dream`)

메모리를 발명하지 않는다. (1) 자격 있는 `queued` 에피소드가 있으면 먼저 `extract` 루프(세션 마지막 턴의 교정이 다음 세션까지 기다리지 않도록); (2) TTL: `knowledge_kind ∈ {correction, failure_resolution}`인 auto 행은 `stale`로 보내지 않고 `revalidate` 제안을 연다(리뷰와 일일 `systemMessage`에 "만료 예정 N건"; 30일 뒤 제안이 만료되면 `stale(ttl_expired)`), 그 외 auto 행은 바로 `stale(ttl_expired)`; (3) auto `candidate` 45 d → `rejected(expiry)`, 제안 30 d → `expired`(`counts.expiring_7d`에 미리 보인다); (4) 발화 반영: 롤업은 하지 않고(§9.3 B가 유일한 소유자) 쌓인 `fire_count`/`last_fired_at`/`override_count`를 읽어 auto 행은 `ttl_expires_at = max(ttl_expires_at, last_fired_at + 14 d)`(발화는 "사용 중"의 결정적 신호); **override 강등**: `authority='auto'` 행에서 `override_count ≥ 3 ∧ evidence_score < 3`이면 `enforcement='advise'`로 내리고 `audit_log(enforcement_downgrade)`, human 행은 `review`에 noisy로만 표시; (5) auto↔auto 근중복(Jaccard ≥ 0.8 또는 코사인 ≥ 0.92)은 `merge` 제안만(수락 시 생존자 = 오래된 행, enforcement = max); (6) 임베딩 백필; (7) 열린 턴 스윕: `state/*.json` 중 ledger mtime이 1 h 이상 지난 열린 턴은 `close_reason='idle'`로 닫아 큐에 넣는다(호스트가 Stop 없이 죽은 경우; `session-start`도 같은 스윕을 한다); GC: ledger 세그먼트 14 d(excerpt ≤ 500자는 provenance에 남는다), `raw/` 24 h, `*.tmp-*` 10분, `audit_log` 30 d; (8) 스냅샷.

---

## 6. 읽기 경로 (4 트리거, before_tool 매칭 알고리즘, 예산, 지연 계획)

### 6.1 트리거 매핑

| 트리거 | 훅(Claude Code / Codex) | 모드·소스 | 예산 | 전달 |
|---|---|---|---|---|
| `session_start` | `SessionStart` | `startup` + **트리거 필터**; 스냅샷 + lexical | **5 / 3 KB** | `additionalContext` |
| `before_model` | `UserPromptSubmit` | `classifyQueryType(prompt)`; 스냅샷 + lexical(BM25 임계) | **5 / 3 KB** | `additionalContext` |
| `before_tool` | `PreToolUse` | `default` + 시그니처 단계; 스냅샷 | 3 / 2 KB | 사다리(§7.2) |
| `after_tool` | `PostToolUse(Failure)` / `PostToolUse` | `failure_index` 조회; 스냅샷 | 2 / 1 KB | `additionalContext`(실패 힌트) |

`session_start`는 `lifecycle_triggers`에 `session_start`가 있는 행만 대상이며(현 `activateStartupMode`는 트리거를 보지 않아 before_tool 전용 피트폴까지 매 시작에 덤프했다) 타입은 baseline/decision/architecture_constraint/workflow로 한정한다. **네이티브 중복 제거**: `source_file`이 호스트가 스스로 로드하는 파일(Claude Code `CLAUDE.md`, Codex `AGENTS.md`)이면 `session_start`/`before_model` 주입을 건너뛴다. `before_model`은 사용자 턴당 한 번; non-baseline 행은 프롬프트의 경로 토큰 또는 `lastScopeRef`와 scope가 교차하고 BM25 점수가 `before_model.minScore`를 넘어야 한다. dense 레그는 훅에서 끈다.

### 6.2 `before_tool` 알고리즘 (`hook.ts pre-tool`)

```
0–1 env 가드(HARNESS_MEMORY_DISABLE=1 또는 ppid 체인이 worker.pid → exit 0); stdin 전체 읽기(2 s, 1 MB) → JSON; 실패 → 'bad_stdin', exit 0
2  canonical = toolVocabulary(host, tool_name)(Bash·PowerShell→bash, dialect 기록); target = pickTarget(command | file_path | url | mcp JSON ≤2,000);
   scopeRefs = target의 경로형 토큰, 없으면 []
3  스냅샷 readFileSync + JSON.parse; statSync(memory.sqlite) ≠ snapshot.source → reindex 스폰하되 현재 스냅샷 사용; 없음/손상 → 빈 결과 + reindex 스폰
   (스폰 전 `snapshot/.reindex-requested`의 mtime이 60 s 이내면 스폰하지 않고, 아니면 touch 후 스폰: 병렬 훅의 스폰 폭주 방지)
4  state.turn_start_offset부터 ledger 꼬리(≤256 KB) → firedKeys {memory_id|tool}, lastScopeRef(마지막 tool_* 라인의 scope_refs[0])
5  후보: before_tool ∈ lifecycle_triggers인 스냅샷 메모리; 필터(순서 고정): status/TTL → trigger → relevant_tools(null 또는 canonical 포함; 'mcp'는 접두)
6  → 시그니처 있음: tool glob + pattern_kind 매처가 target(≤4 KB)에 일치(불일치 → 'signature_mismatch');
     scope는 scopeRefs가 비어 있지 않을 때만 검사(교차 또는 전역), 비어 있으면 통과하고 lastScopeRef 일치 시 +0.25
   → 시그니처 없음: type ∈ {policy, pitfall}만; scope는 사전 컴파일 regex × scopeRefs, 비면 전역만
7  PolicyEngine.evaluate({lifecycleTrigger:'before_tool', scopeRef, toolName: canonical, toolTarget: target}); firedKeys에 (memory|tool)이 있으면 제외(deny는 유지)
8  순위: enforcement(deny > confirm > soft_deny > advise) → 시그니처 일치 → authority=human → calculateMemoryScore → 쿼터 policy 2 / pitfall 2 / workflow 1 → 예산 3개 / 2,048 B
9  결정: 최고 enforcement를 §7.2로 매핑; permission_mode ∈ {bypassPermissions, dontAsk}면 confirm → soft_deny('before_downgraded');
   confirm은 (memory|tool)당 턴에 한 번만 ask(7단계의 제외 규칙): 대화형에서는 사람이 이미 답했고, `-p` 기본(Manual) 모드에서는 ask가 자동 거부되어 사유가 모델에 가므로 재시도가 soft_deny와 같게 동작한다(§15.2)
   soft_deny는 (memory|tool)이 firedKeys에 없을 때만 deny, 같은 턴의 재시도는 7단계에서 제외되어 그대로 통과
10 fired 라인 append(delivery: ask/deny→'before', 9단계 강등이면 'before_downgraded', additionalContext→'with_result', 없음→'none'); stdout JSON 1개; exit 0.
   어떤 예외든 hooks.log 한 줄, 출력 없음, exit 0(exit 2는 차단 + stderr를 모델에, 그 외 0이 아닌 코드는 사용자 가시 오류 — 결정은 JSON으로만)
```

6단계가 R2 변종을 닫는 지점이다: "scopeRefs가 비면 전역만"을 모든 메모리에 적용하면 좁은 scope의 명령 피트폴이 경로 없는 `Bash npm test`에서 영원히 `scope_mismatch`가 된다; 시그니처가 있는 메모리에서 scope와 시그니처는 보완적이지 결합적이지 않다. 재시도 키를 `(memory|tool)`로 넓힌 이유: 바이트 동일 재시도만 통과시키면 살짝 바뀐 명령이 다시 거부된다. `memory:why`는 같은 함수로 이유를 출력한다.

### 6.3 지연 예산

스냅샷 설계의 근거는 지연이 아니라 **동시성과 일관성**이다: 훅은 병렬로 뜨고 쓰면 안 되며, 원자 교체되는 읽기 모델 하나가 lock 없이 일관된 뷰를 준다. 실측(Windows 11, Node 24.14, 웜 캐시): `node -e 0` p50 33 ms; `pre-tool` 시뮬레이션(282 KB 스냅샷, 300 regex, 50 시그니처) p50 42.6 / p95 44.7 ms; sql.js init+open 약 9 ms(콜드 캐시에서는 +53–54 ms). 목표 p50 ≤ 70 / p95 ≤ 90 ms. `eval:latency`는 CI에서 `dist/hook.js pre-tool`을 300 메모리 픽스처로 50회 스폰해 min/p50/p95/max를 기록하고 p95 > 90 ms면 실패시킨다; 2,000 메모리와 콜드 스타트는 정보용.

### 6.4 엔진 변경(최소 diff)

`engine.ts:93`의 생성자 타입을 `MemoryReader = Pick<MemoryRepository, 'list' | 'getById' | 'listLineageConflicts'>`로 넓힌다. `prepareActivation`(187–194행)의 `LexicalIndex.rebuild`는 `queryText`가 있거나 모드가 `startup/temporal/cross_session`일 때만 수행하고 스냅샷 리더는 `MiniSearch.loadJSON`으로 대체한다. `mode-startup.ts:115-121`의 필터에 `memory.lifecycleTriggers.includes('session_start')`를 추가한다. `ActivationRequest`에 `toolTarget?`, `toolInput?`, `lastScopeRef?`를, `ActivationSuppressionKind`에 `signature_mismatch`를 더하고, `calculateMemoryScore`의 신뢰 배수를 `authority === 'human' ? 1 : (validation_count 0 → 0.65, 1 → 0.8, ≥2 → 0.95)`로 바꾼다(현재는 `promotionSource`).

### 6.5 피로 제어

트리거별 예산은 `config.json`; 같은 턴에서 같은 `(memory|tool)`은 한 번만; `fire_count ≥ 20 ∧ evidence_score < 3`은 `status`/`review`에 "noisy"; override 강등은 §5.8(4); auto 활성화 캡은 §5.3.

---

## 7. 권한 모델 (auto / human, 제안 큐)

### 7.1 두 축

`authority ∈ {human, auto}`: 누가 상태를 바꿀 수 있는가. `human`은 `memory:add`, `import`(사람이 쓴 파일이 출처; `--yes`면 `import_unconfirmed=1`로 `review`에 남는다), `memory:promote`, `proposals:accept`의 대체 행과 `activate_*` 수락 행, **어떤 사람 편집이든**(`memory:enforce`, scope 변경) 설정하며 TTL이 없고 신뢰 배수 1.0이다. `auto`는 추출·MEMORY.md·마이그레이션 후보의 출생값이고 TTL·2-support 강등·override 강등을 받는다. `enforcement ∈ {advise, confirm, soft_deny, deny}`: before_tool 전달 방식; `deny`는 사람만 설정하고 LLM은 enforcement를 올릴 수 없다.

### 7.2 전달 사다리

| enforcement | Claude Code | Codex | OpenCode V2 | 타이밍 |
|---|---|---|---|---|
| `advise` | `hookSpecificOutput.additionalContext` | `additionalContext`(`additionalContextLimit`) | 다음 `context` 훅 | with_result |
| `confirm` | `permissionDecision: "ask"` + 사유; `permission_mode ∈ {bypassPermissions, dontAsk}`면 `soft_deny`로 강등(`before_downgraded`) | **soft_deny로 강등**(`ask`는 훅 실패) | soft_deny로 강등 | before |
| `soft_deny` / `deny` | `"deny"` + 사유(soft는 턴 안의 첫 시도만, 같은 (memory\|tool) 재시도는 통과; deny는 매번) | 동일 | `ctx.permission.assert`의 deny 규칙(Tool.Error에 사유) | before |

`soft_deny`의 의미: 모델은 툴이 실행되기 전에 사유를 읽고, 해당 없다고 판단하면 같은 툴을 다시 호출하면 된다(호스트 중립, 별도 프로토콜 없음). 사유 ≤ 600자; `systemMessage` 한 줄(`harness-memory: <memory id> fired (<enforcement>)`)은 `confirm`·`soft_deny`·`deny`에만 붙이고 `advise`에는 붙이지 않는다. 비대화형 강등은 "기본 하드블록 없음"은 사람이 없는 모드에서도 지킨다: `bypassPermissions`/`dontAsk`는 강등(`fired.delivery='before_downgraded'`로 eval이 구분), `ask`가 자동 거부되는 `-p` 기본 모드는 강등 없이 ask 1회 + 7단계 제외로 같은 효과(delivery는 'before'; 훅이 감지할 수 없어 §15.2).

### 7.3 기본 enforcement (`enforcementDefault(memory)`, 사람이 언제든 덮어씀)

| 메모리 | authority | 기본 | 이유 |
|---|---|---|---|
| `policy` hard + 시그니처; **확인된** import 규칙 중 `never\|must not\|always\|do not\|절대\|반드시\|항상` + 시그니처 | human | `confirm` | 승인된 하드 규칙은 실행 전에 사람이 본다; 첫날부터 작동 |
| `policy` soft 또는 시그니처 없음; import `--yes`(`import_unconfirmed=1`)와 그 외 import | human | `advise` | scope-only 일치나 아무도 보지 않은 시그니처에 프롬프트를 걸지 않는다 |
| `auto` `pitfall`, 시그니처 있음, `knowledge_kind ∈ {correction, failure_resolution}`, V10 통과 | auto | `soft_deny` | 교정 또는 실패→해결 쌍과 구체적 시그니처가 있을 때만 실행 전 개입 |
| `auto` `pitfall` 그 외; `auto` `workflow`(상한 advise); `decision`, `architecture_constraint` | — | `advise` | scope-only·절차 제안·비 before_tool 타입은 거부 사유가 될 수 없다 |

`config.json`: `before_tool.auto_enforcement = soft_deny | advise`(기본 soft_deny), `before_tool.hard_policy = confirm | advise | deny`(기본 confirm).

### 7.4 자동 티어 (`decideTier(memory, episode, evidenceScore)`, 순수 함수)

| 조건 | 결과 |
|---|---|
| `type ∈ {pitfall, workflow}` ∧ scope 유효 ∧ (`trigger_signature` ∨ `relevant_tools`) ∧ 도달 가능한 트리거(V11) ∧ `confidence ≥ 0.7` ∧ `evidenceScore ≥ 2` ∧ 스캔 안전 ∧ 대체 행 아님(§5.7 7단계) ∧ 캡 미만 ∧ `autonomy_level='standard'` | `active`, `promotion_source='auto'`(호환), `validation_count = evidence_count − 1`, `ttl_expires_at = now + baseTtlDays(knowledge_kind)`(correction/failure_resolution 30 d, 그 외 7 d), `revalidate_after = now + ttl/2`, 신뢰 배수는 §6.4 표(첫 에피소드 활성화면 0.65) |
| `evidenceScore < 2` / 캡 초과 / `decision`·`architecture_constraint` | `candidate`(`cap` 표시), 다음 에피소드에서 재평가 / CLI 다이제스트 |
| `type = policy`(경계 보정 뒤에도) | `candidate` + `proposals(activate_policy)`; 같은 세션의 교정에서 왔으면 worker가 `state/<host>-<session_key>.notify.json`(tmp+rename)에 적고 다음 `prompt` 훅이 읽어 `systemMessage`로 알린 뒤 삭제 |
| 시그니처 없는 `**/*`(V3를 통과하는 `decision`·`architecture_constraint`; 그 외 타입의 전역 후보는 `import`와 툴 없는 교정·remember 에피소드만 만든다) | `candidate` + `proposals(activate_global)`(2행보다 우선) |

"충분한 증거"는 에피소드 수가 아니라 가중치 합이다: 교정 한 번 또는 실패→해결 쌍 하나면 즉시 활성화된다. 비용은 TTL, 신뢰 배수(§6.4, 첫 활성화 0.65), 강등에만 적용되는 2-support, V10, override 강등, 캡으로 묶인다. 교정 유래 행의 TTL이 7 d면 경고가 효과를 낸 경우에 강화 신호가 없어 잊히므로 30 d로 두고 발화로 연장하며(§5.8), 만료는 `revalidate` 제안을 거친다.

### 7.5 제안 큐

종류 8개: `supersede`, `stale`, `activate_policy`, `activate_global`, `fix_scope`(마이그레이션), `fix_signature`(human 행의 잘못된 import 시그니처 수정), `revalidate`(TTL), `merge`(사람 전용). 열린 제안은 (kind, target, candidate)당 하나이며 같은 주장은 `support_count`/`support_sessions`만 올린다. **`contested` 표시 규칙**: DB·CLI·`status`·`systemMessage`에는 첫 제안부터 보이지만, 모델 주입 텍스트에 `(contested, see hm review)`가 붙는 것은 `support_sessions ≥ 2`이고 `enforcement='advise'`인 human 행뿐이다; 그 외 human 행의 주입 텍스트는 제안과 무관하게 바이트 동일하다. `proposals:accept`는 lock 안에서 `transitionMemory(actor='human', proposalId)`를 수행하고 대체 행은 `authority='human'`을 상속하며, `activate_policy`·`activate_global` 수락은 그 행을 `memory:promote`처럼 `authority='human'`으로 바꾼다. `reject`는 같은 `semantic_key`의 재제안을 30일 건너뛴다.

### 7.6 `autonomy_level` (`config.json`, 기본 `standard`)

`off`: `decideTier`가 아무것도 올리지 않음. `shadow`: 결정을 `audit_log(auto_activation_shadow)`에만. `standard`: §7.4. shadow를 기본으로 출하하면 "교정 → 다음 턴 발화" 순간이 존재하지 않는다.

---

## 8. 호스트 어댑터 (Claude Code, Codex, OpenCode 매핑표, 훅 I/O, 설치 및 배포)

### 8.1 검증된 호스트 사실

- **Claude Code**: 훅 타임아웃 기본 600 s(UserPromptSubmit 30 s, SessionEnd 1.5 s); `-p` 종료 시 async 훅 kill; 일치 훅 병렬 실행; `PreToolUse`의 `additionalContext`는 툴 결과와 함께, `permissionDecision allow|deny|ask`만 실행 전; `systemMessage`는 사용자 전용; Stop은 인터럽트에 실행되지 않고 API 오류는 `StopFailure`; Stop 입력 `stop_hook_active`, `last_assistant_message`; PreCompact stdout은 압축 지시; exit 2는 차단 + stderr를 모델에, 그 외 0이 아닌 코드는 사용자 가시 오류; exec-form `{command, args}`는 최근 기능; **Git Bash 없는 Windows는 `PowerShell` 툴**, `PostToolUseFailure.error` 첫 줄 `Exit code N`; 훅 자식에 `CLAUDECODE=1`; `--disallowedTools "mcp__*"`, `--strict-mcp-config` 문서화; `--json-schema`는 유효 출력이 없으면 `structured_output` 부재; `--bare`는 OAuth를 읽지 않으며 "향후 `-p`의 기본"; `-p`는 cwd 상위 `CLAUDE.md`·auto memory·프로젝트 훅·`.mcp.json`을 로드; `settings.local.json`은 Claude Code가 직접 쓸 때만 gitignore; 훅 설정은 파일 감시로 반영.
- **Codex**: 이벤트 14종(PostToolUseFailure 없음); `permissionDecision allow|deny`만(`ask`는 훅 실패); 모델 가시 훅 출력 기본 **약 2,500 토큰**(`additionalContextLimit`); `systemMessage` 지원; Stop 입력에 `last_assistant_message`, `stop_hook_active`; `[features] hooks = false` 문서화; 셸 `tool_name="Bash"`, `tool_input.command`는 문자열; `apply_patch`는 `Edit|Write`; `tool_response`에 exit code 없음; `.codex/hooks.json`은 신뢰 계층만 로드, `/hooks` 해시 신뢰; `commandWindows`는 문자열 명령; SessionEnd 1 s; `turn_id`.
- **OpenCode**: `Plugin.define({id, setup(ctx)})`; `session.hook("prompt"|"context"|"compaction")`; `tool.hook("execute.before"|"execute.after")`; `ctx.storage`; 거부는 `ctx.permission.assert`(Tool.Error); V1 구현은 V2에서 실행되지 않고 V1 객체 진입점은 1.18.29 이상(V2의 idle 신호는 미확인, §15.2).

### 8.2 Claude Code 매핑

| 이벤트 | matcher | 명령 | stdout |
|---|---|---|---|
| `SessionStart` | 없음(모든 source) | `hook session-start` | `additionalContext`(session_start); `systemMessage` "N proposals, M expiring" 하루 1회; `node` ≥ 20 확인; 마이그레이션 필요/스냅샷 없음/큐 있음이면 worker 스폰; 열린 턴 스윕(§5.8) |
| `UserPromptSubmit` | — | `hook prompt` | `additionalContext`(before_model); interrupted 닫기; `prompt` 라인; state |
| `PreToolUse` | `Bash\|PowerShell\|Edit\|MultiEdit\|Write\|NotebookEdit\|WebFetch\|mcp__.*` | `hook pre-tool` | §7.2 사다리(ask/deny 시 `systemMessage`); `fired` 라인 |
| `PostToolUse` / `PostToolUseFailure` | `.*` | `hook post-tool` / `hook post-tool-failure` | `tool_ok` 라인 / `tool_fail` 라인 + `failure_index` 일치 시 `additionalContext` |
| `Stop` / `StopFailure` / `PreCompact` / `SessionEnd` | — / — / `manual\|auto` / — | `hook stop` 등 | 없음; 세그먼트 닫기·큐·worker / `marker`만(다음 `prompt`가 interrupted로 닫는다) / 세그먼트 닫기 / 큐 + `worker dream` |

timeout은 PreToolUse/PostToolUse 5, SessionEnd 1, 나머지 10. `SubagentStop`, `Notification`, `PermissionRequest`는 등록하지 않고 `PostToolUse`는 async가 아니다. `Read|Grep|Glob|Task`는 `PreToolUse`에 등록하지 않으며(가장 잦은 툴에 실행 전 50 ms 스폰을 얹지 않는다) 그 툴의 시그니처는 V11이 `before_model`로 내린다; `PostToolUse`는 scope_refs 수집과 해결 감지를 위해 모든 툴에 등록한다(툴 결과 뒤 ≈ 40 ms).

### 8.3 Codex 매핑

같은 명령을 쓰되: `SessionStart`는 `additionalContextLimit` 설정과 페이로드 ≤ 3 KB(§6.1; CJK는 bytes/3으로 토큰 추정); `UserPromptSubmit`은 `turn_id`가 턴 키(interrupted 닫기 동일); `PreToolUse`는 `Bash`→`bash`, `apply_patch`→`*** Add File:`면 `write` 아니면 `edit`(scopeRefs는 `*** Update File:` 경로), `mcp__s__t`→`mcp:s/t`, `confirm`은 항상 `soft_deny`, `ask` 절대 미출력, `additionalContext` ≤ 2 KB(§6.1); `PostToolUse`는 `tool_response` 문자열에서 실패 유도(M9 픽스처 코퍼스); `Interrupt`(timeout 1)는 `marker` 라인 + 세그먼트 닫기(`close_reason='interrupted'`)로 다음 `prompt`가 `correction_for`만 잇게 한다; `Stop`·`PreCompact`·`SessionEnd`·`Interrupt`는 출력 없음.

### 8.4 OpenCode V2 매핑

`before_model` + 턴 시작 + 교정 감지는 `ctx.session.hook("prompt")`; 주입(session_start, before_model, advise)은 `ctx.session.hook("context")`의 `event.system`; `before_tool`은 `ctx.tool.hook("execute.before")`에서 매칭하고 `soft_deny`/`deny`는 `ctx.permission.assert`(사유를 Tool.Error에), advise는 다음 `context` 훅; 캡처는 `ctx.tool.hook("execute.after")`(`event.status === 'error'`); 에피소드 닫기는 다음 `prompt` 훅 + `compaction` 훅(idle 신호가 M10에서 확인되면 추가); 압축은 `ctx.session.hook("compaction")` 마커; 세션 커서는 `ctx.storage`. V1 shim 하한 **OpenCode ≥ 1.18.29**(그 아래는 v0.5.x), V2 하한은 M10에서 확정; V1 shim은 한 릴리스. 플러그인은 DB를 들지 않고 스냅샷을 mtime으로 캐시하며 쓰기는 worker로 보낸다(D1).

### 8.5 정규 툴 어휘

`bash, edit, write, read, grep, glob, fetch, task, mcp:<server>/<tool>, other`. Claude Code: `Bash|PowerShell→bash`(`shell_dialect`로 구분; 메모리는 `bash` 하나만 저장해 다른 호스트에서 배운 피트폴이 PowerShell 설치에서도 발화), `Edit|MultiEdit|NotebookEdit→edit`, `WebFetch→fetch`, `WebSearch→other`, `Task|Agent→task`, `mcp__s__t→mcp:s/t`, 나머지는 소문자. Codex: §8.3. OpenCode: 소문자 그대로, `webfetch→fetch`. `relevant_tools`의 `mcp`는 접두 일치.

### 8.6 훅 I/O 계약과 예시

stdin 전체 읽기(2 s 가드, 1 MB 캡), stdout에 JSON 객체 정확히 하나, 로그는 파일로, exit는 항상 0. soft_deny 첫 시도의 출력은 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[harness-memory] PITFALL (auto, provisional): Run scripts/seed.js before the test script (learned 2026-11-08 from a correction). If this does not apply, call the tool again to proceed."},"systemMessage":"harness-memory: pitfall 3f9a fired (soft_deny)"}`; confirm은 `"ask"`, advise는 `additionalContext`만 싣는다.

### 8.7 설치와 배포

`harness-memory install --host claude|codex|opencode|all [--user] [--with-embeddings]`:

- **Claude Code**: 대상 `.claude/settings.local.json`(`--user`면 `~/.claude/settings.json`). `claude --version`이 M0에서 확정한 exec-form 최소 버전 이상이면 `{"type":"command","command":"<process.execPath>","args":["<abs>/dist/hook.js","pre-tool"],"timeout":5}`, 아니면 shell-form `"\"<node>\" \"<abs>/dist/hook.js\" pre-tool"`(Git Bash가 없으면 `"shell":"powershell"`) — `args`를 모르는 버전은 Node가 stdin JSON을 프로그램으로 읽어 매 호출마다 훅 오류를 낸다. `process.execPath`를 기록해 PATH·nvm·volta 이동과 npm `.cmd` shim을 피하고 `doctor --fix`가 이동을 고친다. `settings.local.json`을 `.git/info/exclude`에 추가한다; 재시작은 필요 없다. 설치 성공 출력 전에 `doctor`가 등록된 각 명령을 합성 stdin으로 1회 자가 실행(self-test)해 `hooks.log`에 해당 이벤트 줄이 남는지 확인한다; 호스트의 실제 호출 여부는 §9.4의 "이벤트별 마지막 호출" 검사가 다음 세션부터 보고한다.
- **플러그인 배포**(`.claude-plugin/plugin.json`, `hooks/hooks.json`의 `"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/dist/hook.js","pre-tool"]`, `commands/*.md`, `bin/hm`): 마켓플레이스 설치는 `npm install`을 돌리지 않으므로 `dist/worker.js`에 sql.js를 인라인하고 `sql-wasm.wasm`을 동봉하며(현 `tsup.config.ts:55`는 external) `dist/`를 커밋한다. SessionStart가 `node` ≥ 20을 확인한다.
- **Codex**: `.codex/hooks.json`(또는 `~/.codex/`)에 `command`와 `commandWindows`를 **이중 따옴표 절대 경로**로 기록, 공백 경로는 8.3 짧은 경로로 폴백, SessionEnd timeout 1. 설치 후 `/hooks` 신뢰 단계를 출력하고 `doctor`는 호출 0건 훅을 경고한다. **OpenCode**: `opencode.json` plugins 항목.

모든 설치는 `db:migrate`와 스냅샷 빌드를 실행하고, **`import`는 TTY가 있으면 대화형으로, 없으면 "run `hm import`" 안내만**; `--with-embeddings`는 `npm i @xenova/transformers`를 대신 실행한다. 건드린 파일과 해시는 `install-manifest.json`에, `uninstall [--purge]`은 매니페스트 항목만 제거하고 `.bak-v16`은 남긴다.

---

## 9. 동시성과 크래시 안전성

### 9.1 역할

reader: 모든 훅(스냅샷만, lock 없음, SQLite를 열지 않음), 읽기 CLI. writer: worker(`extract`, `dream`, `reindex`, `import`)와 CLI. ledger append는 한 줄 `appendFileSync`(≤ 32 KB)라 병렬 훅끼리 lock이 없고, `state/*.json`은 호스트가 직렬화하는 `prompt`/`stop`/`precompact`만 tmp+rename으로 쓴다.

### 9.2 writer 프로토콜 (`db/store.ts` `withWriteLock(dir, purpose, waitMs, fn)`)

```
1  mkdirSync(locks/db.lock) → owner.json {pid, hostname, purpose, started_at, heartbeat_at}; 보유 중 5 s마다 heartbeat
   EEXIST → heartbeat_at가 120 s 이상 오래됐거나(호스트 무관) 같은 host에서 kill(pid,0)이 ESRCH → 인수('lock_takeover');
     아니면 25–250 ms 지터 대기, waitMs(CLI 5 s, worker 30 s; 훅은 대기 없음) 초과 → LockBusyError(CLI exit 75)
2  readFileSync; verifyHeader("SQLite format 3\0"); 실패 → recoverFromPrev(.prev 복원, 손상본 .corrupt-<ts>)
3  user_version < 21 → copyFileSync(→ .bak-v<N>) → runMigrationsOnDb(db)(새 연결, 트랜잭션 없음, FK OFF) → post-migrate
4  BEGIN; op = fn(db); op가 no-op(이미 적용된 run)이면 derive·generation·write_ops를 건너뛰고, 쓰기가 전혀 없으면 ROLLBACK 후 5–6단계도 생략;
   아니면 derivePolicyRules(db); meta.db_generation += 1; write_ops(op.id) 삽입; PRAGMA quick_check(1); COMMIT — 예외 시 ROLLBACK
5  export → .tmp-<pid> → fsync → copyFileSync(→ .prev) → renameSync(5회 재시도; EPERM/EBUSY면 copy 폴백 + 경고)
6  buildSnapshot(db) → snapshot/*.tmp-<pid> → rename; finally: heartbeat 해제, rmSync(locks/db.lock)
```

lock은 load→apply→save를 직렬화하지만 보유는 수 초이고 **LLM 호출을 감싸지 않는다**.

### 9.3 `worker extract`의 두 lock 세션

```
A  worker.lock 획득(저장소당 하나). 실패 → 최대 5 s 지터 재시도 뒤 종료(승자가 E에서 재스캔하므로 유실 없음)
B  lock 세션 1 (≤ 1 s): queue/*.json → episodes INSERT OR IGNORE; 실제로 삽입된 에피소드(`changes()=1`)만 fired_json 항목을 fire_count/last_fired_at/override_count에 합산(유일한 소유자;
   outcome 정의: `fired(soft_deny)` 라인 바로 다음 `tool_*` 라인이 같은 시그니처에 일치하는 `tool_ok`면 override, 사이에 다른 툴 호출이 있으면 heed — stop 훅이 ledger에서 계산해 디스크립터에 넣는다);
   자격 있는 queued를 교정 우선 → 오래된 순으로 ≤ 3개 lease(180 s); 일일 캡(교정 제외); 해제
C  lock 없이: V1(스키마)을 통과한 raw/<run_id>.json이 있으면 재사용, 없으면 probe → provider(≤ 120 s) → 캐시 기록
   (`invalid_output`·`suspect` 원본은 raw/<run_id>.<attempt>.json으로 보관만 하고 재시도는 provider를 다시 부른다)
D  lock 세션 2 (≤ 2 s): write_ops에 run_id 있으면 extracted; 아니면 V1–V11 → reconcile(§5.7) → 커밋(§9.2)
E  queue 파일 삭제; 남은 자격 에피소드가 있으면 B로(실행당 최대 10); lock 해제 후 queue/ 재스캔, 있으면 A로
```

`session-start`는 `queue/`가 비어 있지 않으면 `worker extract`를 스폰하고 `worker dream`은 consolidate 전에 큐를 비운다(§5.8); `review`는 결정을 모아 10건마다 짧은 lock으로 적용한다.

### 9.4 실패 모드와 정해진 행동

| # | 실패 | 행동 |
|---|---|---|
| F1 | writer 둘 동시 / lock 보유자 사망 / 저장 중 크래시 / DB 손상 | 두 번째는 waitMs 뒤 exit 75(worker는 재시도); heartbeat 120 s 또는 pid 검사로 인수; tmp 고아는 10분 뒤 삭제; 헤더·`quick_check` 실패 시 `.prev` 복원, 손상본 보관 |
| F2 | 스냅샷 없음·손상·구식 / ledger 줄 찢김 | 빈 결과 또는 기존 스냅샷 + reindex 스폰; 파서가 건너뛰고 `doctor` `ledger_bad_lines` |
| F3 | worker kill / provider 행 / 쓰레기 추출 / provider 없음·중첩 거부 | lease 180 s 뒤 `queued`, 3회 후 `dead`, raw 캐시 재사용; 120 s kill → `timeout`, 1 h/6 h/24 h; 브레이커 → `suspect`; `no_provider`·`nested_refusal` 하루 1회, `status` "N episodes waiting (reason)" |
| F4 | 거대 transcript·툴 출력 / ENOSPC / rename 거부 | transcript 미개방, head 2 KB + tail 1 KB; 훅은 삼키고 exit 0, worker는 rename 전 중단; 5회 재시도 후 copy 폴백 |
| F5 | 훅 재귀 / env 상속 | `providerEnv()` 허용 목록 + ppid 체인 + `disableAllHooks` + 저장소 밖 cwd |
| F6 | `node` 이동·부재 / exec-form 미지원 / DB가 코드보다 새로움 / 중복 훅 등록 | `process.execPath` 기록, `doctor --fix`; shell-form 기록(§8.7); 읽기 전용 + "upgrade"; `tool_use_id`로 ledger 중복 제거 |
| F7 | 인터럽트·API 오류로 Stop 없음 | 다음 `prompt`가 `interrupted`로 닫고 `correction_for` 연결 |

관측성: 훅마다 `… PreToolUse tool=bash gen=42 activated=1 suppressed=17 decision=soft_deny delivery=before dur=63ms ok` 한 줄(`ok | bad_stdin | snapshot_missing | disabled | skipped:<reason> | error:<code>`; `HARNESS_MEMORY_DEBUG=1`이면 전체 JSON). `doctor`는 매니페스트 대 실제 등록, node 경로, 이벤트별 마지막 호출, 큐 깊이, 마지막 `extraction_runs`, probe 결과, lock 상태, `quick_check`, `user_version`, `db_generation` 대 스냅샷, `hooks.log` p95, 도달 불가 메모리, Git Bash 유무를 교차 확인하고 `--host-debug`로 호스트 디버그 로그의 `finished with status 0` 줄을 찾는다.

---

## 10. 정책 엔진과 규칙 파생

`PolicyEvaluationRequest`는 `{lifecycleTrigger, scopeRef, toolName?, toolTarget?, toolInput?}`로 넓어지고, `PolicyEngine.evaluate`(현재 `engine.ts:35-46`은 scope glob만 본다)는 `trigger_kind` 일치 ∧ `tool_pattern` glob이 정규 툴에 일치 ∧ (scope regex 일치 ∨ 전역 ∨ `arg_pattern`이 있고 scopeRef 없음) ∧ (`arg_pattern`이 null이거나 매처가 target에 일치)인 규칙을 돌려준다. 매처는 `activation/signature.ts`를 공유하므로 규칙과 피트폴이 어긋날 수 없다. `PolicyWarning`은 `enforcement`를 실어 어댑터가 §7.2로 매핑한다.

`policy/derive.ts`의 `derivePolicyRules(db)`는 **모든 writer 커밋 끝에서** `derived_at IS NOT NULL` 행을 지우고 active `policy` 메모리마다 다시 쓴다(이벤트 구동 파생은 편집·import·마이그레이션 뒤에 어긋난다). 규칙: `rule_code = 'POL-' + memory_id.slice(0,8) + '-' + trigger`, 트리거마다 한 행, `severity = enforcement === 'advise' ? 'info' : 'warning'`, `tool_pattern = signature.tool ?? relevant_tools.join('|') ?? '*'`, `target_kind = signature.target ?? 'any'`, `pattern_kind/arg_pattern = signature`, `enforcement = memory.enforcement`, `message = summary (+ details.slice(0,200))`. 수동 규칙(`derived_at IS NULL`)은 보존된다. 불변식 테스트: `policy_rules WHERE derived_at IS NOT NULL == derive(active policies)`. eval 픽스처 `NO_COMMIT_SECRETS`는 시그니처 `{write|edit, path, glob, "**/.env*"}`의 `confirm` human policy가 된다.

---

## 11. CLI 표면과 리뷰 UX

바이너리 `harness-memory`(별칭 `hm`), 직접 디스패치, 모든 명령에 `--json`, `--db`; 33개 명령 + 기존 `eval:*`(`episodes:*`/`queue *`는 `queue` 하나로 합치고 `memory:edit`·`proposals:withdraw`·`bench:hook`은 두지 않는다).

| 그룹 | 명령 |
|---|---|
| 설치 | `install --host claude\|codex\|opencode\|all [--user] [--with-embeddings]`, `uninstall [--purge]`, `doctor [--fix] [--host-debug <path>]`, `db:migrate`, `db:rollback`, `snapshot:rebuild` |
| 상태 | `status`(한 줄: `active 212 (auto 61) \| candidates 7 \| proposals 3 (2 expiring) \| queue 2 \| last extraction 2h ago ok \| probe ok \| snapshot fresh \| p95 71ms`) |
| 리뷰 | `review`(사람 메모리 대상 제안 → `revalidate` → policy 후보 → 전역 후보 → `fix_scope`/`fix_signature` → `merge` → 미확인 import(`import_unconfirmed=1`; 확인하면 플래그 해제와 enforcement 재산정) → 사람 후보; 키 `a`ccept `r`eject `s`kip `t`race `p`romote), `proposals:list\|accept [--kind K --all]\|reject` |
| 메모리 | `memory:list\|show\|add\|promote\|demote\|reject\|restore\|enforce <id> <level>\|history\|export\|export-skill\|stats [--since]\|why\|trace <id>` |
| 파이프라인·import·eval | `queue [list\|show\|retry\|drop]`, `extract [--now] [--provider] [--dry-run]`, `dream`, `trace <session_key>`; `import [--from …] [--yes] [--sync]`; 기존 `eval:*` + `eval:latency [--local]`, `eval:replay`, `eval:live` |

리뷰는 예외 처리이며 **예산이 있다**: dogfood에서 활성 일당 리뷰 항목 ≤ 3이 릴리스 게이트이고 `memory:stats`가 보고한다. 최근 auto 활성화는 `status`/`stats`로 옮기고 `review`에는 noisy이거나 `override_count > 0`일 때만 나온다. 교정 유래 후보와 `activate_policy` 제안의 만료는 `systemMessage`의 "M expiring"으로 미리 보인다. 모델 컨텍스트에 리뷰 텍스트·지시는 없다(D6); 유일한 예외는 §7.5의 `(contested, see hm review)` 표지 한 구절이다.

`import`: 파일을 불릿·헤딩 단위로 쪼개 `import` 에피소드(`e<N>` = 줄 번호, `evidence_weight = 1`, 툴 집합 = 정규 어휘 전체)로 렌더하고 같은 추출기를 `action = create`로 제한해 통과시킨다(V3·V4 규칙은 §5.6). 결과 표를 **확인한 뒤** `active`, `authority='human'`, `source_kind='import'`, `source_ref='import:<file>#L<n>'`, 전역이면 `activation_class='baseline'`로 삽입; `--yes`면 enforcement 상한 `advise`에 `import_unconfirmed=1`. 정규화 summary의 Jaccard ≥ 0.8인 살아 있는 행(017이 `import:legacy`로 태그한 v0.5 설치 행 포함)은, 확인된(TTY) import가 human 대체 행을 만들 때만 `transitionMemory(actor='import')`로 `supersede`(`status_reason='import:upgraded'`)하고 `--yes`와 `MEMORY.md`는 `supersede` 제안만 연다. `MEMORY.md`는 기계가 쓴 것이므로 `authority='auto'` `candidate`로 들어가 가중치 1로는 활성화되지 않고 다이제스트에 접힌 한 줄로 보인다. 재실행은 줄 해시로 멱등, 삭제된 불릿은 `--sync`에서 `stale(import:removed)`.

---

## 12. 결함 커버리지 매트릭스 (R1–R7, D1–D7)

| ID | 결함 | 구조적 제거 (테이블·컬럼·단계) |
|---|---|---|
| R1 | LLM 후보가 자동 승격 불가(evidence 0) | §5.7 4단계: `create({authority:'auto'})`(017 `authority!`, 기본값 없음) → `memory_provenance(origin, confidence)` → **같은 SAVEPOINT의 `recomputeDerived`** → 7단계 `decideTier(evidenceScore)` → `candidate→active`(auto_rule)은 `authority='auto'`라 통과. 테스트 §13.2 (a)(k) |
| R2 | `**/*` + `before_model` 하드코딩, before_tool 미도달 | 스키마 필수 `scope_glob/lifecycle_triggers/trigger_signature`; §5.7 2단계 명령 시그니처 규칙과 V3; §6.2 6단계(시그니처 메모리는 scopeRefs가 빌 때 scope 통과); 레거시는 017 `needs_scope=1`(모양 기준) + 019 `fix_scope`. 테스트 §13.2 (c) |
| R3 | 프로세스 수명당 추출 1회 | 게이트는 `episodes.status='queued'` ∧ 자격(§5.3) 하나; `Stop`/`PreCompact`/`prompt(interrupted)`마다 큐 + worker 스폰; `session-start`·`dream`도 큐를 비움 |
| R4 | LLM supersede/stale이 사람 메모리 즉시 제거 | `transitionMemory`의 `AuthorityViolationError`(§4.7); `update()`의 `status` 거부와 grep 불변식; LLM 어휘는 `propose_*`뿐; 대체 행은 §5.7 7단계에서 항상 `candidate`; human 행 주입 텍스트는 제안과 무관(§7.5) |
| R5 | 중복 fact throw, 배치 영구 재시도 | §5.7 3–4단계: `semantic_key` 조회 선행 → `reinforce`; `findExactDuplicate` status 필터 + `reviveTerminal`; fact별 SAVEPOINT; `write_ops(run_id)` 멱등; 3회 후 `dead` |
| R6 | 템플릿 문장 후보 | `DreamWorker` 삭제; 정규식은 `failure_sig`·플래그만(§5.1); 기존 템플릿 후보는 `post-migrate`가 links 술어로 `rejected` |
| R7 | `dream:run`이 conversation-batch 소비 | 입력 스트림 하나(ledger → `episodes`), 소비자 하나(`worker extract`); `dream`은 `memories`/`proposals`만 변경; 레거시 배치는 021에서 `discarded` |
| D1 | 플러그인이 DB를 상주시키고 덮어씀 | 훅은 `active.v1.json`만 읽음(§6.2 3단계); writer는 `withWriteLock` → load → apply → save → rename → snapshot(§9.2); OpenCode 플러그인도 DB 비상주(§8.4) |
| D2 | mem0식 프롬프트, scope/tool/trigger 없는 스키마 | §5.5 스키마(`required`에 scope·tools·signature·triggers·refs·knowledge_kind)와 §5.4 프롬프트 |
| D3 | 5개 flush, 300/4,000자 절단, 세션 귀속 오류 | 에피소드 = 턴 세그먼트(§3.4, §5.2), `turn_start_offset`은 prompt 라인 포함; 발췌 2 KB + 1 KB, 오류 1.5 KB, 프롬프트 24 KB; 라인마다 `turn_key` |
| D4 | `reinforce`가 재검증하지 않음 | §5.7 5단계가 재작성된 `revalidateMemory`(authority 게이트, `ttlDays(v)`)를 호출; §5.8(2)(4)가 만료·연장 집행 |
| D5 | scope-only 정책 엔진, 규칙 writer 부재 | 020 컬럼 + `signature.ts` 공유 매처(§10); `derivePolicyRules`가 §9.2 4단계에서 매 커밋 실행 |
| D6 | 리뷰 인박스 주입 | 어떤 훅도 리뷰 텍스트·지시를 `additionalContext`에 넣지 않음(§7.5의 `(contested)` 표지만 예외); 표면은 CLI + `systemMessage` 한 줄(§11) |
| D7 | 툴 호출마다 2 KB evidence 행 | 훅은 SQLite를 쓰지 않음; 발화는 수백 B의 `fired` 라인; worker가 `fire_count`/`override_count`로 롤업(§9.3 B) |

---

## 13. 평가 계획

1. **읽기 경로 회귀(결정적).** `eval:replay`가 12 시나리오(s01–s12)를 실제 훅 진입점에 합성 stdin으로 구동한다(s03: `**/.env*` confirm → `ask`; s06: `signature_mismatch`; s09: stale 억제; s12: 예산; PowerShell 변형). 추가 단언: auto 경로가 human 행의 status를 바꾸지 않음; startup에 before_tool 전용 메모리 없음.
2. **쓰기 경로 재생(결정적).** ledger 픽스처 12개(§13.1의 s01–s12와 짝)와 `replay` provider. 단언 (a)–(k): (a) 교정 에피소드 1개 → `active`, `authority=auto`, `enforcement=soft_deny`; (b) 맨 실패 1건 → `candidate`, 두 번째 에피소드에서 `active`; (c) 세션 A의 bash 전용 피트폴이 세션 B의 경로 없는 `Bash npm test`·`pnpm test`·`yarn test`·`npm run test`에서 발화; (d) 같은 run 2회 적용 시 export 바이트 동일; (e) human 행에 대한 환각 `propose_supersede` 뒤 active 행은 정확히 하나; (f) 1-support `propose_stale`은 auto 행을 바꾸지 않고 2-세션 support가 바꿈; (g) auto 행 reinforce가 TTL과 `validation_count`를 올림; (h) propose → expire → propose 성공; (i) 6개 "배우고 적용" 에피소드가 `type=pitfall`; (j) 교정 프롬프트만 있는 턴의 `evidence_weight=2`; (k) 추출 후보가 `AuthorityViolationError` 없이 활성화된다; 활성화되지 않은 auto 후보는 45 d 뒤 `rejected(expiry)`, 활성화된 행은 TTL 도달 시 correction/failure_resolution이면 `revalidate` 제안이 열리고 그 제안 만료(+30 d) 뒤, 그 외는 7 d에 `stale(ttl_expired)`.
3. **지연 게이트.** `eval:latency`(§6.3), CI에서 p95 ≤ 90 ms.
4. **운영 스위트(vitest, Windows 러너 포함).** tmp 저장과 rename 사이 `SIGKILL`; 병렬 훅 20개 append + CLI promote 루프(손실 0, 교착 0, exit 75); 쓰레기 추출 픽스처(비 JSON, fact 40개, 환각 ref, 파국적 regex, 단독 토큰 시그니처); v0.5 DB 픽스처(llm-extract 모양 행, install 불릿 행, 템플릿 후보, identity 쌍둥이)의 017–021 단언(evidence·links 불변, `fix_scope` ≥ 1, 후보는 `auto`); 스냅샷 도달 불가 불변식(픽스처); 분리 worker가 콘솔 창을 띄우지 않음(Windows); `policy_rules` 파생 불변식.
5. **회귀 바닥.** 삭제 모듈과 무관한 기존 스위트(activation-engine, activation-fusion, memory-core, migrator, policy-engine, security-scanner ≈ 73 `it`)는 모든 마일스톤에서 녹색; 삭제 모듈에 걸린 ≈ 150개(dream-worker, e2e-pipeline, opencode-adapter, zz-repro*, benchmark, hm-*)는 M6에서 이식하거나 퇴역한다.
6. **라이브 A/B(`eval:live`).** v0.6.0은 Claude Code만, 시드 1, 세 팔(**A** 마크다운 전용, **B** 네이티브 auto-memory, **C** `CLAUDE.md` + harness-memory) × 18 시나리오(12 + "배우고 적용" 2세션 6개). 지표: 중요 정책 누락률(A 대비 ≥ 30 % 감소), **타이밍 열**(`fired.delivery`: 전 / 결과와 함께 / 전혀), 경고 정밀도 ≥ 0.7, heed rate, 턴당 주입 바이트(session_start 포함, C ≤ A의 25 %), 추출 수율; Codex 팔은 0.6.1.
7. **dogfood 2주.** autonomy regret(`review`에서 거부된 auto 활성화 비율, > 0.1이면 `auto_enforcement`를 `advise`로), 리뷰 항목/일(≤ 3), `override_count` 분포, `nested_refusal`/`probe_timeout` 발생을 `memory:stats --since 14d`로 본다.

---

## 14. 구현 로드맵 (주 단위, 솔로 개발자)

| 주 | 마일스톤 | 산출물 |
|---|---|---|
| 1 | M0 사실 시트 + 저장 계층 | §15.2 항목을 실제 바이너리로 확정; `store.ts`, `locks.ts`, `runMigrationsOnDb`; 017–021 SQL; v0.5 픽스처 DB |
| 2 | M1 데이터 계층 | `post-migrate.ts`; `transitions.ts`; `repositories/*`; `MemoryRepository` 변경(§2); grep 불변식; `db:rollback`; 회귀 바닥 녹색 |
| 3 | M2 엔진·스냅샷·정책 | `MemoryReader`, lazy lexical, startup 트리거 필터, `signature.ts`(정규형, PowerShell, V5/V10), `tool-vocabulary.ts`, `snapshot.ts`/`snapshot-reader.ts`, `derive.ts` |
| 4 | M3 훅 핫패스 + Claude Code | `hook.ts` 번들, `hook-io.ts`, `ledger.ts`, `hosts/claude-code.ts`(PowerShell, StopFailure, interrupted), 사다리 출력 + 비대화형 강등, `install --host claude`(버전 게이트, exclude, 매니페스트), `eval:latency` |
| 5 | M4a 쓰기 경로 1 | `episode.ts`, `worker.ts`(두 lock 세션, lease, 재스캔, `providerEnv`), providers `claude`·`replay` + `probe`, 스키마·프롬프트·V1–V11 |
| 6 | M4b 쓰기 경로 2 | `reconcile.ts`, `authority.ts`, `proposals.ts`, `revalidate.ts`, `consolidate.ts`, 재생 픽스처 6개. **주말: Claude Code 전용 dogfood 빌드** |
| 7 | M5 CLI·리뷰·import | `review`, `proposals:*`, `status`, `doctor`, `trace`/`memory:trace`, `queue`, `import`, `uninstall`, `memory:stats`; 재생 픽스처 12개 + `eval:replay`. dogfood 1주차 |
| 8 | M6 테스트 이식 + 운영 스위트 | ≈150개 테스트 이식·퇴역, 운영 스위트(§13.4), 플러그인 패키징(§8.7), 문서 초안. dogfood 2주차 |
| 9 | M7 dogfood 반영 + 릴리스 후보 | 기본값 조정(§13.7), `eval:live`(Claude Code, 시드 1, 3팔), README·CHANGELOG |
| 10 | M8 **v0.6.0 릴리스(Claude Code)** | 릴리스 게이트(§13.1–13.5 녹색, 리뷰 예산, regret), 잔여 결함 수정, npm + 마켓플레이스 배포 |
| 11 | M9 Codex → v0.6.1 | `hosts/codex.ts`(`apply_patch`, `turn_id`, 실패 유도 픽스처 코퍼스, `additionalContextLimit`), `commandWindows`, `/hooks` 안내, `codex` provider, Codex 재생·라이브 eval |
| 12 | M10 OpenCode V2 → v0.6.2 | `Plugin.define` 어댑터(`permission.assert`, `context`, idle 신호는 §15.2에서 확인되면), V1 shim, 하한 1.18.29, `opencode` provider |
| 13–14 | 위험 여유 | M0 사실 시트 뒤집힘(중첩 `-p` 거부, exec-form 버전), Windows 러너 불안정, dogfood 회귀 |

**총 14주 = 작업 12주 + 위험 여유 2주.** 코드 규모: 삭제 약 3,900줄(`opencode-plugin.ts` 1,467, `dream/repository.ts` 774, `dream/worker.ts` 680 등), 추가 약 6,500줄(새 테이블의 데이터 접근층, 호스트별 훅 모듈, 검증기, doctor, 테스트 이식 포함; 글로벌 DB·자동 병합·buckets·레거시 재추출·명령 8개를 잘라 비평가 추정 8–10k에서 줄였다).

---

## 15. 열린 질문과 결정 필요 사항

### 15.1 브리프와 다른 결정 (근거는 §8.1 검증 사실)

1. `additionalContext`로 실행 전 주입 → 불가능; 실행 전 채널은 `ask`/`deny`뿐이므로 메모리 단위 enforcement 사다리(§7). auto 피트폴의 `soft_deny`는 재시도로 진행 가능하므로 하드블록이 아니다.
2. 훅 기본 타임아웃 60 s → 600 s; async 훅은 `-p` 종료 시 kill; 추출은 분리 worker만; 훅은 SQLite를 열지 않는다.
3. `before_model` = 모델 호출마다 → 훅 호스트에서는 사용자 턴당 한 번. "증거 ≥ 2" → 가중치 ≥ 2, 강등에만 2-세션 support; "닫힌 에피소드마다 추출" → 신호 있는 에피소드만.
4. import는 첫 사용자의 첫날 경로(확인 단계가 사람 게이트); transcript 파일은 불투명 포인터.
5. 제약 7 "zero native deps" → "핫패스에 네이티브 없음, 임베딩은 선택 peer 의존"; 제약 8 ↔ `--bare` 미사용, 중첩 실행은 env 허용 목록과 저장소 밖 cwd로 방어.
6. 마이그레이터 유지 → 트랜잭션 밖·FK OFF 실행과 `.bak-v16`, 007의 UNIQUE는 부분 인덱스로. 글로벌 DB 동기화는 0.7.
7. 엔진 기본 예산 10 / 8 KB → 트리거별 예산(session_start 5 / 3 KB, before_model 5 / 3 KB, before_tool 3 / 2 KB, after_tool 2 / 1 KB; `config.json`)으로 축소: 턴당 주입 바이트 지표(§13.6)를 맞추기 위함이며 `DEFAULT_ACTIVATION_LIMITS`는 상한으로 유지한다.

### 15.2 M0에서 사실 시트로 확정할 항목

- Claude Code: `providerEnv()`로 띄운 `claude -p`가 훅 자식 안에서 성공하는지(버전 기록), `--tools ""`와 `--json-schema`가 함께 동작하는지(구조화 출력이 내부 툴이면 그 툴만 남기는 대안), `UserPromptSubmit` stdin의 `prompt_id`가 제출 중인 프롬프트의 id인지, `-p` 기본(Manual) 모드에서 훅 `ask`가 자동 거부되는 조건과 모델에 전달되는 문구, auto memory 끄기 키, exec-form 최소 버전, 분리 worker가 실제 `claude`(Bun)·`codex` 바이너리의 훅 타임아웃 kill 뒤 생존하는지, `--bare` 기본 전환의 감지와 폴백, 플러그인의 `"command":"node"` PATH 해석, `MEMORY.md` 슬러그 인코딩. Codex: `PreToolUse` `additionalContext` 타이밍, `tool_response` 실패 문자열 모양, `Interrupt` stdin 필드, `commandWindows`의 셸. OpenCode: `context` 훅 페이로드, `permission.assert` 거부 사유의 모델 가시성, V2 idle 신호의 존재(`event.subscribe` 타입명)와 `Plugin.define` 최소 버전.

### 15.3 저자 결정이 필요한 항목

1. 교정 유래 auto 피트폴의 기본 `soft_deny`를 유지할지, dogfood regret > 0.1이면 `advise`로 내릴지(명세는 유지).
2. 추출 모델 기본값과 Codex 쪽 기본; `-p`가 `--bare` 기본이 되면 `codex exec`/OpenCode 폴백을 자동 선택할지 API 키를 선택 제공할지.
3. 0.7 후보: heeded-fire 추론, 신뢰 티어, 글로벌 DB 동기화, auto↔auto 자동 병합, `buckets`, `legacy_*` 삭제, `decision` 자동 활성화, worktree의 `.harness-memory` 공유.
4. `before_model`의 non-baseline 행을 "scope 교차 ∧ BM25"로 결합 게이트하면(§6.1) 경로 토큰이 없는 프롬프트("API에 rate limit 붙여줘")에서는 scope가 있는 workflow가 전혀 뜨지 않는다. dogfood에서 `before_model` 발화가 지나치게 드물면 "scope 교차 ∨ BM25 ≥ 높은 임계"로 완화할지.

### 15.4 비평 중 기각·부분 수용한 항목

- **정규 툴 이름을 `shell`로 개명**(host-feasibility): 기각. `PowerShell→bash` 매핑과 `shell_dialect`로 충분하고 v0.5의 `relevant_tools_json` 값과 Codex·OpenCode 이름이 그대로 맞는다.
- **모든 툴을 PreToolUse에 등록**(concept-and-autonomy 대안): 부분 수용. `WebFetch`만 추가하고 `Read|Grep|Glob|Task`는 V11이 `before_model`로 내린다.
- **import·legacy 에피소드에 V3/V4 완화**(defect-closure): import만 수용; 레거시 재추출은 migration-and-complexity 비평대로 삭제했다(두 비평이 충돌; 300자 절단 블롭의 재추출은 수율이 0에 가깝다).
- **다른 호스트 lock 인수 분기 삭제**(migration-and-complexity): 부분 수용, "heartbeat 120 s 초과면 인수" 한 규칙으로 합쳤다.
- **`stop_hook_active` 조기 종료 제거**(defect-closure): 수용하되 불충분해서 세그먼트(§3.4)를 도입했다 — 조기 종료만 없애면 같은 `prompt_id`의 두 번째 닫기가 `INSERT OR IGNORE`에 먹힌다.
- **발화 시 `revalidate_after` 연장**(concept-and-autonomy): `ttl_expires_at`을 늘리는 쪽으로 바꿨다; `revalidate_after`는 표시용이다. **shadow 기본값**은 유지 기각: 자동 활성화를 꺼 두면 G7이 존재하지 않는다.
- 개정 3 검증에서 다르게 푼 두 가지. **`import --yes` 행을 `auto`·`candidate`로 낮추라**(일관성 검증): 기각. 출처가 사람이 쓴 파일이고 패턴은 불릿에서 그대로 인용되므로 `human`을 유지하되 enforcement 상한 advise + `import_unconfirmed=1`로 `review`에 남긴다(G3·§7.1·§11 문구를 이에 맞춰 통일); 가중치 1인 auto 후보는 영영 활성화되지 않아 `--yes`가 무의미해진다. **`-p` 기본 모드에서 `confirm`이 매 재시도마다 `ask`로 하드블록**(호스트 검증): 새 강등 규칙 대신 이미 있던 7단계 제외 규칙이 `confirm`에도 적용됨을 §6.2에 명시했다(턴당 한 번만 ask).
