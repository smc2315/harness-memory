# harness-memory

**AI 코딩 어시스턴트를 위한 로컬 프로젝트 메모리**

harness-memory는 [OpenCode](https://opencode.ai) 플러그인으로, AI 코딩 어시스턴트에게 영속적이고 검토 가능한 프로젝트 메모리를 제공합니다.

자세한 문서는 [README.md](README.md)를 참고하세요.

## 빠른 시작

```bash
npx harness-memory install
```

OpenCode를 재시작하면 바로 사용할 수 있습니다.

## 핵심 특징

- **로컬 우선**: sql.js WASM, 클라우드 의존성 없음
- **증거 기반**: 모든 메모리가 대화 증거로 추적 가능
- **소량 주입**: 턴당 최대 10개 메모리, 8KB 예산, CLAUDE.md 대비 73% 토큰 절약
- **검토 가능**: Evidence → Dream → Candidate → Human Review → Active 라이프사이클
- **다국어**: 한국어 ↔ 영어 쿼리/메모리 매칭 (multilingual-e5-small)

## CLAUDE.md 대비

| | CLAUDE.md | harness-memory |
|--|-----------|----------------|
| 저장 | 단일 파일, 수동 편집 | SQLite (WASM) |
| 활성화 | 매 턴 전부 덤프 | 4-layer 엔진: 맞는 메모리를 맞는 시점에 |
| 검색 | 없음 | 벡터 + BM25 (다국어) |
| 토큰 비용 | 매 턴 전부 | 73% 절약 |

## CLI

```bash
npx harness-memory memory:review          # 후보 검토
npx harness-memory memory:promote --all   # 일괄 승인
npx harness-memory memory:stats           # 통계
npx harness-memory memory:health-check    # 시스템 진단
```

## 현재 상태

- v0.5.0 — 실사용 검증 진행 중
- compact-to-mid 프로젝트 (20세션 이하)에서 가장 잘 작동
- 피드백 환영: [GitHub Issues](https://github.com/smc2315/harness-memory/issues)

## 라이선스

MIT
