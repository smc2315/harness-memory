# harness-memory 코어 리뷰

대상: `smc2315/harness-memory` master (v0.5.1, 마지막 커밋 2026-04-09)
방법: 전체 소스 19k 라인 중 쓰기 경로(플러그인 훅, evidence, dream, LLM 추출, 승격)와 읽기 경로(활성화 엔진, 정책 엔진)를 정독하고, 추정한 결함은 재현 테스트로 검증했다. 기존 테스트 315개는 전부 통과한다.

## 0. 한 줄 요약

"제대로 동작 안 했던" 이유는 튜닝 문제가 아니라 배선 문제다. 쓰기 경로가 두 갈래로 갈라져 있고, 둘 중 어느 쪽도 활성화 엔진이 쓸 수 있는 형태의 메모리를 만들지 못한다. LLM 추출 경로는 scope와 lifecycle을 잃어버려서 제품의 핵심인 before_tool 경고에 절대 도달하지 못하고, 결정적 경로는 지식이 아닌 템플릿 문장을 저장한다. 여기에 추출 게이트가 프로세스당 한 번만 열리고, 자동 승격은 LLM 후보에 대해 구조적으로 0건이며, 중복 추출 한 번이면 전체 배치가 영구 재시도 상태로 남는다. 각각은 작지만 겹치면 "아무것도 저장되지 않는" 체감으로 나타난다.

## 1. 현재 쓰기 경로의 실제 모양

```
[훅: tool.execute.after]
   ├─ (A) adapter.afterTool
   │      regex typeGuess/topicGuess → dream_evidence_events (툴 호출 1건 = 1행)
   │      + 활성화된 메모리마다 evidence 행 추가 (2KB excerpt)
   │      → DreamWorker.run 은 CLI `dream:run` 에서만 호출됨. 플러그인은 호출 안 함.
   │        → 후보 생성 시 summary = "Pitfall around route.ts (pitfall:...:enoent)" 같은 템플릿
   │
   └─ (B) ConversationBuffer.push (툴 출력 300자로 절단)
          5 entries 마다 flush → "conversation-batch" evidence 1행 (scope ".", type "workflow", 4000자 cap)
          [훅: session.idle / session.compacted]
          → 게이트(pending>=2, 0.5h, sessions>=1, lock) 통과 시
          → OpenCode SDK 로 서버 새로 띄워 LLM 호출
          → facts → create(scope "**/*", lifecycle [before_model]) / reinforce / supersede / stale 즉시 적용
          → runAutoPromotionCycle (evidence>=3 요구)
```

두 경로는 스키마도, 상태도 공유하지 않는다. (A)는 (B)의 배치를 먹어버릴 수 있고(R7), (B)가 만든 메모리는 (A)가 쌓은 evidence와 연결되지 않는다(R1).

## 2. 재현으로 확인한 결함

재현 테스트는 클론한 사본의 `test/zz-repro*.test.ts` 에 두었다. 전부 현재 코드에서 재현된다.

| ID | 증상 | 위치 | 효과 |
|----|------|------|------|
| R1 | LLM이 만든 후보는 자동 승격 불가. `listEvidence()` 가 항상 0 | `llm-extract.ts` create 분기가 evidence link를 만들지 않음. `auto-promoter.ts:121` 은 `evidence` 테이블만 봄 | 자동 승격은 B+ 모델 문서와 달리 실제로는 0건. 후보는 30일 뒤 자동 reject |
| R2 | LLM이 만든 메모리는 `scopeGlob "**/*"`, `lifecycle ["before_model"]` 고정 | `llm-extract.ts:347-349` | before_tool 트리거에서 `trigger_mismatch` 로 전부 억제. 제품의 wedge(툴 경계 경고)에 LLM 지식이 한 건도 도달하지 못함 |
| R3 | 추출이 프로세스 수명당 1회만 실행 | `dream-extract.ts:39` `DEFAULT_MIN_SESSIONS=1`. 추출 성공 후 `sessionsSinceLastExtract=0` 리셋 (`opencode-plugin.ts:1119`), 증가는 플러그인 init 에서만 (`:796`) | 긴 세션에서는 첫 idle 이후 아무것도 추출되지 않음 |
| R4 | LLM `supersede`/`stale` 이 사람이 승인한 active 메모리를 리뷰 없이 즉시 제거 | `llm-extract.ts:430-447, 483-485` | 생성은 리뷰를 거치는데 삭제는 안 거침. 환각 한 번이면 승인 메모리가 사라지고 대체물은 후보로만 남아 활성 0건 |
| R5 | 동일 fact 재추출 시 `DuplicateMemoryContentError` throw | `memory/repository.ts` create. `llm-extract.ts` 는 catch 안 함 | 배치 전체 실패 → `markEvidenceEventsConsumed` 미도달 → 같은 배치가 영구 재시도. 이미 적용된 앞쪽 fact 는 메모리에만 남아 다음 saveDb 때 섞여 들어감 |
| R6 | DreamWorker 후보의 summary/details 가 템플릿 문장 | `worker.ts:105-160` | 주입돼도 모델에게 아무 정보가 없음. "Pitfall around X (topic)" |
| R7 | 수동 `dream:run` 이 conversation-batch 를 workflow 후보로 소비 | `dream/repository.ts:290` 가 toolName 필터 없음 | LLM 추출 큐가 비어버림. 두 경로가 서로의 입력을 파괴 |

