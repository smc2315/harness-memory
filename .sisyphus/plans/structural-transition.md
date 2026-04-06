# GPT Pro 구조 전환 작업 지시서 v2

**Status**: Ready for implementation
**Created**: 2026-04-06
**Revised**: 2026-04-06 (blocker 5건 수정 반영)
**Source**: GPT Pro 설계 + 코드 분석 검증 + Oracle 아키텍처 검토 + GPT Pro blocker 리뷰
**Baseline**: 293/297 tests pass (4 aspirational), CodeMemo overall ~50%

## 핵심 원칙 (v2 수정)

> evidence retention은 넓게, candidate creation은 보수적으로.
> regex front-gate 제거는 "candidate 대량 생성"이 아니라 "evidence 보존 확대"다.
> reconciler가 붙기 전까지 candidate 폭을 넓히지 않는다.

## Milestone 구조 (v2 수정)

기존 #0~#6 개별 작업을 3개 milestone로 재편:

| Milestone | 내용 | 포함 작업 |
|-----------|------|----------|
| **P0** | Evidence Retention + Reconciliation Foundation | 기존 #0 + #2 합침 |
| **P1** | Hierarchical Retrieval + Activation Modes | 기존 #1 + #3 합침 |
| **P2** | Benchmark + Review UX + README | 기존 #4 + #5 + #6 |

실행 순서: **P2(벤치마크 계기판) → P0 → P1 → P2(Review UX + README)**
(P2의 벤치마크 부분만 먼저 해서 before/after 측정 기반 확보)

---

## 공통 제약 조건

```
- ESM only, TypeScript strict
- sql.js 유지 (no native deps)
- @xenova/transformers는 tsup external
- 보안 스캐너(src/security/scanner.ts)는 건드리지 않음
- type error 억제(as any, @ts-ignore) 금지
- MemoryType union은 건드리지 않음 (session_summary를 새 type으로 추가하지 않음)
- afterTool() hot path에 embedding 계산 넣지 않음
```

### 테스트 전략 (v2 수정 — "안 깨뜨림"이 아니라 명시적 분류)

**의도적으로 수정할 테스트:**
- `test/dream-worker.test.ts` — threshold/deferred 관련 assertion (~17개)
  현재 "score 1.3 → deferred" 검증 → 새 evidence state machine에 맞게 재작성
- `test/benchmark/hm-activation.test.ts` — materialization 개수 관련 일부 assertion
- `test/benchmark-tier2/02-first-turn-hit.test.ts` — deferred 참조 assertion

**절대 건드리지 않을 테스트:**
- promotion/safety: `hm-promotion.test.ts`, `hm-safety.test.ts`
- injection blocking: security scanner 관련 전부
- activation budget: budget enforcement 관련 전부
- DB schema invariants: migration, repository 관련 전부
- canary set: `canary-set.test.ts` (regression guard)

**새로 추가할 테스트:**
- Evidence retention: retained evidence 증가 확인
- Materialization restraint: retained evidence 늘어도 candidate 수 급증 안 함
- Summary layer retrieval: session/topic summary가 raw memory보다 먼저 hit
- Reconciler: reinforce/supersede/stale 동작
- E2E pipeline smoke: Evidence → Dream → Candidate → Activation 전체

---

## P0. Evidence Retention + Reconciliation Foundation

> 기존 #0(regex front-gate 제거)과 #2(dream reconciler)를 하나의 milestone로 합침.
> candidate 생성을 늘리는 변경과 candidate 정리를 동시에 넣어야 쓰레기장이 안 됨.

### 문제 (코드 분석으로 검증됨)

현재 파이프라인:
```
Tool Output → Evidence Event → scoreEvents() [regex scoring]
  → shouldMaterializeCandidate(threshold=1.55) [HARD GATE] → Candidate
```

**수학적 증명:**
- 단일 workflow evidence (키워드 없음): salience=0.45 + novelty=0.80 = aggregate **1.25 < 1.55** → DEFERRED
- 단일 pitfall ("error" + path): 0.70 + 0.80 + 0.15 + 0.05 = **1.70 ≥ 1.55** → MATERIALIZED
- **결론**: 단일 workflow/decision/architecture evidence는 70-100% 차단됨

