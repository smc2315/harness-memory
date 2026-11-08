# harness-memory v0.6 (v1 빌드) 설명서

> 대상 독자: 이 프로젝트의 저자. "일단 너가 판단해서 v1 쭉 만들어봐. 만들고 나서 설명을 볼게"에 대한 답입니다.
> 작성일 2026-11-08. 브랜치 `redesign/v0.6`, 패키지 버전 `0.6.0-rc.1`. (최종 수치는 §12 참고)

---

## 1. 한눈에 보기

v0.5(OpenCode 플러그인)는 "증거 수집 → dream 통합 → 사람 승인 → 4단계 활성화"라는 좋은 개념을 가지고 있었지만, 실제로는 두 개의 쓰기 경로가 서로 연결되지 않아(`core-review-v0.5.md`의 R1–R7, D1–D7) 메모리가 거의 저장되지 않는 상태였습니다. v0.6은 **개념과 모듈 구조는 유지하되 배선을 전부 다시 짠 버전**입니다.

v1 빌드에서 동작하는 것:

- Claude Code 호스트에 `hm install --host claude` 한 번으로 9개 훅 이벤트를 등록하고, 세션 동안 일어난 일을 **ledger**(append-only JSONL)에 기록합니다.
- 턴이 끝날 때(Stop/PreCompact/다음 프롬프트/idle) 턴을 **episode**로 닫고, 교정·실패→해결·"기억해둬" 같은 **의미 신호**가 있는 episode만 큐에 넣습니다.
- 분리된(detached) **worker** 프로세스가 큐를 읽어 `claude -p --json-schema`(또는 `codex exec`, 테스트용 replay)로 **구조화 추출**을 하고, 11개 검증기(V1–V11)를 통과한 사실만 **결정론적으로** `memories` 테이블에 반영합니다.
- 모든 DB 쓰기 직후 **스냅샷 3개 파일**(`active.v1.json`, `lexical.v1.json`, `dense.v1.bin`)을 다시 만들고, 훅은 **SQLite를 절대 열지 않고** 이 스냅샷만 읽습니다. PreToolUse 훅의 목표 p95는 90 ms입니다(실측은 §12).
- 교정 한 번으로 만들어진 pitfall/workflow 메모리는 사람이 승인하지 않아도 `authority=auto`로 **자동 활성화**되어 다음 번 같은 도구 호출에서 `soft_deny`/`advise`로 개입합니다. 사람이 만든 행(`authority=human`)은 LLM이나 자동 규칙이 **절대** 상태를 바꿀 수 없습니다.
- 벡터 검색은 `before_model`(UserPromptSubmit)에서 유지됩니다: 상주형(idle 종료) 임베딩 helper 프로세스 + 추출기가 뽑아준 한국어/영어 **aliases**의 어휘 색인.

동작하지만 **이 머신에서 끝까지 검증하지 못한 것** 하나: 실제 `claude -p` 추출입니다. 이 PC의 `claude` CLI가 로그인되어 있지 않아(`/login` 필요) 추출 provider probe가 `not_logged_in`을 돌려줍니다. 그래서 추출 파이프라인은 녹화된 fixture를 재생하는 **replay provider**로 테스트했고, 실제 probe 실패 → 24 h 대기 → `hm status` 안내 경로는 실기로 확인했습니다(§9, §10).

---

## 2. v0.5 → v0.6에서 바꾼 핵심 결정

