# TODO

harness-memory 개선 작업 추적.
Tier 2 벤치마크 결과 + GPT Pro 리뷰 + 임베딩 모델 조사에 기반.

마지막 업데이트: 2026-04-03

---

## 완료된 항목

### v0.4.0 Feature Implementation (Tier 1-3)

12개 task 전부 완료. 18 test files, 145 tests, build 통과.

- Security scanner (dual defense: promote + inject)
- relevant_tools metadata + activation tool filtering
- Startup pack (memory:baseline CLI, beforeTool activation)
- Progressive disclosure (3-tier: full/summary/hint + expandMemory)
- Iterative re-compression (previousSummary in dream worker)
- Salience boundary nudge (toolCallCount + salienceBoost)
- Skill export CLI (memory:export-skill)
- Migration safety harness (v10→v12)

### v0.4.0 Auto-Promotion (B+ Model)

- Migration 013: promotion_source, ttl_expires_at, validation_count, policy_subtype
- Trust multiplier: manual=1.0, auto+v0=0.65, auto+v1=0.80, auto+v2+=0.95
- Auto-promote engine: security scan + confidence≥0.85 + evidence≥3 + type∈{pitfall,workflow}
- TTL 14일 + lazy check + background check
- Revalidation: validation_count++, TTL 연장
- Contradiction demotion: 반대 evidence → stale
- memory:demote CLI + session digest

### Tier 2 Benchmark Infrastructure

8 test files, 30 tests, 실제 multilingual-e5-small 모델 사용.

- 72 memories (3 domains × 24), 36 queries, 12 Korean memories
- 5 hard-negative groups across domains
- Dataset integrity validation (8 tests)
- Real embedding smoke test
- First-turn hit rate, cross-language, scope discrimination
- Hard-negative rejection, token efficiency, similarity distribution
- Tier 1 vs Tier 2 comparison with optimistic flags

---

## Tier 2 벤치마크 결과 요약

```
메트릭                        Tier 2 (real)          판정
──────────────────────────────────────────────────────
First-turn hit rate           0.92 (CI: 0.65-0.99)   ✅ 좋음
Hard-negative loss rate       7.7% (1/13)             ✅ 양호
KO→EN hit rate                0.75                    ✅ 쓸만함
Recall@5                      0.20                    ⚠️ 개선 필요
MRR                           0.25                    ⚠️ 개선 필요
EN→KO hit rate                0.25                    🔴 거의 불가
EN→KO Recall@5                0.00                    🔴 완전 실패
Domain purity (scoped)        55.6%                   ⚠️ 개선 필요
Token savings                 87.4% (86.1% cap효과)   ⚠️ ranking intelligence 1.3%만
Similarity gap (rel vs irrel) 0.034                   🔴 분리 매우 약함
```

---

## 미완료 항목

### P0-0. 영어 단일 저장 ✅ 완료

- EXTRACTION_SYSTEM_PROMPT에 영어 강제 지시 추가
- buildExtractionUserPrompt()에 번역 지시 추가
- 2개 prompt contract test 추가
- worker.ts에 영어 컨벤션 JSDoc 추가

### P0-1. Hybrid Candidate Generation ✅ 완료

- src/activation/fusion.ts: RRF fusion primitive (k=60)
- src/activation/lexical.ts: candidateIds 필터
- src/activation/engine.ts: shared LexicalIndex + hybrid retrieveMatches (dense ∪ lexical → RRF)
- 8 fusion unit tests + integration tests
- 벤치마크 개선: EN→KO 0.25→0.75, domain purity 55.6%→78.4%, hard-negative loss 7.7%→0.0%

### P0-2. Summary/Details Dual Indexing ✅ 완료

- Migration 014: `embedding_summary BLOB DEFAULT NULL`
- `updateEmbeddingSummary()` repository 메서드
- Engine: dense retrieval에서 max(full_similarity, summary_similarity) 사용
- Tier 2 fixture seeder: summary embedding도 생성
- 3개 round-trip tests + 1개 engine integration test

### P0-3. Query Expansion ✅ 완료

- Scoped query (scopeRef !== ".") 시 dense embedding에 path context 추가
- 예: "error handling" + scopeRef "web-app/src/api/route.ts" → "web-app src api route: error handling"
- Lexical search는 원본 query 유지 (BM25에는 exact keywords가 유리)
- First-turn (scopeRef=".") 은 확장하지 않음
- 2개 integration tests (scoped expansion + broad non-expansion)

### P1. Scope-Aware Rerank ✅ 완료

- RRF fusion 결과에 scope_glob 매칭 memory +0.05 boost
- Boost 후 재정렬하여 same-domain memory 우선
- 1개 integration test (scope boost verification)

### P2. 인프라 + 문서 ✅ 완료

- Canary set benchmark: 10쌍 고정 query→memory, baseline MRR 0.395, 10% regression guard
- roadmap.md: vector retrieval을 deferred에서 completed로 이동, hybrid retrieval 기록
- promotion-rubric.md: B+ 모델 섹션 이미 존재 (이전 작업에서 추가)

### P0.5. Small Cross-Encoder Reranker (조건부 — 보류)

**전제**: P0-0~P1 적용 후 Tier 2 recall@5가 0.35 미만이면 실행
**현재 상태**: Tier 2 재측정 필요. Hybrid + dual embedding + scope rerank 적용 후 recall이 충분히 올랐으면 불필요
**구현**: top-20 candidate에 작은 cross-encoder (예: ms-marco-MiniLM-L-6-v2) 적용

### P1. Scope-Aware Rerank ✅ 완료 (위에서 기술)

### P2. 인프라 + 문서 ✅ 완료 (위에서 기술)

### P3. 장기 검토

- [ ] `policy_subtype=soft` auto-promote 허용 (현재 workflow/pitfall만)
- [ ] Stronger model 검토 (snowflake-arctic-embed-m-v2.0, gte-multilingual-base) — 영어 저장 기준으로 영어 특화 모델 평가
- [ ] Late-interaction reranker (jina-colbert-v2 등) 검토
- [ ] Cross-project 학습 (global.sqlite 활성화)
- [ ] review_state 필드 추가

---

## 홍보 시 사용 가능한 표현

**✅ 쓸 수 있는 것**:
- "92% first-turn retrieval hit rate (real multilingual-e5-small, 72 memories, 12 queries)"
- "7.7% hard-negative leakage across 3 project domains"
- "Local memory budget enforcement — no context window bloat"
- "Ranking precision and cross-language retrieval under active tuning"

**❌ 피해야 하는 것**:
- "87% token savings" (대부분 cap 효과)
- "Semantic retrieval이 매우 정교하다"
- "Multilingual retrieval이 완성됐다"

---

## 참조

- Hermes Agent 분석: memory/skills/trajectory compression 패턴
- GPT Pro 리뷰 (3회): 우선순위, B+ 모델, hybrid retrieval, 홍보 전략
- Tier 2 벤치마크: 8 files, 30 tests, real e5-small
- 임베딩 모델 조사: 영어 단일 저장 결정 후 영어 특화 모델 후보 정리
- 핵심 설계 결정: "cross-language를 모델로 풀지 말고, 저장 언어를 통일하라"
- moltbook 댓글: Korean prefix (opencode-moltu-1), canary set (zirconassistant), 0.78 floor (hope_valueism)