**adapter/worker regex 불일치:**
- adapter estimateDreamSalience: 7 keywords (includes "created", "updated")
- worker scoreEvents successBoost: 5 keywords (missing "created", "updated")

**Dream action 분포:**
- Worker: 100% create/update, 0% reinforce/supersede/stale
- LLM extraction: 40/35/15/10 split이지만 gate 조건(≥3 batch, ≥1h, ≥2 sessions)이 까다로워 잘 안 돌아감

### 목표 구조

```
BEFORE:
Evidence → [regex scoring] → [threshold 1.55] → Candidate (or DEFERRED → DISCARD)

AFTER:
Evidence → [noise filter] → Retained Pool → [structural grouping (batch)]
  → [dream consolidation: reconcile-first] → Candidate (Tier 1/2만)
                                            → Latent Evidence (Tier 3 — candidate 아님)
```

**핵심 차이**: Tier 3(단일 evidence, signal 없음)는 candidate가 아니라 **latent evidence**로 남긴다.
Reconciler가 나중에 latent evidence를 reinforce/merge/promote할 수 있지만, 지금은 candidate pool에 안 들어감.

### P0-A. Evidence State Machine 도입

현재 evidence states: `pending | deferred | consumed | discarded`

변경:
```typescript
type DreamEvidenceStatus =
  | 'pending'      // 방금 캡처됨, 아직 처리 안 됨
  | 'retained'     // noise filter 통과, broad pool에 보존됨
  | 'grouped'      // structural grouping 완료, cluster 할당됨
  | 'materialized' // Tier 1/2 → candidate memory로 생성됨
  | 'latent'       // Tier 3 → candidate는 아니지만 보존됨, 후속 dream에서 재활용 가능
  | 'consumed'     // 기존 호환: candidate 생성에 사용됨 (= materialized와 동일)
  | 'discarded'    // noise이거나 TTL 만료

// latent evidence TTL
const LATENT_EVIDENCE_TTL_DAYS = 14; // 14일 후 자동 discard
```

**핵심**: `retained` → `grouped` → `materialized` OR `latent` 순서.
Latent evidence는 14일 TTL 후 자동 discard. Candidate 폭발 방지.

### P0-B. 맨앞단 — 노이즈 필터 (구조적 체크, regex 아님)

regex는 여기서 역할이 없다. 구조적 체크만:
- `excerpt.length < 20` → 길이 체크
- `hash(excerpt)` 중복 → 같은 session 내 동일 해시 제거
- `output === null || output === ''` → 빈 출력 제거

통과한 evidence는 전부 `retained` state로 저장.
**"저장할 가치가 있나"는 여기서 판단하지 않는다.**

### P0-C. Regex → Signal Tag 변환

현재 regex가 하는 일: evidence를 scoring해서 threshold gate 통과 여부 결정
변경: regex는 evidence에 **metadata tag만 붙임**, gate 역할 안 함

```typescript
// evidence metadata에 저장되는 signal tags
type SignalTag =
  | 'failure_signal'      // /error|failed|exception|timeout|refused/i
  | 'success_signal'      // /passed|resolved|fixed|completed|migrated|created|updated/i
  | 'decision_signal'     // /decided|chose|switched|replaced|deprecated|changed.*to/i
  | 'convention_signal'   // /always|never|convention|must|should|standard|rule/i
  | 'architecture_signal' // /architecture|boundary|layer|component|module|structure/i
  | 'temporal_cue'        // /before|after|previously|used to|switched from/i
  | 'explicit_marker'     // /do not|always use|fixed by|known error/i
  | 'has_file_context';   // /path|file|src\//i in argsJson
```

Tag는 evidence의 `metadata_json`에 저장. Dream consolidation의 HINT로 사용.
**절대 entry criteria 아님.**

Regex의 3가지 뒤단 역할 (GPT Pro 원문):
1. **Signal Tag** (위) — dream consolidation hint
2. **Safety Scan** (src/security/scanner.ts) — candidate→active 승격 시 blocking. 변경 없음.
3. **Routing Hint** (activation engine) — temporal/cross-session 분기. P1에서 구현.