| # | 결정 | 이유 |
|---|---|---|
| 1 | **훅 프로세스는 무상태**. SQLite를 열지 않고 `snapshot/active.v1.json`만 읽는다 | sql.js WASM 초기화만 수십 ms. 모든 도구 호출마다 그 비용을 낼 수 없고, 병렬 훅이 DB를 동시에 여는 순간 잠금 지옥이 된다 |
| 2 | **LLM 실행은 worker 한 곳**. 훅·CLI·프롬프트 경로 어디에서도 모델을 호출하지 않는다 | 도구 호출당 토큰 0. 계정·텔레메트리 없음. 추출이 느리거나 실패해도 Claude Code 세션은 영향 없음 |
| 3 | **episode 단위 추출**. 대화 전체가 아니라 교정·실패·해결 신호가 있는 턴 조각만 | v0.5는 "언젠가 dream이 돌면" 모델이었고 사실상 돌지 않았다. 신호가 있는 순간에만, 즉시, 작게 |
| 4 | **authority 열(사람/자동)로 사람 판단을 뒤집음**. 자동 행은 자동으로 살고 죽고, 사람 행은 사람만 바꾼다 | v0.5는 모든 승격을 사람이 해야 했고 아무도 하지 않았다. 반대로 LLM이 사람 행을 지우는 사고(R1)는 구조적으로 막아야 한다 |
| 5 | **시그니처(`trigger_signature`) + 강제 사다리**. 메모리가 어떤 도구·대상에서 발화할지 사전 컴파일해 두고 advise/confirm/soft_deny/deny를 호스트의 additionalContext/ask/deny에 매핑 | "관련 있어 보이는 것을 프롬프트에 끼워 넣기"가 아니라 도구 경계에서 실제로 개입하는 메모리가 이 도구의 존재 이유 |
| 6 | **벡터 검색은 before_model에서 유지, PreToolUse에서는 제외** | 당신 지적("벡터디비 쓰는게 핵심이였는데")대로 되돌렸습니다. 단, 도구 호출마다 임베딩을 계산하면 p95 90 ms를 지킬 수 없어서 UserPromptSubmit(예산 30 s)에서만, 그리고 상주 helper에 named pipe로 물어보는 방식으로. 자세한 것은 §7 |

---

## 3. 메모리는 어떻게 저장되는가 (한 턴의 실제 추적)

아래는 빌드된 `dist/`로 임시 프로젝트에 설치한 뒤, 훅에 실제 Claude Code 페이로드를 흘려 넣어 얻은 기록입니다.

### 3.1 훅이 ledger에 쓴다 (`.harness-memory/ledger/claude-code-<session_key>.jsonl`)

```
{"kind":"marker","marker":"session_start", ...}
{"kind":"prompt","turn_key":"p1","text":"아니, 여기서는 npm test 쓰지 말고 pnpm vitest run 으로 돌려. 기억해둬","correction":1,"remember":1}
{"kind":"tool_fail","tool":"bash","input_digest":"npm test","program_token":"pm test","exit_code":1,"failure_class":"exit_1","failure_sig":"bash|exit_1|pm test", ...}
{"kind":"tool_ok","tool":"bash","input_digest":"pnpm vitest run","program_token":"pm vitest","output_head":"Test Files 3 passed (3)", ...}
{"kind":"assistant","text":"Switched the test command to pnpm vitest run; all tests pass."}
```

- 프롬프트 훅이 한국어 교정 패턴("아니, …말고", "기억해둬")을 감지해 `correction=1`, `remember=1`을 찍었습니다(`src/core/signals.ts`).
- 자격증명 패턴(토큰, 키, 비밀번호 등)은 ledger에 쓰기 전에 `[REDACTED]`로 치환됩니다.
- 한 줄 ≤ 32 KB, 한 번의 `appendFileSync`. 병렬로 뜨는 PreToolUse/PostToolUse 훅은 **상태 파일을 쓰지 않고** ledger에만 append 합니다(§9.1 쓰기 규약).

### 3.2 Stop 훅이 턴을 episode로 닫고 큐에 넣는다

`state/claude-code-<key>.json`이 턴의 시작 바이트 오프셋을 들고 있다가, Stop에서 그 구간을 읽어 **EpisodeDescriptor**를 만듭니다:

```
flags {correction:1, remember:1, failure:1}  →  evidence_weight 6  (교정 2 + 기억 3 + 실패 1)
failure_signatures [{sig:"bash|exit_1|pm test", ...}]
ledger_ref "ledger/claude-code-….jsonl#151-1283"
```

