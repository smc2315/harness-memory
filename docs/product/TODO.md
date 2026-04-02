# TODO

이 문서는 harness-memory의 구현 상태와 미완료 작업을 추적한다.
Hermes Agent 분석, GPT Pro 리뷰, 내부 아키텍처 검토에서 도출된 항목을 포함한다.

마지막 업데이트: 2026-04-02

---

## 완료된 항목 (v0.3.1 → v0.4.0 예정)

### Tier 1 — 보안 + 활성화 정밀도 + 첫 턴

| 항목 | 상태 | 파일 |
|------|------|------|
| Security scanner (5개 threat category, 순수 함수) | ✅ | `src/security/scanner.ts` |
| Defense line 1: promote CLI에서 scan 후 block | ✅ | `src/cli/memory-promote.ts` |
| Defense line 2: adapter injection 시 unsafe memory 제거 | ✅ | `src/adapters/opencode-adapter.ts` |
| `relevant_tools_json` 컬럼 + Migration 011 | ✅ | `src/db/migrations/011_memory_relevant_tools.sql` |
| MemoryRecord/Create/Update에 `relevantTools` 필드 | ✅ | `src/memory/repository.ts` |
| Activation Layer C + Layer D exploration slot에 tool filter | ✅ | `src/activation/engine.ts` |
| Dream worker에서 evidence tool name → relevantTools 추론 | ✅ | `src/dream/worker.ts` |
| `memory:add --relevant-tools` CLI 지원 | ✅ | `src/cli/memory-add.ts` |
| `beforeTool()` async + activation with toolName | ✅ | `src/adapters/opencode-adapter.ts` |
| Plugin에서 `await adp.beforeTool()` 전파 | ✅ | `src/plugin/opencode-plugin.ts` |
| `memory:baseline` CLI (activation_class 설정) | ✅ | `src/cli/memory-baseline.ts` |
| `memory:promote --activation-class` 옵션 | ✅ | `src/cli/memory-promote.ts` |

### Tier 2 — 주입 품질 + 통합 품질

| 항목 | 상태 | 파일 |
|------|------|------|
| Progressive disclosure (full/summary/hint 3-tier) | ✅ | `src/adapters/opencode-adapter.ts` |
| `expandMemory()` 메서드 (security scan 포함) | ✅ | `src/adapters/opencode-adapter.ts` |
| Iterative re-compression (previousSummary 보존) | ✅ | `src/dream/worker.ts` |
| `DreamCandidateSuggestion.previousSummary` 필드 | ✅ | `src/dream/types.ts` |

### Tier 3 — 확장

| 항목 | 상태 | 파일 |
|------|------|------|
| `salience_boost` 컬럼 + Migration 012 | ✅ | `src/db/migrations/012_dream_evidence_salience_boost.sql` |
| Session `toolCallCount` 추적 + boundary nudge | ✅ | `src/adapters/opencode-adapter.ts` |
| Dream worker scoring에 `salienceBoostMax` 반영 | ✅ | `src/dream/worker.ts` |
| `memory:export-skill` CLI (SKILL.md 출력) | ✅ | `src/cli/memory-export-skill.ts` |
| Migration safety harness (v10→v12 테스트) | ✅ | `test/migrator.test.ts` |

### 테스트 현황

- 기존: 13 test files, 82 tests
- 현재: 18 test files, 145 tests (+63)
- 전부 통과, build 성공

---

## 미완료 항목

### Phase A — 조건부 자동 승격 (B+ 모델) ✅ 완료

모든 A-1~A-6 항목이 구현됨:
- Migration 013: promotion_source, ttl_expires_at, validation_count, policy_subtype
- MemoryRecord/UpdateMemoryInput 필드 추가
- Trust multiplier in calculateMemoryScore() (manual=1.0, auto+0=0.65, auto+1=0.80, auto+2+=0.95)
- TTL suppression in activation (ttl_expired 필터)
- Auto-promoter: 5-gate (security, confidence>=0.85, evidence>=3, type∈{pitfall,workflow}, policy 제외)
- Revalidation: validation_count++, TTL 14일 연장
- Contradiction demotion: 반대 evidence → immediate stale
- memory:demote CLI
- session.idle에서 dream extraction 후 auto-promote 호출

**배경**: 현재 모든 candidate→active 승격은 수동이다. 실전에서 `memory:promote`를 정기적으로 실행하는 사용자는 극소수이므로, 시스템이 실제로 학습하려면 조건부 자동 승격이 필요하다.

**합의된 모델**: B+ (상태 머신 유지 + provenance/review 메타데이터 추가)

#### A-1. 스키마 확장 (Migration 013)

새로운 필드를 memories 테이블에 추가:

```sql
ALTER TABLE memories ADD COLUMN promotion_source TEXT DEFAULT 'manual';  -- 'manual' | 'auto'
ALTER TABLE memories ADD COLUMN ttl_expires_at TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN validation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN policy_subtype TEXT DEFAULT NULL;  -- 'hard' | 'soft' | null
```

수정 대상:
- `src/db/schema/types.ts` — Memory 인터페이스에 필드 추가
- `src/memory/repository.ts` — CRUD + mapMemoryRow 업데이트
- `src/memory/utils.ts` — 직렬화/파싱 유틸
- `test/memory-core.test.ts` — round-trip 테스트

#### A-2. Trust multiplier를 activation scoring에 반영

```
trust_multiplier =
  manual                    → 1.0
  auto + validation_count=0 → 0.65
  auto + validation_count=1 → 0.80
  auto + validation_count≥2 → 0.95
```