### P0-D. Evidence Grouping (batch에서만, hot path 금지)

**afterTool()에서는 grouping 안 함.** evidence 저장만 하고 끝.

Grouping은 **dream worker.run() 또는 idle/full-dream batch**에서만 실행:

**단계 1: Cheap pre-group (구조적)**
1. session/time adjacency — 같은 session, 5분 이내 연속 이벤트
2. path/module — 같은 scopeRef 또는 같은 디렉토리 prefix
3. tool — 같은 tool 연속 사용
4. topic key — typeGuess:scopeRef (보조 기준)

**단계 2: Expensive semantic merge (필요한 후보에만)**
5. lexical overlap — BM25 기반, 같은 structural group 내에서 excerpt 유사도 체크
   (MiniSearch 이미 존재: src/activation/lexical.ts)
6. embedding similarity — 같은 structural group 내 대표 excerpt끼리만 cosine similarity ≥ 0.75
   (EmbeddingService 이미 존재: src/activation/embeddings.ts)

**순서: cheap pre-group → expensive semantic merge**
embedding은 그룹 대표끼리만 계산. 전체 evidence에 embedding 계산하지 않음.

### P0-E. Dream Consolidation — Tier 분류 + Candidate 보수적 생성

grouped evidence를 Tier 분류:

| Tier | 조건 | 결과 | confidence |
|------|------|------|------------|
| **Tier 1** | 3+ events, 또는 failure_signal + has_file_context | **candidate 생성** | 0.8+ |
| **Tier 2** | 2 events, 또는 signal tag 1개 이상 | **candidate 생성** | 0.6 |
| **Tier 3** | single event, signal tag 없음 | **latent evidence** (candidate 아님) | N/A |

**Tier 3는 candidate를 만들지 않는다.** `latent` state로 보존만 하고, 14일 TTL.
후속 dream run에서 새 evidence와 매칭되면 Tier 2/1로 승격 가능.

### P0-F. Dream Reconciler (create-first → reconcile-first)

Dream의 KPI: 기존 memory를 reinforce / supersede / stale / prune

**Action 우선순위: reinforce > supersede > stale > create**

**A. At-risk memory 조회** (worker.run() 시작 시):
- active이지만 lastVerifiedAt > 7일 전
- active이지만 confidence < 0.7
- contradictionSignal이 있는 evidence와 연관된 memory

**B. At-risk memories를 새 evidence groups와 매칭:**
- 같은 (type, scopeRef) 매칭 → **reinforce** (confidence +0.05, lastVerifiedAt 갱신)
- 모순 evidence → **supersede** (기존 memory stale, 새 candidate 생성)
- 관련 evidence 없고 14일 이상 → **stale**

**C. Dream 입력 확장** (GPT Pro 원문):
- recent evidence + at-risk memories를 같이 받기
- drift/stale 위험 memory
- 최근 활성화됐지만 재검증 안 된 memory
- contradiction 후보

**D. Action Distribution 텔레메트리:**
```typescript
interface ActionDistribution {
  create: number;
  reinforce: number;
  supersede: number;
  stale: number;
  latent: number;  // Tier 3로 보존된 evidence 수
  skip: number;
}
```
- dream run마다 로깅
- create 비율 > 70%이면 경고

**E. Startup Pack 재생성:**
- full-dream 완료 시 baseline + 가장 자주 활성화된 Top-5 memories
- activationClass를 동적 갱신 (startup 승격/강등)

**F. Gate 조건 완화** (src/cli/dream-extract.ts):
- 현재: ≥3 batch, ≥1h, ≥2 sessions
- 변경: ≥2 batch, ≥30min, ≥1 session

### P0 변경 파일