적격성 규칙: `evidence_weight ≥ 2`이거나 결정 마커가 있어야 큐(`queue/<episode_id>.json`)에 들어갑니다. 신호 없는 턴은 `skipped:no_signal`로 끝나고 LLM을 호출하지 않습니다. episode id는 (host, session, turn, segment)에서 결정론적으로 만들어져, idle sweep과 Stop이 같은 턴을 두 번 닫아도 `INSERT OR IGNORE`로 중복되지 않습니다.

Stop 훅은 그 다음 `node dist/worker.js <root> extract`를 **detached**로 띄우고 즉시 종료합니다(stdout은 비움).

### 3.3 worker가 두 번의 짧은 잠금 세션으로 추출을 반영한다

```
extract start
extract lease   queued=1 inserted=1 leased=1              ← 잠금 세션 1: 큐 파일 → episodes 행, lease 180 s
extract warn    claude probe: not_logged_in                ← 잠금 밖: provider probe / claude -p (최대 120 s)
extract failed  episode=c057… status=not_logged_in disposition=waiting next=<24 h 뒤>
extract end     exit=0
```

- **잠금 밖에서 LLM을 부릅니다.** DB 잠금(`locks/db.lock`, mkdir + owner.json heartbeat)을 쥔 채 2분짜리 모델 호출을 기다리는 일은 없습니다.
- provider 호출: `claude -p --output-format json --json-schema <스키마> --tools "" --disallowedTools "mcp__*" --strict-mcp-config --no-session-persistence --settings '{"disableAllHooks":true,"autoMemoryEnabled":false}'`. 자식 환경은 allowlist(`providerEnv`)로 만들며 `CLAUDECODE*`/`CLAUDE_CODE_*`를 제거하고 `HARNESS_MEMORY_DISABLE=1`을 넣어 **우리 훅이 재귀 호출되지 않게** 합니다. cwd는 저장소 밖 `~/.harness-memory/worker/<repoHash>/`.
- 결과는 `raw/<run_id>.json`에 캐시되어 같은 episode를 다시 처리할 때 모델을 다시 부르지 않습니다.
- 잠금 세션 2(`reconcile`)에서 사실(fact)마다 `SAVEPOINT`를 걸고: 스키마·V1–V11 검증 → 기존 행과의 이웃 탐색(semantic_key, Jaccard 0.6, 코사인 0.85) → `reinforce`/`create`/`propose_*` 결정 → `recomputeDerived`(증거 점수·세션 수) → `decideTier`(active/candidate) → `transitionMemory`. 같은 run을 두 번 적용하면 `write_ops`에서 걸러져 **바이트 단위로 동일한 DB**가 됩니다(테스트 (d)).
- 커밋 뒤 `buildSnapshot`이 스냅샷 3개 파일을 tmp+rename으로 다시 씁니다. 훅은 `snapshot.source {mtime, size}`를 DB 파일과 비교해 오래된 스냅샷이면 `worker reindex`를 분당 1회만 요청합니다.

위 추적에서는 probe가 `not_logged_in`이라 사실이 만들어지지 않았고, episode는 attempt를 소모하지 않은 채 `queued`로 남아 24 h 뒤에 다시 시도됩니다. `hm status`는 이렇게 보여 줍니다:

```
active 0 (auto 0) | candidates 0 | proposals 0 | queue 0 | last extraction 21s ago not_logged_in | probe not_logged_in | snapshot fresh | p95 9ms
  probe: run `claude` once in a terminal and `/login`; extraction stays queued until the CLI is logged in
```

CLI가 로그인된 머신에서는 같은 episode가 다음과 같이 끝나야 합니다(replay fixture s01로 검증한 경로): 사실 1건 → `type=pitfall`, `authority=auto`, `enforcement=soft_deny`, `status=active`, TTL 30 d, `trigger_signature {tool:"bash", target:"command", pattern_kind:"cmd", pattern:"pm test"}` → 다음에 Claude가 `npm test`를 실행하려 하면 PreToolUse 훅이 `permissionDecision: "ask"`와 사유("이 프로젝트에서는 pnpm vitest run을 쓰라고 교정받음")를 돌려줍니다.