코드 정독으로 확인했지만 재현 테스트는 쓰지 않은 설계 결함:

| ID | 내용 | 위치 |
|----|------|------|
| D1 | 플러그인이 sql.js DB를 메모리에 들고 툴 호출마다 파일 전체를 덮어씀. 다른 터미널에서 `memory:review` 로 승인한 결과는 다음 saveDb 때 사라짐. 감지는 bash 툴 출력에 "harness-memory" 문자열이 있을 때만 | `opencode-plugin.ts:688-692, 756-782, 1407` |
| D2 | 추출 프롬프트가 요구하는 것이 "사용자 선호, 아키텍처 결정, 제약, 워크플로우" 라는 mem0 식 사실 목록. 출력 스키마에 scope, relevant_tools, trigger, 명령 시그니처가 없음. 활성화 모델이 요구하는 필드를 추출이 생산하지 않음 | `llm-extract.ts:54-103` |
| D3 | 저장 트리거가 "5 entries" 라는 개수 기준. 툴 출력 300자, 배치 4000자 절단. 세션 경계 무시(마지막 entry 의 sessionId 로 배치 귀속). 작업 완료, 실패 해결, 사용자 교정 같은 의미 경계가 전혀 반영 안 됨 | `opencode-plugin.ts:348-349, 418-435` |
| D4 | `reinforce` 가 `revalidateMemory` 를 호출하지 않아 TTL 연장이 일어나지 않음. 자동 승격 메모리는 강화돼도 14일에 죽음 | `llm-extract.ts:389-394`, `auto-promoter.ts:170` |
| D5 | 정책 엔진은 scope glob 매칭만 함. 툴 이름, 인자, 명령 패턴을 보지 않음. `policy_rules` 를 채우는 production 코드가 없음(fixtures CLI 뿐) | `policy/engine.ts:35-46` |
| D6 | 리뷰 인박스를 매 세션 system prompt 에 주입해 모델더러 사용자에게 언급하라고 지시 | `opencode-plugin.ts:266-335, 1289-1320` |
| D7 | 툴 호출마다 활성화된 메모리 수만큼 2KB excerpt evidence 행 생성 | `opencode-adapter.ts` afterTool |

문제 아닌 것: 활성화 핫패스. active 메모리 300개에서 before_tool activate() 가 호출당 약 18ms. 매 호출 전체 목록 조회와 MiniSearch 재구축을 하지만 이 규모에선 괜찮다.

## 3. 세 가지 질문에 대한 답

### 언제 저장할 것인가

개수 기준을 버리고 의미 경계로 간다. 저장 가치가 있는 순간은 세 가지뿐이다.

1. **교정 이벤트.** 툴 실패 직후의 사용자 메시지, 또는 "아니", "하지 마", "don't", "never", "instead" 류가 포함된 사용자 메시지. 가장 신호가 강하다. 캡처 범위는 직전 N개 툴 호출 + 교정 메시지.
2. **해결 이벤트.** 같은 scope 에서 실패 시그니처가 나타났다가 사라진 구간. 실패와 해결을 한 쌍으로 묶은 것이 pitfall 의 정의다. 지금은 실패만 regex 로 잡고 해결은 안 잡는다.
3. **턴 경계.** assistant 턴이 끝나는 시점(Stop)에 그 턴 전체를 하나의 에피소드로 닫는다. 5개 조각이 아니라 작업 단위로 추출기에 넘긴다. precompact 와 session end 는 flush 용.

그 외는 저장하지 않는다. dream 은 에피소드들 위에서 idle 때 도는 통합 패스로 남기되, 후보를 새로 만드는 주체가 아니라 중복 병합과 stale 판정만 한다.

### 트리거는 무엇인가 (Claude Code 기준)

| 목적 | 훅 | 하는 일 |
|------|----|---------|
| 주입 | UserPromptSubmit | before_model 활성화 + 교정 이벤트 감지 |
| 경고 | PreToolUse | scope + tool + 명령 시그니처로 pitfall/policy 매칭, systemMessage 로 경고 |
| 에피소드 축적 | PostToolUse, PostToolUseFailure | 실패 시그니처 기록, 해결 쌍 탐지 |
| 에피소드 닫기 | Stop | 턴 단위 추출 (LLM 1회, 교정/해결이 있었던 턴만) |
| 통합 | SessionEnd, PreCompact | dream: 병합, stale, TTL |

핵심 변경은 추출 입력이 "최근 5줄" 이 아니라 "scope, 툴, 실패 시그니처가 붙은 에피소드" 가 되는 것이다. 그래야 추출 출력에 scope 와 trigger 를 채울 수 있다.

### 사람 판단을 넣을 것인가