| 파일 | 변경 내용 |
|------|----------|
| `src/dream/worker.ts` | shouldMaterializeCandidate → Tier 분류로 교체, scoreEvents → signal tag 생성, structural grouping 추가, reconciliation phase 추가 |
| `src/dream/types.ts` | DreamEvidenceStatus에 'retained'/'grouped'/'materialized'/'latent' 추가, SignalTag type 추가, ActionDistribution 추가 |
| `src/dream/repository.ts` | latent evidence TTL cleanup 쿼리, at-risk memory 쿼리, metadata_json signal tag 지원 |
| `src/adapters/opencode-adapter.ts` | inferDreamTypeGuess → hint_type으로 격하 (metadata), afterTool()은 signal tag 부착만 |
| `src/db/schema/types.ts` | DreamEvidenceStatus에 새 상태 추가 (MemoryType은 변경 없음!) |
| `src/cli/dream-extract.ts` | gate 조건 완화 |
| `src/promotion/auto-promoter.ts` | revalidateMemory() 활용 |
| `test/dream-worker.test.ts` | threshold/deferred assertion을 새 evidence state machine에 맞게 재작성 |

### P0 테스트

- 단일 workflow evidence (키워드 없음) → **latent** (이전: DEFERRED, candidate 아님!)
- 2개 workflow evidence (같은 group) → **Tier 2 candidate** 생성
- 3+ evidence with failure_signal → **Tier 1 candidate** 생성
- Latent evidence 14일 후 → 자동 discard
- Latent evidence + 새 evidence 매칭 → Tier 2로 승격
- Noise filter: empty/short/duplicate 차단
- Reconciler: 반복 evidence → reinforce (duplicate 아님)
- Reconciler: 모순 evidence → supersede
- Reconciler: 오래된 + 미검증 → stale
- Action distribution 로깅 동작
- **E2E pipeline smoke**: Evidence → Retained → Grouped → Materialized → Candidate → Activation
- Evidence retention rate: 현재 ~30% → 목표 >90% (retained 기준)
- Candidate 수: 대폭 증가하지 않음 (Tier 1/2만 materialize)

---

## P1. Hierarchical Retrieval + Activation Modes

> 기존 #1(hierarchical retrieval)과 #3(activation 4-mode)를 합침.
> P0의 retained evidence pool + session summaries를 활용한 retrieval 구조 전환.

### Hierarchical Retrieval v2

**문제:**
```
현재: Query → [Dense Top-40] + [BM25 Top-40] → RRF Fusion → Top-K
CodeMemo: Temporal 14.3%, Cross-Session 0-43%, Overall ~50%
```

**목표 구조 — 3층 (GPT Pro 설계):**
```
Query Router (default / temporal / cross-session)
     │
     ├─ Default: 기존 flat retrieval 유지
     ├─ Temporal: session summaries → time-ordered evidence drill-down
     └─ Cross-Session: session summaries → diverse session selection → per-session evidence
```

### 핵심 아키텍처 결정 (v2 수정 — 별도 테이블)

**MemoryType에 'session_summary'를 추가하지 않는다.**
별도 retrieval 테이블로 분리:

```sql
CREATE TABLE session_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  summary_short TEXT NOT NULL,    -- ≤50 tokens, 핵심 키워드
  summary_medium TEXT NOT NULL,   -- ≤200 tokens, 구조화된 요약
  embedding BLOB,                 -- 384d vector (multilingual-e5-small)
  source_event_ids TEXT NOT NULL, -- JSON array of evidence event IDs
  tool_names TEXT NOT NULL,       -- JSON array of tools used
  type_distribution TEXT NOT NULL, -- JSON: {workflow: 5, pitfall: 2, ...}
  event_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE topic_summaries (
  id TEXT PRIMARY KEY,
  canonical_topic TEXT NOT NULL,
  summary_short TEXT NOT NULL,
  summary_medium TEXT NOT NULL,
  embedding BLOB,
  supporting_session_ids TEXT NOT NULL, -- JSON array
  source_event_ids TEXT NOT NULL,       -- JSON array
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_session_summaries_session ON session_summaries(session_id);
CREATE INDEX idx_topic_summaries_topic ON topic_summaries(canonical_topic);
```

**이점**: 기존 MemoryType 생태계(15개 파일, 123 참조)를 건드리지 않음.
Memory store는 그대로. Summary layer는 retrieval 보조 구조.

### Session Summary 생성

- **트리거**: session.compacted 2회 이상 발생, 또는 4시간 비활성 후
  (session.idle 직후가 아님 — 세션이 재개될 수 있으므로 Oracle 권고)