### 3.4 consolidate (`worker dream`, 6 h 주기 또는 `hm dream`)

메모리를 **새로 만들지 않고** 상태만 옮깁니다: 발화(fire) 기반 TTL 연장 → 교정 TTL 만료 시 `revalidate` 제안 → convention 7 d stale → candidate 45 d rejected → 제안 만료 → 근접 중복 `merge` 제안 → 깨진 시그니처 `fix_signature` 제안 → 임베딩 백필 → idle 턴 스윕 → 파일 GC(ledger 14 d, raw 24 h, audit 30 d).

---

## 4. 어디에 저장되는가

프로젝트별: `<repo>/.harness-memory/`

```
memory.sqlite              SQLite (sql.js), user_version 21 — 유일한 진실
memory.sqlite.prev         직전 저장본 (헤더 손상 시 자동 복구)
memory.sqlite.bak-v<N>     마이그레이션 직전 백업 (v0.5 → v0.6 올릴 때 .bak-v9/.bak-v10 등)
snapshot/active.v1.json    훅이 읽는 전부: active 메모리(임베딩 제외), 파생 정책 규칙, failure_index, counts, source stat
snapshot/lexical.v1.json   MiniSearch 직렬화 (summary/details/aliases, 한국어 조사 제거 토크나이저)
snapshot/dense.v1.bin      [u32 헤더 길이][헤더 JSON][Float32 행렬] — 임베딩 켠 경우만
ledger/<host>-<key>.jsonl  세션별 append-only 기록 (14 d 뒤 GC)
state/<host>-<key>.json    열린 턴의 오프셋·세그먼트·last_episode_range; *.notify.json 은 worker → 다음 프롬프트 안내
queue/<episode_id>.json    추출 대기 episode (worker가 소비 후 삭제)
raw/<run_id>.json          provider 원문 캐시 (24 h)
locks/db.lock, worker.lock mkdir 잠금 + owner.json heartbeat; worker.pid, embed-helper.pid
logs/hooks.log|worker.log|audit.log  5 MB × 3 회전
config.json                HarnessConfig (아래 §7, §8)
install-manifest.json      install이 쓴 것 전부 — uninstall이 이것만 보고 되돌림
```

사용자 레벨: `~/.harness-memory/` — `models/` (e5-small 캐시), `worker/<repoHash>/` (headless CLI의 빈 cwd), v0.5의 `global.sqlite`(건드리지 않음).

호스트 쪽: `<repo>/.claude/settings.local.json`에 exec-form 훅 9개(`{"type":"command","command":"<node.exe>","args":["<dist/hook.js>","pre-tool"],"timeout":5}`), 그리고 `.git/info/exclude`에 그 파일 한 줄. `--user`를 주면 `~/.claude/settings.json`.

**백업할 것**은 `memory.sqlite` 하나입니다. 나머지는 전부 재생성 가능합니다(`hm snapshot:rebuild`).

### 4.1 메모리 행에 무엇이 들어가나 (마이그레이션 017)

`id, type(pitfall|workflow|policy|convention|…), summary, details, scope_glob, semantic_key, identity_key, trigger_signature_json, signature_key, lifecycle_triggers, activation_class, knowledge_kind, failure_classes_json, aliases_json, authority(human|auto, NOT NULL, 기본값 없음), enforcement(advise|confirm|soft_deny|deny), status(candidate|active|stale|rejected|…) + status_reason, source_kind(extraction|human|import|migration), source_ref, evidence_score/evidence_count/distinct_session_count, fire_count/override_count, confidence, importance, ttl_expires_at, revalidate_after, last_fired_at, open_proposal_id, contested, needs_scope, import_unconfirmed, embedding(BLOB)`.