적용 위치: `src/activation/engine.ts`의 `calculateMemoryScore()`에 trust_multiplier 곱하기.

Progressive disclosure와 자동 결합:
- trust 낮음 → 낮은 score → rank 8-10 → hint/summary만 주입
- trust 높음 → 높은 score → rank 1-5 → full details 주입

수정 대상:
- `src/activation/engine.ts` — scoring 함수
- `test/activation-engine.test.ts` — trust multiplier 테스트

#### A-3. Auto-promote 엔진

자동 승격 조건 (전부 AND):
1. `security scan` 통과
2. `confidence ≥ 0.85`
3. `evidence ≥ 3` (단일 관찰이 아닌 반복 확인)
4. `type ∈ {pitfall, workflow}` (1단계)
5. `policy`는 전부 수동 유지 (2단계에서 `policy_subtype=soft`만 허용)

실행 시점:
- `session.idle` hook에서 dream extraction 후
- 또는 `dream:extract` CLI 실행 후

수정 대상:
- `src/dream/worker.ts` 또는 별도 `src/promotion/auto-promoter.ts`
- `src/plugin/opencode-plugin.ts` — session.idle에서 auto-promote 호출
- `src/cli/dream-extract.ts` — extraction 후 auto-promote 실행
- 테스트

#### A-4. TTL 관리 + Revalidation

TTL 체크 두 군데:
1. **Background**: `session.idle` / dream worker에서 `ttl_expires_at < now` → stale 전이
2. **Activation query**: `WHERE (ttl_expires_at IS NULL OR ttl_expires_at > ?)` 조건

Revalidation:
- 같은 scope/topic에서 재확인 evidence → `validation_count++`, `ttl_expires_at` 연장
- 반대 evidence → 즉시 stale

기본 TTL: auto-promoted = 14일, 재확인 시 +14일 연장

수정 대상:
- `src/activation/engine.ts` — TTL 필터 추가
- `src/dream/worker.ts` — revalidation 시 validation_count 증가
- `src/plugin/opencode-plugin.ts` — TTL 만료 체크
- 테스트

#### A-5. Negative Evidence Demotion

반대 evidence 감지 시 즉시 stale로 전이.

조건:
- `workflow/pitfall`: 같은 scope/topic에서 반대 패턴 감지
- `policy_soft`: 명시적 user correction

수정 대상:
- `src/dream/worker.ts` — contradiction_signal 처리 강화
- 테스트

#### A-6. 알림 + Demotion UX

자동 승격 시:
- 콘솔 로그: `"[harness-memory] Auto-promoted: [type] summary"` 
- `memory:demote <id>` CLI 추가 (active → stale)
- `memory:why <id>` 에 promotion_source 표시

세션당 digest:
- system prompt에 "N개 memory가 자동 승격됨" 한 줄 추가
- 고위험 타입 (decision, architecture_constraint)만 candidate queue에 표시

수정 대상:
- `src/cli/memory-demote.ts` (신규 — memory-reject.ts 패턴 따르기)
- `src/cli/memory-why.ts` — promotion_source 표시 추가
- `src/plugin/opencode-plugin.ts` — digest 표시
- `src/bin/harness-memory.ts`, `tsup.config.ts`, `package.json` — 등록

---

### Phase B — promotion-rubric.md 업데이트

현재 `docs/spec/promotion-rubric.md`는 "자동 승격은 MVP에서 명시적으로 scope 밖"이라고 명시한다. Phase A 구현 후 이 문서를 업데이트해야 한다:

- "Future: Automatic Promotion" 섹션을 현재 구현으로 교체
- B+ 모델 설명 추가 (promotion_source, trust_multiplier, TTL)
- 타입별 자동 승격 정책 표 추가
- Manual Review Checklist를 "고위험 타입에 대해서만 수동 검토" 방향으로 수정

---

### Phase C — roadmap.md 업데이트

현재 `docs/product/roadmap.md`의 "Explicitly Deferred" 에 "autonomous promotion"이 있다. Phase A 구현 후:

- "autonomous promotion"을 deferred에서 제거
- Phase 3로 추가: "조건부 자동 승격 (B+ 모델) — 저위험 타입만, TTL 관리, trust multiplier"

---

### Phase D — 추가 개선 (필요 시)

이 항목들은 Phase A 이후 실제 사용 데이터를 보고 결정한다.

| 항목 | 설명 | 우선순위 |
|------|------|----------|
| `policy_subtype=soft` auto-promote | Phase A에서 workflow/pitfall만 열고, soft policy는 2단계에서 | 중간 |
| Cross-project 학습 | global.sqlite 활성화 경로에 auto-promote 적용 | 낮음 |
| Vector embedding 기반 semantic dedup | scope_glob의 근본 한계 보완 | 낮음 |
| 사용자별 auto-promote 설정 | `harness-memory.json`에 `autoPromote: { types: [...], minConfidence: ... }` | 중간 |
| review_state 필드 추가 | auto-promoted를 사람이 명시적으로 확인했는지 구분 | 중간 |
| Hermes 호환 context file import | `.hermes.md` / `AGENTS.md` / `.cursorrules` 읽기 | 낮음 |

---

## 참조

- Hermes Agent 분석: NousResearch/hermes-agent에서 memory/skills/trajectory compression 패턴 참조
- GPT Pro 리뷰: security scan, relevant_tools, startup pack, progressive disclosure, iterative re-compression, salience nudge, skill export 우선순위 협의
- B+ 모델 합의: 상태 머신 유지 + promotion_source/ttl/validation_count 메타데이터로 provisional 효과 구현