- **입력**: 해당 session의 dream_evidence_events (retained/consumed 포함)
- **LLM 없이 heuristic 생성:**
  - evidence를 typeGuess별 group
  - top topics를 topicGuess에서 추출
  - 사용된 tools 목록
  - category별 evidence count
  - 구조화된 텍스트로 format
- **embedding**: summary_medium에 대해 EmbeddingService로 생성 (batch, not hot path)

### Topic Summary 생성 (v2에서는 skeleton만)

- v1: session_summaries만 구현 (80% 효과)
- v2: topic_summaries 테이블은 생성하되, 생성 로직은 stub만
- 향후: 동일 canonical_topic을 가진 session_summaries를 cross-session 병합

### 2-Pass Retrieval

| Mode | Pass 1 | Pass 2 | Context 조립 |
|------|--------|--------|-------------|
| **Default** | 기존 flat retrieval (변경 없음) | N/A | relevance score순 |
| **Temporal** | session_summaries에서 Top-5 관련 session 선택 | 선택된 session의 evidence를 created_at ASC 정렬 | 시간순 |
| **Cross-Session** | session_summaries에서 Top-8 선택 (min 3 unique sessions) | per-session top evidence chunks | session header 포함, session별 그룹 |

### Query Router

```typescript
function classifyQueryType(text: string): 'default' | 'temporal' | 'cross_session' {
  if (/\b(when|changed|before|after|history|evolution|switched|timeline|순서|변경|이전|이후)\b/i.test(text))
    return 'temporal';
  if (/\b(across sessions?|different sessions?|always|every time|consistently|매번|항상)\b/i.test(text))
    return 'cross_session';
  return 'default';
}
```
Router는 **hint**, hard gate 아님.

### Activation 4-Mode 분기

**ActivationRequest 확장:**
```typescript
activationMode?: 'startup' | 'default' | 'temporal' | 'cross_session'
```

**Mode별 동작:**
- **startup**: Layer A baseline + session_summaries에서 most-activated 우선. Layer C/D 스킵.
- **default**: 현재 4-layer 동작 그대로 (변경 없음).
- **temporal**:
  - session_summaries 있으면 → 2-pass retrieval
  - 없으면 (graceful degradation) → updatedAt DESC 정렬, 최근 memory boost
  - includeSuperseded=true 내부 설정
  - Layer D exploration slot 스킵
- **cross-session**:
  - session_summaries 있으면 → diverse session retrieval
  - 없으면 → top-k에서 sessionId diversity 강제
  - Layer D에서 type diversity 대신 session diversity boost

**before_tool hook 강화:**
- 현재: relevant_tools 불일치 → 제외 (binary)
- 변경: relevant_tools 일치 → score boost +0.15 (soft signal)

**Graceful Degradation (Oracle 권고):**
session_summaries가 없는 상태에서도 동작해야 함.
temporal/cross-session mode는 summary 없이도 합리적 fallback 제공.

### P1 변경 파일

| 파일 | 변경 내용 |
|------|----------|
| `src/db/schema/types.ts` | DreamEvidenceStatus 변경은 P0에서 완료. MemoryType 변경 없음. |
| DB migration | session_summaries, topic_summaries 테이블 + 인덱스 생성 |
| 새 파일: `src/retrieval/summary-repository.ts` | session_summaries/topic_summaries CRUD |
| 새 파일: `src/retrieval/summary-generator.ts` | heuristic summary 생성 |
| 새 파일: `src/retrieval/query-router.ts` | classifyQueryType() |
| `src/activation/engine.ts` | mode routing, 2-pass retrieval, session summary 조회 |
| `src/activation/types.ts` | ActivationRequest에 activationMode 추가 |
| `src/adapters/opencode-adapter.ts` | beforeModel에 mode classification, before_tool boost |
| `src/plugin/opencode-plugin.ts` | session 종료 시 summary 생성 트리거 |

### P1 테스트 + 기대 효과

| Benchmark | 현재 | 기대 |
|-----------|------|------|
| CodeMemo Temporal | 14.3% | 40-60% |
| CodeMemo Cross-Session | 0-43% | 30-50% |
| CodeMemo Overall | ~50% | 55-65% |
| HM-TimelineBench | 2 fail | 0 fail |