v0.5 행은 017에서 `promotion_source='auto' OR status='candidate' → authority='auto'`, 그 외 `human`으로 옮겼고 **행을 하나도 지우지 않았습니다**(두 개의 실제 v0.5 DB로 검증). 옛 dream 테이블은 021에서 `legacy_*`로 이름만 바꾸고 `memory:history`가 읽어 줍니다.

---

## 5. 훅이 하는 일 (9 이벤트)

| 이벤트 | 훅 argv | 하는 일 | 출력 |
|---|---|---|---|
| SessionStart | `session-start` | 스냅샷 신선도 확인(stale → `worker reindex`), 다른 세션의 idle 턴 스윕, `lifecycle_triggers ∋ session_start`인 행 중 상위 5개(≤ 3 KB) | `additionalContext` |
| UserPromptSubmit | `prompt` | 교정/기억 신호 감지, 이전 episode가 교정 대상이면 `correction_for` 기록, notify 파일 소비(systemMessage), **before_model 검색**(어휘 BM25 + dense top-k, 정규화 점수 ≥ 0.35) | `additionalContext`, `systemMessage` |
| PreToolUse (Bash/PowerShell/Edit/MultiEdit/Write/NotebookEdit/WebFetch/mcp__*) | `pre-tool` | 스냅샷 로드 → scope regex 교차 → 시그니처 매칭(cmd 토큰/glob/regex) → 이미 발화한 메모리 제외 → 타입 쿼터/바이트 예산 → 강제 사다리 매핑. `fired` 줄 append | `additionalContext`(advise) / `permissionDecision: ask`(confirm, soft_deny) / `deny` |
| PostToolUse | `post-tool` | `tool_ok` 줄, 이전 실패의 해결 여부(`resolution_of`) | 없음 |
| PostToolUseFailure | `post-tool-failure` | `tool_fail` 줄(실패 분류: `exit_<n>`, `timeout`, `enoent`, `eacces`, `interrupt`, `other`), `failure_index`로 after_tool 힌트 | `additionalContext` |
| Stop / StopFailure | `stop`, `stop-failure` | 세그먼트 닫기 → episode → 큐 → worker 스폰; 6 h 지났으면 `worker dream`도 | 없음 |
| PreCompact | `precompact` | 세그먼트를 닫되 세션은 계속 (segment += 1) | 없음 |
| SessionEnd | `session-end` | 마지막 세그먼트 닫기 (예산 1.5 s 공유 → 큐 파일만 쓰고 끝) | 없음 |

강제 사다리와 자동화 레벨:

- `advise` → additionalContext 한 줄 (`systemMessage` 없음).
- `confirm` → `permissionDecision: ask` + 사유(사용자가 보고 결정). `bypassPermissions`/`dontAsk` 모드에서는 ask를 보여 줄 수 없으므로 soft_deny처럼 "한 번 deny + 사유"로 바뀝니다(`delivery: before_downgraded`로 기록).
- `soft_deny` → 첫 시도는 `permissionDecision: deny` + 사유(모델이 사유를 읽고 고칠 기회). 같은 턴에서 같은 시그니처로 다시 시도하면 `fired` 줄의 `signature_keys`로 이미 발화한 것을 알고 막지 않습니다. 사용자가 계속 무시해 세션 누적 override가 3회가 되면 dream이 `advise`로 내립니다.
- `deny` → `permissionDecision: deny`. 사람이 `memory:enforce <id> deny`로만 올릴 수 있습니다. 자동 행은 절대 deny가 되지 않습니다.
- `permissionDecision: allow`는 쓰지 않습니다(사용자의 권한 프롬프트를 자동 승인해 버리는 효과가 있어서).

훅 안전장치: stdin 캡/타임아웃, 어떤 예외도 `{}` 한 줄과 exit 0으로 수렴, `HARNESS_MEMORY_DISABLE=1`이면 즉시 종료(중첩 `claude -p` 보호), 프로젝트에 `.harness-memory/`가 없으면 `not_installed`로 즉시 종료(사용자 홈의 `~/.harness-memory`는 프로젝트로 보지 않음), 훅 번들에 sql.js/minimatch/transformers가 정적 import되지 않는지 테스트로 고정(`test/hook-bundle-imports.test.ts`).