넣되, 지금과 반대 방향으로 비대칭하게. 요즘 모델은 "무엇을 기억할지" 는 충분히 잘 고른다. 사람이 필요한 곳은 추출 품질이 아니라 **권한**이다.

- **자동 활성화 (리뷰 없음):** pitfall, workflow 중 scope 와 trigger 가 붙어 있고 evidence 가 2건 이상인 것. 바로 active 로 올리되 `authority = auto` 로 표시하고 TTL 과 모순 시 자동 stale 을 적용한다. 이미 설계된 B+ 모델과 같은데, 배선이 끊겨 실제로는 한 번도 발동하지 않았다.
- **사람 게이트 (최소한):** (1) policy 타입, 즉 에이전트 행동을 바꾸는 규칙. (2) 사람이 승인한 메모리에 대한 supersede/stale. LLM 은 제안만 하고 적용은 못 한다. (3) scope 가 `**/*` 인 baseline 급 메모리.
- **리뷰 UX:** system prompt 에 인박스를 끼워 넣지 않는다. CLI 다이제스트 한 줄과 `memory:review` 로 충분하다. 리뷰는 예외 처리이지 매일 비워야 하는 받은편지함이 아니다.

## 4. 코어 재설계 제안 (v0.6)

쓰기 경로를 하나로 합친다.

```
Episode(턴 단위, scope/tools/failure-signature 포함)
  → Extract (LLM, 구조화 스키마: type, summary, details, scope_glob, relevant_tools,
             trigger_signature, lifecycle_triggers, confidence, evidence_refs)
  → Reconcile (결정적: identity + embedding 중복 → reinforce, 모순 → propose_supersede)
  → Activate (auto 티어 즉시 active / 사람 게이트는 review queue)
```

제거할 것:
- regex typeGuess/topicGuess 로 후보를 만드는 DreamWorker 경로. regex 는 salience 힌트와 실패 시그니처 추출로만 남긴다.
- ConversationBuffer 의 개수 기준 flush.
- `minSessions` 게이트. 게이트는 "닫힌 에피소드가 있는가" 하나면 된다.
- system prompt 리뷰 다이제스트.

스키마 변경:
- `episodes` 테이블 (session, turn, scope set, tool set, failure signatures, resolved flag, raw ref).
- `memories.trigger_signature` (tool + args glob/regex) 를 before_tool 매칭에 사용.
- `memories.authority` (human | auto) 와 `proposed_supersede_of`.

추출 provider 인터페이스: `claude -p`, `codex exec`, OpenCode SDK 를 같은 인터페이스 뒤에 둔다. 사용자 플랜을 그대로 쓰므로 키가 필요 없다.

동시성(D1): 플러그인 프로세스를 단일 writer 로 정하고 CLI 는 `.harness-memory/ops.jsonl` 에 연산을 append 한다. 플러그인이 다음 훅에서 saveDb 전에 ops 를 적용한다. 훅 기반 호스트로 가면 어차피 프로세스가 매번 새로 뜨므로, 그때는 "열기 → 적용 → 저장" 을 파일 lock 아래 짧게 하는 쪽이 맞다.

## 5. 하루면 되는 퀵 픽스 (재설계 전에라도)

| 결함 | 수정 |
|------|------|
| R1 | 추출 create 시 배치 evidence id 를 `dream_memory_evidence_links` 에 연결하고, auto-promoter 가 두 테이블을 합산 |
| R2 | 추출 출력 스키마에 scope_glob, relevant_tools, lifecycle_triggers 추가. 프롬프트에 파일 경로와 툴 이름을 함께 제공 |
| R3 | `minSessions` 게이트 제거 또는 idle 이벤트 수로 대체 |
| R4 | supersede/stale 은 `proposed_*` 상태로만 기록하고 적용은 리뷰 또는 auto 티어 대상에 한정 |
| R5 | `DuplicateMemoryContentError` 를 catch 해 reinforce 로 전환. 배치 consume 은 fact 단위 성공과 분리 |
| R7 | `listProcessableEvidenceEvents` 에서 `conversation-batch` 제외 (또는 worker 경로 삭제) |
| D4 | reinforce 분기에서 `revalidateMemory` 호출 |

## 6. 그대로 가져갈 것

활성화 엔진(하이브리드 검색, RRF, 예산, 타입 쿼터, 진행적 공개), 보안 스캐너, 마이그레이션 규율, audit/file 로거, 평가 인프라와 벤치마크, 어댑터 인터페이스 타입. 이 부분은 잘 만들어져 있고 테스트도 촘촘하다. 문제는 전부 "무엇이 들어오느냐" 쪽에 있다.

## 7. 권장 순서

1. 쓰기 경로 재설계 (에피소드 + 추출 스키마 + 단일 경로 + 권한 비대칭).
2. 퀵 픽스 묶음은 재설계에 흡수되지만, 재설계 전에 dogfooding 하려면 먼저 적용.
3. Claude Code / Codex 훅 어댑터.
4. 12 시나리오 코퍼스로 라이브 A/B.