추가 테스트:
- default mode → 기존과 동일한 결과 (regression 없음)
- startup mode → session summaries + most-activated 우선
- temporal mode → 시간순 정렬, superseded 포함
- cross-session mode → session diversity 강제
- fallback: session summary 없을 때도 합리적 동작
- Summary layer retrieval: session summary가 raw memory보다 먼저 hit

---

## P2. Benchmark + Review UX + README

### P2-A. 벤치마크 계기판 분리 (먼저 실행)

**레이어별 메트릭 분리:**

| 레이어 | 메트릭 | 벤치마크 |
|--------|--------|----------|
| Retrieval-only | P@K, R@K, MRR, NDCG, oracle recall | HM-Activation, Canary, CodeMemo oracle |
| Synthesis | answer accuracy, LLM judge score | CodeMemo J-score |
| Extraction | parser accuracy, action accuracy, type accuracy | HM-Extract |
| Promotion | gate accuracy, demotion rate, revalidation rate | HM-Promotion |
| Safety | block rate, false positive rate, category accuracy | HM-Safety |
| Product | precision, token efficiency, SNR, CLAUDE.md vs HM | HM-Product |
| Temporal | status filtering + ordering + progression | HM-Timeline |
| Scale | recall degradation curve | HM-Scale |

추가:
- Retrieval-only oracle metric (retrieval 문제 vs synthesis 문제 분리)
- 3-run median harness (median ± variance)
- Canary set MRR baseline 0.3954 (regression tolerance 90%)
- Candidate extraction benchmark skeleton
- Promotion benchmark B+ 메타데이터
- Product benchmark: CLAUDE.md / SKILL.md / harness-memory 비교
- HM-Timeline에 temporal REASONING tests 추가 (@aspirational, expect fail)

### P2-B. Review UX (inbox)

**Pending candidates inbox:**
- 세션당 한 번만 review digest
- type별 그룹핑, confidence/evidence count 표시
- quick actions: 모두 승인 / 하나씩 보기 / 나중에 / 모두 보류
- auto-promoted memory는 별도 "just happened" digest

**CLI 배치 작업:**
```bash
npx harness-memory memory:promote --all --min-confidence 0.85
npx harness-memory memory:reject --all --max-confidence 0.5
npx harness-memory memory:review --type workflow --sort confidence
```

**Review state tracking:**
- candidate age, review 시도 횟수 추적
- 30일 이상 미처리 candidate → auto-reject

### P2-C. README 포지셔닝

**핵심 메시지 재정렬 (GPT Pro 원문):**
- local-first / evidence-backed / small prompt packs / reviewable memory
- compact-project strong, large-project scaling in progress
- "Not an auto-collector" → "Auto-captures evidence signals, but materializes memories through a multi-gate pipeline"
- Evidence ≠ Memory 구분 명확화
- benchmark self-reported 범위 명시
- contributor CTA / feedback 섹션

---

## 해서는 안 되는 것 (GPT Pro 명시)

1. **flat retrieval 파라미터 미세튜닝** — dedup threshold, diversity cap, adaptive top-k 숫자 조정은 ROI 낮음
2. **"Claude dream 완전 재현"** — 필요한 건 재현이 아니라 우리 철학에 맞는 consolidation
3. **외부 마케팅 페이지** — 구조 안정화 먼저, 포지셔닝 나중에
4. **MemoryType union에 새 type 추가** — session_summary는 별도 테이블 (v2 추가)
5. **afterTool() hot path에 embedding 계산** — batch에서만 (v2 추가)
6. **모든 evidence를 candidate로 만들기** — Tier 3는 latent evidence (v2 추가)

---

## 검증 기준

각 milestone 완료 시:
1. `npx vitest run` → 의도적 수정 테스트 외 전부 pass
2. `lsp_diagnostics` → 변경 파일 zero errors
3. 해당 milestone의 새 테스트 pass
4. CodeMemo 점수 regression 없음 (applicable한 경우)
5. 변경 파일 목록과 diff 크기 보고
6. E2E pipeline smoke test pass (P0 이후)