---

## 6. 권한 모델 (authority)

```
                      ┌──────────────── 사람만 바꿀 수 있음 ───────────────┐
 authority=human :    memory:add / import / 017에서 사람이 승격한 행        │
                      LLM 출력·auto_rule·expiry가 상태를 바꾸려 하면         │
                      AuthorityViolationError → 아무것도 쓰지 않음           │
                      (대신 proposals 테이블에 "제안"만 남김)                 │
                      └──────────────────────────────────────────────────┘
 authority=auto  :    추출 결과. evidence_score ≥ 2면 즉시 active (TTL 30 d: correction·failure_resolution, 7 d: 그 외; trust 0.65)
                      TTL이 다가오면 revalidate 제안, 2개 세션의 지지 없이는 자동 강등 안 함, 만료 시 stale
                      policy 타입·전역 scope(**/*)는 예외: 항상 candidate로 들어가 사람 승인 필요
```

- **제안(proposals) 8종**: `supersede`, `stale`, `merge`, `fix_scope`, `fix_signature`, `revalidate`, `activate_policy`, `activate_global`. LLM이 "이 사람 행은 이제 틀렸다"고 하면 바로 지우지 않고 `propose_stale`을 열고, 다른 세션이 같은 주장을 하면 지지(support)를 쌓습니다. 사람은 `hm review`로 한 번에 처리합니다.
- 30 d 안에 거절된 주장은 같은 semantic_key로 다시 제안되지 않습니다.
- 모든 상태 전이는 `memory_transitions`에 actor(human|auto_rule|expiry|import|migration)와 사유를 남깁니다. `UPDATE memories SET status=`가 `transitions.ts` 밖에 없다는 것을 정규식 테스트로 고정했습니다.
- 자동 행의 confidence는 증거(evidence) 행이 하나 늘 때마다 0.05씩 올라가 0.99에서 캡되고, 신뢰 배수(trust)는 재검증 횟수에 따라 0.65 → 0.8 → 0.95(사람 행 1.0)입니다. 사람 행은 카운터만 올라가고 상태·enforcement는 손대지 않습니다.

---

## 7. 벡터 검색은 어떻게 남겼나

당신이 말한 대로 dense 검색은 이 도구의 핵심입니다. v0.5에서도 실제로 dense를 쓴 곳은 `before_model`뿐이었고(`before_tool`은 scope 매칭만), v1도 거기에 맞췄습니다.

- **helper 프로세스** (`dist/embed-helper.js`): 첫 before_model 호출이 `node dist/embed-helper.js <root>`를 detached로 띄웁니다. helper는 `@xenova/transformers`로 `Xenova/multilingual-e5-small`(양자화)을 한 번 로드하고 named pipe(`\\.\pipe\harness-memory-embed-<repoHash>`, POSIX는 `locks/embed-helper.sock`)에서 `ping | embed | topk` 요청을 받습니다. 15분 유휴면 스스로 종료합니다. 쿼리 접두어 `query: `.
- **훅 쪽** (`src/embed/client.ts`): 프롬프트 텍스트를 `topk` 요청으로 보내고 `before_model.dense_timeout_ms`(기본 80 ms) 안에 답이 오면 어휘 결과와 RRF로 합칩니다. 늦거나 helper가 없으면 조용히 어휘 검색만 씁니다(에러 아님). 첫 호출은 helper 기동 중이라 보통 어휘만 씁니다.
- **worker 쪽**: 추출로 새 행이 생기면 `extract` 명령이 **별도 잠금 세션**에서 빈 행의 임베딩을 채웁니다(`passage: ` 접두어, 모델 로드는 잠금 밖에서 워밍업). `dream`도 백필합니다. 그러면 다음 스냅샷에 `dense.v1.bin`이 포함되고 helper가 그것을 읽습니다.
- **aliases**: 추출 스키마에 `aliases: string[]`(≤ 8, 한국어 포함)을 넣어 LLM이 "테스트 명령", "vitest", "pnpm test" 같은 별칭을 뽑게 했습니다. 스냅샷 토크나이저는 camelCase 분리 + 한국어 조사(을/를/은/는/이/가/에서/으로…) 제거를 해서 "테스트를"로도 "테스트"가 잡힙니다.
- **기본은 off**입니다(`embeddings.enabled: false`). `hm install --host claude --with-embeddings`가 `@xenova/transformers`를 설치하고 켭니다. 모델(130 MB)은 `~/.harness-memory/models/`에 캐시됩니다(기존 v0.5 캐시를 그대로 옮겨 둠).
- PreToolUse에서는 끝까지 dense를 쓰지 않습니다. 시그니처가 있는 메모리는 어차피 토큰/glob 매칭이 정확하고, 없는 pitfall/policy는 scope 교차로 잡히며, 90 ms 예산 안에 임베딩 왕복을 넣으면 Windows에서 안정적으로 지키기 어렵습니다.

---

## 8. 설정 (`.harness-memory/config.json`, 전부 선택)

```jsonc
{
  "autonomy_level": "standard",          // off | shadow(기록만) | standard
  "before_tool":  { "max_items": 3, "max_bytes": 2048, "auto_enforcement": "soft_deny", "hard_policy": "confirm" },
  "before_model": { "max_items": 5, "max_bytes": 3072, "min_score": 0.35, "dense": "helper", "dense_timeout_ms": 80 },
  "session_start": { "max_items": 5, "max_bytes": 3072 },
  "after_tool":   { "max_items": 2, "max_bytes": 1024 },
  "extraction": { "provider": "auto", "model": null, "max_runs_per_day": 40,
                  "max_auto_activations_per_day": 10, "max_auto_activations_per_episode": 3,
                  "timeout_ms": 120000, "probe_timeout_ms": 20000, "lease_seconds": 180 },
  "embeddings": { "enabled": false, "model": "Xenova/multilingual-e5-small", "idle_exit_minutes": 15, "cache_dir": null },
  "dream": { "interval_hours": 6 },
  "retention": { "ledger_days": 14, "raw_hours": 24, "audit_days": 30, "candidate_days": 45, "proposal_days": 30 },
  "log": { "debug": false, "max_bytes": 5242880, "rotations": 3 }
}
```

환경 변수: `HARNESS_MEMORY_DISABLE=1`(훅 전부 끄기), `HARNESS_MEMORY_DEBUG=1`(hooks.log에 전체 JSON), `HARNESS_MEMORY_PROVIDER=claude|codex|replay`, `HARNESS_MEMORY_CLAUDE_BIN`, `HARNESS_MEMORY_HOME`.

---

## 9. 직접 써보는 법

```bash
cd ~/harness-memory-repo && npm install && npm run build
cd <대상 프로젝트>
node ~/harness-memory-repo/dist/bin/harness-memory.js install --host claude     # 또는 npm link 후 hm install --host claude
claude            # 한 번 실행해 /login (추출 provider가 이 CLI를 씁니다)
# Claude Code에서 평소처럼 작업. 교정("아니 …말고", "기억해")·실패 뒤 성공이 있는 턴만 추출됩니다.
hm status         # 한 줄 요약 + probe 안내
hm doctor         # 설치·훅 로그·큐·잠금·DB·스냅샷 교차 점검 (--fix로 node 경로/스냅샷 복구)
hm memory:list / memory:show <id> / memory:why --tool Bash --target "npm test"
hm review         # 제안·후보·미확인 import 일괄 처리
hm uninstall      # 매니페스트에 적힌 것만 되돌림 (--purge 는 .harness-memory/ 삭제, .bak-v* 는 남김)
```

설치가 등록하는 훅은 exec form(`command` + `args`)입니다. Claude Code가 2.1.139보다 오래되었거나 훅이 실행되지 않으면 `hm install --hook-form shell`로 셸 문자열 형태로 다시 등록하세요. `hm doctor --host-debug <claude debug 로그>`가 호스트가 훅을 실제로 불렀는지 확인해 줍니다.

---

## 10. 알려진 한계와 미검증 항목 (솔직하게)

1. **실제 `claude -p` 추출을 이 머신에서 돌려 보지 못했습니다.** CLI가 로그인되어 있지 않습니다. `--tools ""`와 `--json-schema`의 공존, 중첩 실행 거부 문구(`nested_refusal` 정규식은 추정) 등은 로그인된 머신에서 첫 dogfood 때 확인해야 합니다. 실패하면 `hm status`가 상태를 말해 주고 episode는 큐에 남습니다(데이터 유실 없음).
2. exec-form 훅의 최소 버전(≈ 2.1.139)은 문서·변경 로그에서 추론한 값입니다. `--hook-form shell`이 탈출구입니다.
3. Codex 호스트 어댑터(0.6.1)와 OpenCode V2(0.6.2)는 미포함. Codex **provider**(`codex exec --json`)는 포함되어 있으나 Codex가 설치되지 않아 미검증.
4. Windows에서 worker 재귀 방지의 2차 가드(ppid 체인)는 no-op입니다. 1차 가드(`HARNESS_MEMORY_DISABLE=1`)가 모든 플랫폼을 막습니다.
5. 임베딩 helper의 dense 왕복 기본 80 ms는 이 PC 기준 추정입니다. 느린 CPU에서는 자주 늦어 어휘 검색만 쓰게 됩니다(동작은 정상). `before_model.dense_timeout_ms`로 조정.
6. `hm install --with-embeddings`의 실제 `npm install @xenova/transformers`는 seam 테스트만 했습니다.
7. 이웃 탐색(Jaccard)은 타입별 전체 스캔입니다. 수천 행까지는 문제없지만 색인은 없습니다.
8. 한 호스트가 UserPromptSubmit을 한 턴에 두 번 쏘면 before_model도 두 번 돕니다(ledger 쪽 가드 없음).

---

## 11. 미뤄 둔 것 / 다음 단계

- 0.6.0 릴리스: `redesign/v0.6`를 GitHub에 푸시 → PR → `master` 병합 → `npm publish`. **푸시는 하지 않았습니다**(당신 확인 뒤에).
- 0.6.1: Codex 호스트 어댑터(`notify` 훅 기반), `eval:live`.
- 0.6.2: OpenCode V2 플러그인 어댑터(기존 사용자 이전 경로).
- 로그인된 머신에서 첫 dogfood 후 `nested_refusal` 문구, 추출 프롬프트 품질, aliases 품질 튜닝.

---

## 12. 산출물과 수치

- 브랜치 `redesign/v0.6` (로컬 `C:\Users\choey\harness-memory-repo`). 커밋: Phase 0 `4bfb770` → A `894c73f` → B `6e1b680` → `c7a802a` → C/D (아래 갱신).
- 문서: `docs/redesign/spec-v0.6.md`(설계 명세, 15장), `core-review-v0.5.md`(v0.5 결함 분석), `implementation-plan.md`(단계·파일 소유권), `m0-facts.md`(호스트 실측 사실), `phase-a/b/c-notes.md`(모듈별 API·요청·명세 이탈 기록), `upgrade-from-0.5.md`, `CHANGELOG.md`.
- 품질 게이트 (최종 수치는 Phase D 뒤 갱신):
  - `tsc --noEmit`: 0 errors
  - `vitest`: 58 files / 762 tests (Phase B 통합 시점)
  - `npm run build`: dist/hook.js 0.3 KB, hook-bundle.js 148 KB, worker.js 357 KB, embed-helper.js 21 KB, bin 293 KB
  - 훅 지연: 임시 프로젝트 실기 8회 p95 9 ms(훅 내부 측정, Node 기동 제외); `eval:latency`(프로세스 포함 50회, 300 메모리) 수치는 아래 갱신
