# harness-memory

[![npm version](https://img.shields.io/npm/v/harness-memory.svg)](https://www.npmjs.com/package/harness-memory)
[![license](https://img.shields.io/npm/l/harness-memory.svg)](https://github.com/smc2315/harness-memory/blob/master/LICENSE)

**Claude Code를 위한 트리거 인식 프로젝트 메모리.** harness-memory는 당신의 세션에서 정책과 피트폴을 배운다 — 당신이 타이핑한 교정, 실패했다가 고쳐진 명령 — 그리고 그것을 시스템 프롬프트에 핸드북처럼 쏟아 넣는 대신 *툴이 실행되기 전에*, `PreToolUse` 경계에서 꺼내 놓는다.

[claude-mem](https://github.com/thedotmack/claude-mem)과 보완 관계다: claude-mem은 무슨 일이 있었는지 기억하고, harness-memory는 에이전트가 알려진 실수를 반복하려는 순간에 멈춰 세운다. 계정도, 텔레메트리도, 데몬도, 툴 호출당 LLM 호출도 없다 — 핫패스는 미리 계산된 JSON 파일 하나를 읽는다.

> **0.6.0-rc.1 — Claude Code 전용.** Codex 훅은 0.6.1, OpenCode(V2 플러그인)는 0.6.2에 들어온다. v0.5는 OpenCode 플러그인이었다; 기존 `.harness-memory/` 위에 0.6을 설치하기 전에 [0.5에서 업그레이드](#05에서-업그레이드)를 먼저 읽을 것.

- [한 턴으로 보는 동작](#한-턴으로-보는-동작)
- [요구 사항](#요구-사항)
- [설치](#설치)
- [메모리가 캡처되고 저장되는 방식](#메모리가-캡처되고-저장되는-방식)
- [권한 모델](#권한-모델)
- [무엇이 언제 주입되는가](#무엇이-언제-주입되는가)
- [임베딩(선택)](#임베딩선택)
- [설정](#설정)
- [CLI 레퍼런스](#cli-레퍼런스)
- [문제 해결](#문제-해결)
- [프라이버시와 보안](#프라이버시와-보안)
- [0.5에서 업그레이드](#05에서-업그레이드)
- [로드맵](#로드맵)
- [개발](#개발)

## 한 턴으로 보는 동작

```text
당신:    여기서 `npm test` 돌리지 말고 packages/api에서 `pnpm test` 돌려
         └─ UserPromptSubmit 훅: 교정 감지(직전 툴 호출이 실패했다) → ledger 라인
claude:  (고치고 pnpm test 실행) … Stop
         └─ Stop 훅: 턴을 에피소드로 닫고(증거 가중치 2) queue/<id>.json을 쓴 뒤
            분리된 worker를 스폰
worker:  당신의 `claude -p`(헤드리스, 툴 없음)가 fact 하나를 추출:
         pitfall · 시그니처 bash/cmd "npm test" · scope packages/api → 검증 통과 →
         active(authority auto, enforcement advise, TTL 30 d) → 스냅샷 재빌드
다음 세션:
claude:  Bash: npm test
         └─ PreToolUse 훅(≈ 50 ms, SQLite 없음): 시그니처 일치 — `npm test`, `npm run test`,
            `& npm.cmd test`는 같은 형태로 정규화되고 `pnpm test`는 절대 걸리지 않는다 → additionalContext:
            "[harness-memory] PITFALL (auto, provisional): Run pnpm test from packages/api …"
            자동 규칙은 advise로 태어난다. 두 번째 세션이 교정을 다시 확인하면 soft_deny로 올라가고,
            같은 호출이 거부된다: "… If this does not apply, call the tool again to proceed."
claude:  Bash: pnpm test
```

설계를 떠받치는 세 가지 생각:

1. **타이밍.** 지식에는 네 개의 라이프사이클 트리거가 있다 — `session_start`, `before_model`, `before_tool`, `after_tool` — 그중 가장 중요한 것은 `before_tool`이다. Claude Code의 유일한 실행 전 채널은 `permissionDecision: ask | deny`이므로 모든 메모리는 그 채널로 매핑되는 **enforcement** 수준(`advise`, `confirm`, `soft_deny`, `deny`)을 가진다.
2. **증거는 메모리가 아니다.** 훅은 세션별 ledger에 원시 이벤트를 append만 한다. 메모리는 하나의 쓰기 경로 — 에피소드 → 추출 → 검증 → 결정적 reconcile — 가 만들어 내는 구조화된 fact(타입, scope glob, 트리거 시그니처, 트리거, confidence, 출처)다.
3. **통제된 자율성.** LLM이 추출하되 **authority**는 명시적이다. 교정 한 번에서 배운 피트폴은 스스로 활성화된다(`authority = auto`, TTL과 낮은 신뢰 배수를 가진다). 사람 메모리는 자동 경로가 절대 강등·대체·거부할 수 없다 — 자동 경로는 *제안*만 할 수 있고, 결정은 `hm review`에서 당신이 한다.

## 요구 사항

- **Node.js ≥ 20** (24에서 개발). 훅은 평범한 `node` 프로세스이고 worker는 sql.js(WASM)로 SQLite를 다룬다 — 네이티브 의존성 없음.
- **Claude Code ≥ 2.1.139**: exec-form 훅(`{"command": "<node>", "args": [...]}`)용. 더 오래된 버전은 자동으로 shell-form 훅을 받는다(`--hook-form`으로 덮어쓸 수 있다).
- **학습용 추출 CLI(터미널에서 로그인)**: `claude`(권장) 또는 `codex`. 추출은 당신의 헤드리스 CLI와 구독으로 돈다 — API 키 없음. 로그인은 집행에는 선택 사항이다: 훅은 스냅샷에 이미 있는 모든 규칙(`hm memory:add`, import된 행)을 로그인 없이 발화시킨다; 새 `hm import` 불릿을 타입 있는 행으로 바꾸는 일과 세션에서 배우는 일 — "기억해"라고 한 것 포함 — 은 `claude auth login` 뒤에 시작된다(구버전 CLI: `claude` 실행 후 `/login`; 데스크톱 앱 로그인은 `claude -p`에 적용되지 않는다). 그때까지 불릿과 에피소드는 큐에서 기다리며 잃는 것은 없다.
- Windows, macOS, Linux. Windows에서 Git Bash는 선택 사항이다([아래](#node-경로-npx-windows-셸) 참고).

## 설치

```bash
npm install -g harness-memory        # 또는: npm install -D harness-memory  (이후 `npx hm …`)
cd <your project>
hm install --host claude
hm status
```

`hm install --host claude`의 출력(요약):

```text
harness-memory 0.6.0-rc.1 installed for Claude Code
  project     C:\src\my-app
  hooks       9 events → C:\src\my-app\.claude\settings.local.json (exec form)
  node        C:\Program Files\nodejs\node.exe  (claude 2.1.172)
  hook script C:\Users\me\AppData\Roaming\npm\node_modules\harness-memory\dist\hook.js
  database    C:\src\my-app\.harness-memory\memory.sqlite v21
  snapshot    built (active 0, candidates 0)
  config      C:\src\my-app\.harness-memory\config.json (created); embeddings off
  git         .claude/settings.local.json added to C:\src\my-app\.git\info\exclude
  provider    claude — probe not_logged_in; imported and hand-added rules fire without the login; learning starts after `claude auth login`; …
  self-test   session-start ok (…, hook status ok)
  manifest    C:\src\my-app\.harness-memory\install-manifest.json
Open Claude Code in this project; `hm status` shows what the hooks learn.
```

재시작은 필요 없다; Claude Code가 설정 파일 변경을 감지한다. 프로젝트를 Claude Code에서 열고 평소처럼 작업하면서 `hm status`를 보면 된다. 프로젝트에 `CLAUDE.md`나 `AGENTS.md`가 있으면 설치 출력이 `hm import --from CLAUDE.md`를 제안한다; 확인 표를 거쳐 그 bullet들을 사람 메모리로 만든다.

Claude Code 자체의 **auto memory**(`~/.claude/projects/<slug>/memory/`, `type: feedback` 노트)도 두 번째 import 소스다: `hm import --from auto-memory`가 그 노트들을 같은 확인 표를 거쳐 사람 규칙으로 만들어, Claude가 이미 적어 둔 교정이 도구 경계에서 집행되기 시작한다. 그런 노트가 있으면 설치 출력이 알려 준다.

### `hm install`이 쓰는 것

| 경로 | 내용 |
|---|---|
| `.claude/settings.local.json` | 훅 항목 아홉 개(아래 표). 기존 훅은 건드리지 않는다; `hm install`을 다시 실행하면 `args`가 harness-memory의 `hook.js`를 가리키는 항목만 교체된다. `--user`는 대신 `~/.claude/settings.json`을 대상으로 한다(`CLAUDE_CONFIG_DIR` 존중). |
| `.git/info/exclude` | `.claude/settings.local.json` 한 줄이 추가된다(프로젝트 범위만). `.git`이 worktree/submodule 포인터 파일이면 그것을 따라가 실제 `info/exclude`에 쓰고, 풀 수 없으면 조용히 넘어가는 대신 경고한다. |
| `.harness-memory/.gitignore` | `*` 한 줄. ledger, 데이터베이스, 스냅샷, 로그가 git에 올라가지 않는다. 편집된 파일은 그대로 두며, 이미 git이 추적하는 파일이 있으면 `hm doctor`가 경고하고 추적을 해제하는 git 명령을 알려 준다. |
| `.harness-memory/` | `config.json` 기본값, `memory.sqlite`(새로 생성하거나, 업그레이드면 `memory.sqlite.bak-v<N>` 백업과 함께 마이그레이션), `snapshot/` 파일, 빈 `ledger/ state/ queue/ raw/ locks/ logs/`와 함께 생성된다. |
| `.harness-memory/install-manifest.json` | 건드린 파일과 sha256, node 경로, 훅 형식, 버전. `hm uninstall`과 `hm doctor --fix`가 이것을 기준으로 동작한다. |
| `~/.harness-memory/` | 사용자 수준, `install`이 아니라 첫 사용 시 생성: `worker/<repo_hash>/`(헤드리스 추출 CLI용 빈 cwd, 어떤 git 저장소 밖), `models/`(임베딩 모델 캐시). v0.5의 `global.sqlite`가 있어도 그대로 둔다. |

등록되는 훅은 모두 exec-form 명령이다 — `hm install`을 실행한 Node 바이너리의 절대 경로와 `dist/hook.js`의 절대 경로, 이벤트 이름:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|WebFetch|mcp__.*",
        "hooks": [
          {
            "type": "command",
            "command": "C:\\Program Files\\nodejs\\node.exe",
            "args": ["C:\\...\\harness-memory\\dist\\hook.js", "pre-tool"],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

| Claude Code 이벤트 | matcher | 훅 argv | timeout |
|---|---|---|---|
| `SessionStart` | — | `session-start` | 10 s |
| `UserPromptSubmit` | — | `prompt` | 10 s |
| `PreToolUse` | `Bash\|PowerShell\|Edit\|MultiEdit\|Write\|NotebookEdit\|WebFetch\|mcp__.*` | `pre-tool` | 5 s |
| `PostToolUse` | `.*` | `post-tool` | 5 s |
| `PostToolUseFailure` | `.*` | `post-tool-failure` | 5 s |
| `Stop` | — | `stop` | 10 s |
| `StopFailure` | — | `stop-failure` | 10 s |
| `PreCompact` | `manual\|auto` | `precompact` | 10 s |
| `SessionEnd` | — | `session-end` | 1 s |

`Read`, `Grep`, `Glob`, `Task`는 의도적으로 `PreToolUse`에 등록하지 *않는다*(가장 잦은 툴에 50 ms 프로세스를 얹지 않는다); 이 툴들을 시그니처로 지목한 메모리는 검증기가 `before_model`로 다시 라벨링한다.

### Node 경로, npx, Windows 셸

- **Node 경로.** 훅은 `hm install`을 실행한 정확한 `node` 바이너리(`process.execPath`)와 그 패키지의 정확한 `dist/hook.js`를 기록한다. 덕분에 PATH, nvm, volta 전환에 영향을 받지 않지만, 그 Node 버전을 지우거나 패키지를 옮기면 훅은 조용히 멈춘다. `hm doctor`가 이를 보고하고(`install.node`, `install.hook_script`) `hm doctor --fix`가 현재 바이너리와 스크립트로 항목을 다시 쓴다.
- **npx.** `npx harness-memory install --host claude`도 동작하지만 npx 캐시의 복사본을 등록하며, npm은 그 캐시를 정리할 수 있다. 자리를 지키는 곳에서 설치할 것: 전역 설치 또는 프로젝트 `devDependency`.
- **Git Bash / PowerShell(Windows).** Claude Code는 `Bash`를 Git Bash로 실행하고, Git Bash가 없으면 `PowerShell` 툴을 노출한다. harness-memory는 둘을 모두 정규 툴 `bash`로 매핑하고 dialect를 기록하므로 한 셸에서 배운 피트폴이 다른 셸에서도 발화한다(`pnpm test; git status`와 `& npm test`는 같은 정규형이 된다). exec-form 훅에는 셸이 전혀 개입하지 않는다. shell form이 필요하면(오래된 Claude Code) install은 Git Bash가 발견될 때(`CLAUDE_CODE_GIT_BASH_PATH`, `Program Files\Git`, `%LOCALAPPDATA%\Programs\Git`, `PATH`) `"shell": "bash"`, 아니면 `"powershell"`을 고른다. 분리된 worker는 `windowsHide`로 실행되므로 콘솔 창이 깜빡이지 않는다.

### 확인과 제거

```bash
hm status              # 한 줄: active N (auto M) | candidates | proposals | queue | last extraction | probe | snapshot | p95
hm doctor              # 모든 검사를 OK / WARN / FAIL로; --self-test는 session-start 훅을 한 번 실행한다
hm uninstall           # 훅 항목, git exclude 줄, 매니페스트 제거; .harness-memory/는 유지
hm uninstall --purge   # memory.sqlite.bak-v<N> 백업을 제외한 .harness-memory/도 삭제
```

## 메모리가 캡처되고 저장되는 방식

```text
훅(DB 없음)            ledger/*.jsonl ──► queue/<episode>.json ──► worker extract ──► memory.sqlite ──► snapshot/*.v1.*
                       state/*.json        (턴 세그먼트)             claude -p +         (lock 하나,       모든 훅이 읽는다
                                                                    V1–V12 + reconcile   write_ops)
```

### 1. Ledger — 훅이 쓰는 것

모든 훅은 **JSON 한 줄**(≤ 32 KB, 단일 `appendFileSync`, 자격 증명은 먼저 마스킹)을 `.harness-memory/ledger/claude-code-<session_key>.jsonl`에 덧붙인다. `session_key = sha1("claude-code:" + session_id).slice(0, 16)`. 훅은 SQLite를 절대 열지 않는다; 훅이 쓰는 다른 파일은 `state/claude-code-<session_key>.json`(열린 턴: `turn_key`, `turn_start_offset`, `segment`, `correction_for`)과 `queue/*.json`뿐이다.

| 라인 | writer | 필드(상한) |
|---|---|---|
| `prompt` | `prompt` | `text`(4,000자), `correction`, `remember` |
| `fired` | `pre-tool` | `memory_ids`, `rule_codes`, `tool`, `target_digest`(120), `delivery`, `decision`, `enforcement`, `signature_keys` |
| `tool_ok` | `post-tool` | `tool`(정규형), `host_tool`, `shell_dialect`, `input_digest`(500), `scope_refs`, `program_token`, `output_head`(2,000) / `output_tail`(1,000), `resolution_of` |
| `tool_fail` | `post-tool-failure` | `tool_ok` 필드 + `error`(1,500), `exit_code`, `is_interrupt`, `failure_class`(`exit_N`, `enoent`, `eacces`, `timeout`, `interrupt`, `other`), `failure_sig` |
| `assistant` | `stop` | `text` = 마지막 assistant 메시지(2,000) |
| `marker` | `session-start`, `precompact`, `session-end`, `stop-failure`, idle 스윕 | `marker`, `detail` |

정규식은 **오직** 플래그를 세우는 데만 쓰인다 — 메모리 텍스트를 만들지 않는다(v0.5의 "템플릿 후보" 결함). 신호:

- **correction(교정)** — 직전 턴의 마지막 툴 호출이 실패했거나, 프롬프트가 교정 어휘(`don't`, `instead`, `wrong`, `revert`, `아니`, `하지 마`, `말고`, `대신`, `틀렸`, …)에 맞는다.
- **remember** — `remember`, `from now on`, `기억`, `앞으로`, `절대`; `always` / `항상`은 문장 첫머리이거나 다른 단서와 함께일 때만. 이 플래그는 에피소드에 가중치(3)를 준다. §7.3의 사람 경로는 추가로 프롬프트 자체에 명시적 요청(`remember this`, `기억해`, `앞으로` + 규칙)이 있어야 한다; `이 저장소가 npm인지 기억이 안 나` 같은 말은 해당하지 않는다.
- **failure → resolution(실패 → 해결)** — 앞선 미해결 `tool_fail`과 같은 툴·같은 경로(또는 같은 정규 프로그램 토큰, 예: `pm test`)의 `tool_ok`. 실패한 `npm test` 뒤의 성공한 `ls`는 해결이 *아니다*; 성공한 `pnpm test`는 해결이다.
- **decision marker(결정 마커)** — 마지막 assistant 메시지의 `decided`, `we'll use`, `switch to`, `결정`, `이제부터`, `전환`, ….

### 2. 에피소드 — 턴 세그먼트가 곧 큐

`Stop`, `PreCompact`, `SessionEnd`는 열린 세그먼트(`[turn_start_offset, EOF)`, ≤ 4 MB)를 `queue/<episode_id>.json`으로 닫는다: scope ref, 사용한 툴, 실패 시그니처와 그 해결, 플래그, 어떤 메모리가 발화했고 에이전트가 `soft_deny`를 **override**했는지 **heed**했는지, 그리고

```text
evidence_weight = correction 2 + remember 3 + (실패마다 resolution 2 | 미해결 failure 1)   (상한 10)
```

`evidence_weight ≥ 1`이거나 결정 마커가 있는 에피소드만 LLM으로 간다; 읽기 전용 턴은 `no_signal`로 건너뛴다. 다음 `UserPromptSubmit`은 호스트가 끝내지 못한 턴을 닫고(`interrupted`), `SessionStart` 훅과 `hm dream`은 한 시간 넘게 멈춘 턴을 스윕한다(`idle`). 에피소드 id는 결정적이라(`host:session:turn_key:segment`) 같은 세그먼트를 다시 닫는 것은 no-op이고, 중간에 압축된 턴은 두 개의 에피소드가 된다.

### 3. 추출 — 분리된 worker와 당신의 CLI

훅은 `node dist/worker.js <root> extract`를 분리 실행(`stdio: ignore`, `windowsHide`)하므로 훅은 밀리초 안에 돌아온다. worker는 `locks/worker.lock` 아래에서:

1. 큐의 에피소드를 삽입하고(`INSERT OR IGNORE`), 발화 목록에서 `fire_count` / `override_count`를 합산하고, 에피소드 ≤ 3개를 — 교정 우선으로 — lease하고, 일일 캡(`extraction.max_runs_per_day`, 기본 40; 교정 에피소드는 예외)을 적용한다;
2. 프롬프트를 렌더한다: 에피소드 헤더, 이 턴이 교정이면 직전 턴의 마지막 ≤ 12 툴 라인을 *인용 불가* 맥락으로, 모든 ledger 라인에 `e<seq>` 번호(실패와 해결은 전문, 나머지는 요약), 마지막 assistant 메시지, scope가 교차하는 기존 메모리 ≤ 40건, 정규 툴 어휘와 타입 경계 규칙 — 24,000자 상한;
3. provider를 호출한다(`extraction.provider`: `auto` → `claude`가 있으면 그것, 없으면 `codex`):

   ```text
   claude -p --output-format json --json-schema <schema> --tools "" --disallowedTools "mcp__*" \
     --strict-mcp-config --no-session-persistence \
     --settings '{"disableAllHooks":true,"autoMemoryEnabled":false}' --model <extraction.model, 기본 sonnet>
   ```

   프롬프트는 stdin으로, cwd는 `~/.harness-memory/worker/<repo_hash>/`(어떤 저장소 밖이므로 `CLAUDE.md`, 프로젝트 훅, auto-memory가 로드되지 않는다), **허용 목록 환경**(`CLAUDECODE`, `CLAUDE_CODE_*` 없음; 자식 안의 훅이 즉시 종료하도록 `HARNESS_MEMORY_DISABLE=1`), 벽시계 120 s, 원본 응답은 `raw/<run_id>.json`에 24 h 캐시. 바이너리는 `HARNESS_MEMORY_CLAUDE_BIN` → `CLAUDE_CODE_EXECPATH` → `PATH` → winget 패키지 디렉터리 순으로 찾는다. **probe**(1필드 스키마 호출)가 provider를 `ok`, `not_logged_in`, `missing`, `nested_refusal`, `probe_timeout`, `invalid_output`으로 분류한다; `ok`는 하루 동안 신뢰하고 실패는 10분 뒤 다시 시도하며, 사용할 수 없는 provider는 시도 횟수를 소모하지 않고 에피소드를 `queued`로 남긴다.

추출기는 고정된 JSON 스키마로 답한다: `episode_summary`, `nothing_to_learn`, 그리고 ≤ 8개의 `facts`. 각 fact는 `action`(`create` | `reinforce` | `propose_supersede` | `propose_stale`), `type`, `summary`(12–160자), `details`, `scope_glob`, `relevant_tools`, `trigger_signature`(`{tool, target, pattern_kind, pattern}`), `lifecycle_triggers`, `confidence`, `evidence_refs`(`e<seq>` 인용), `knowledge_kind`, `rationale`, `aliases`(≤ 8개 동의어, 사용자 언어 포함)를 가진다. `delete`도 `edit`도 없다: LLM은 생성·강화·제안만 할 수 있다.

### 4. 검증 — V1에서 V12까지

각 fact는 데이터베이스에 닿기 전에 결정적 검증기를 통과한다: 스키마 모양(V1); 모든 `evidence_refs`가 이 에피소드의 라인으로 해석됨(V2); 시그니처가 정밀도를 담당하지 않는 한 scope는 에피소드의 파일과 교차하는 저장소 상대 glob이어야 함(V3); 시그니처의 툴이 실제로 에피소드에서 쓰였음(V4); regex가 컴파일되고 중첩 수량자가 없으며 4 KB 샘플을 예산 안에 훑음 — 2 ms, 느린 머신에서는 단순 선형 스캔의 500배까지(V5); 보안 스캐너를 통과하고 harness-memory 자신을 언급하지 않음(V6); `reinforce` / `propose_*`의 대상이 실재함(V7); 프롬프트의 재진술이 아님(V8); 배치 안에 같은 `semantic_key`가 없음(V9); 시그니처가 구체적임 — `cmd` ≥ 2 토큰, `substring` ≥ 8자, 경로 조각이 있는 glob(V10); `before_tool`은 훅이 전달할 수 있는 곳에만 남김(V11); 인용된 실패를 해결한 명령이 실패 명령과 다른데 시그니처가 그 해결 명령에도 걸리면 거부 — `pm test`는 `npm test`를 고친 `pnpm test`에도 발화할 것이다(V12). JSON이 아니거나, fact가 8개를 넘거나, 환각 인용이 50 %를 넘는 run은 `suspect`로 표시되어 통째로 건너뛴다; 그 외에는 거부된 fact를 세고 나머지를 적용한다.

### 5. Reconcile — 트랜잭션 하나, 그다음 스냅샷

`locks/db.lock` 아래(수 초만 보유하며 LLM 호출을 감싸지 않는다)에서 worker는 fact를 하나씩(`SAVEPOINT`마다) 적용한다: `create`는 `authority = 'auto'`, `status = 'candidate'`, `source_ref = 'episode:<id>'`인 새 행이 되고; 동일하거나 거의 같은 살아 있는 행(`semantic_key`, 또는 정규화된 summary의 Jaccard ≥ 0.6)이 있으면 대신 **강화**된다; `propose_*`는 **제안**을 열거나 지지한다. 모든 fact는 `memory_provenance`(에피소드, 인용 라인, confidence)를 남기고, 파생 카운터(`evidence_count`, `evidence_score` = 에피소드 가중치 합, `distinct_session_count`, auto `confidence`)가 즉시 재계산된 뒤 `decideTier`가 `active`인지 `candidate`인지 결정한다([자동 티어](#자동-티어--메모리가-스스로-활성화되는-조건) 참고). run id는 `write_ops`에 기록되어 같은 run을 재생해도 no-op이다; `policy_rules`는 active policy 메모리에서 다시 파생되고; `db_generation`이 증가하고; 데이터베이스는 원자적으로 저장되며(`.tmp-<pid>` → fsync → `.prev` → rename) `snapshot/*.v1.*`이 재빌드된다. 손상된 본 파일은 `.prev`에서 복구된다.

**Consolidation**(`worker dream`; 마지막 실행이 `dream.interval_hours` = 6보다 오래됐을 때 `SessionEnd`에서 스폰되거나 `hm dream`)은 절대 메모리를 발명하지 않는다: TTL 만료(교정/실패 유래 행은 먼저 `revalidate` 제안을 받는다), 45 d가 지난 auto 후보 → `rejected`, 30 d가 지난 제안 → `expired`, 최근 발화한 행의 TTL 연장, **override 강등**(`evidence_score < 3`인 auto 행이 3번 이상 override되면 `advise`로 내려간다), auto 근중복의 `merge` 제안, 임베딩 백필, idle 턴 스윕, GC(ledger 세그먼트 14 d, `raw/` 24 h, tmp 파일 10분, audit 로그 30 d).

### `.harness-memory/` 레이아웃 — 무엇을 백업할 것인가

| 경로 | 내용 | 백업? |
|---|---|---|
| `memory.sqlite` | **진실의 원천**: 메모리, 에피소드, run, 제안, 출처, 전이, 정책 규칙, `write_ops`, `meta` | **예** |
| `memory.sqlite.prev`, `memory.sqlite.bak-v<N>`, `memory.sqlite.corrupt-<ts>`, `memory.sqlite.rollback-<ts>` | 마지막 정상 복사본; 스키마 버전별 마이그레이션 전 백업; 따로 보관된 손상 파일; `db:rollback`이 교체한 파일 | 업그레이드를 신뢰할 때까지 `.bak-v<N>`은 보관 |
| `config.json` | 당신의 설정([설정](#설정) 참고) | 예 |
| `install-manifest.json` | `hm install`이 건드린 것 | 아니오(`hm install` 재실행) |
| `snapshot/active.v1.json`, `lexical.v1.json`, `recall.v1.json`, `dense.v1.bin`, `.reindex-requested` | 훅의 읽기 모델: 사전 컴파일된 scope regex와 시그니처를 가진 active 메모리, 파생 규칙, failure index, 카운트; 직렬화된 MiniSearch 인덱스; 에피소드별 회상 요약과 그 인덱스(`recall.enabled`일 때); 선택적 임베딩 행렬 | 아니오(파생; `hm snapshot:rebuild`) |
| `ledger/*.jsonl`, `state/*.json`, `state/*.notify.json` | 세션별 원시 이벤트(14 d), 열린 턴 커서, worker → 다음 prompt 알림 | 아니오 |
| `queue/*.json`, `raw/*.json` | 추출을 기다리는 에피소드; provider 원본 출력 캐시(24 h; 무효·suspect 응답은 같은 기간 동안 `<run>.<attempt>.json`으로 보관) | 아니오 |
| `locks/db.lock/`, `locks/worker.lock/`, `*.pid`, `embed-helper.spawn` | `owner.json` heartbeat를 가진 `mkdir` 기반 lock; pid 파일; 스폰 스로틀 | 아니오 |
| `logs/hooks.log`, `logs/worker.log`, `logs/audit.log` | 훅 호출당 한 줄(5 MB × 3 회전); worker 이벤트; audit 이벤트 | 아니오 |

`hm install`이 `.harness-memory/.gitignore`(`*`)를 써 두므로 디렉터리 안의 어떤 것도 git에 올라가지 않는다; 예전에 커밋된 파일이 있으면 `hm doctor`가 경고한다. 버전 관리에 둘 백업은 `hm memory:export`가 만드는 결정적 SQL 덤프를 쓰면 된다.

## 권한 모델

### 모든 메모리의 두 축

- **`authority ∈ {human, auto}`** — 누가 상태를 바꿀 수 있는가. `human` 행은 `hm memory:add`, `hm import`(당신이 쓴 파일), `hm memory:promote`, 수락된 `activate_*` 제안, 당신이 수락한 대체 행, 그리고 *어떤* 사람 편집(`memory:enforce`, scope 변경)에서 나온다. **TTL이 없고**, 신뢰 배수가 1.0이며, 자동 경로는 절대 강등·대체·stale·거부할 수 없다 — `transitionMemory`가 `AuthorityViolationError`를 던지고 아무것도 쓰지 않는다. `auto` 행은 추출에서 태어나고, TTL을 가지며, 검증이 쌓일수록 신뢰 배수가 0.65 → 0.8 → 0.95로 오르고, 2-세션 반증 증거나 반복된 override로 강등될 수 있다.
- **`enforcement ∈ {advise, confirm, soft_deny, deny}`** — `before_tool` 일치가 어떻게 전달되는가. `deny`는 사람만 설정할 수 있고 LLM은 enforcement를 절대 올리지 못한다.

### 전달 사다리(Claude Code)

| enforcement | Claude Code가 받는 것 | 타이밍 |
|---|---|---|
| `advise` | `hookSpecificOutput.additionalContext` | 툴 결과와 함께 |
| `confirm` | `permissionDecision: "ask"` + 사유; `permission_mode`가 `bypassPermissions` / `dontAsk`면 `soft_deny`로 강등(`delivery = before_downgraded`) | 실행 전 |
| `soft_deny` | `permissionDecision: "deny"` + *"If this does not apply, call the tool again to proceed."*로 끝나는 사유 — 한 턴 안에서 `(memory, tool)` 쌍의 **첫** 시도만 거부된다; 재시도는 통과하고 override가 기록된다 | 실행 전 |
| `deny` | 매번 `permissionDecision: "deny"`(*"This action is blocked by a human-set policy."*) | 실행 전 |

`confirm`, `soft_deny`, `deny`는 당신을 위한 `systemMessage` 한 줄(`harness-memory: pitfall 3f9a… fired (soft_deny)`)도 낸다; `advise`는 조용하다. 주입 텍스트는 `[harness-memory] PITFALL (auto, provisional): <summary> — <details>` 모양이며, 라벨은 `human`, `human, unconfirmed import`, `auto, provisional`이고, 두 세션이 반박한 human advise 행에는 `, contested`가 붙는다. 사유는 ≤ 600자; 훅은 절대 `allow`를 내보내지 않는다.

### 기본 enforcement(`enforcementDefault`, `hm memory:enforce`로 언제든 덮어쓸 수 있다)

| 메모리 | authority | 기본값 |
|---|---|---|
| 시그니처가 있는 hard `policy`; `never` / `must not` / `always` / `do not` / `절대` / `반드시` / `항상`과 시그니처를 가진 **확인된** import 규칙 | human | `confirm`(`before_tool.hard_policy`) |
| soft policy, 시그니처 없는 policy, `hm import --yes` 행(`import_unconfirmed = 1`), 그 외 import | human | `advise` |
| 구체적 시그니처와 `knowledge_kind ∈ {correction, failure_resolution}`을 가진 auto `pitfall` | auto | `advise`(`before_tool.auto_enforcement`); 두 번째 세션이 다시 확인하면 `soft_deny`로 올라간다(`before_tool.auto_escalation`, 기본 `{ enabled: true, sessions: 2 }`; `autonomy_level: shadow`는 올라가지 않음; override로 내려간 행은 새 세션이 다시 확인해야 다시 올라감). `hm memory:history`에 `active (enforcement) by auto_rule`로 기록 |
| 명시적 기억 요청(`remember this`, `기억해`, `앞으로` + 규칙)이 있는 턴에서 그 프롬프트 줄을 인용한 규칙 | human(`status_reason remember`, 즉시 active, 턴당 최대 2개) | 시그니처 있는 policy → `confirm`(`before_tool.hard_policy`); 시그니처 있는 pitfall → `soft_deny`; 그 외 → `advise`. `SessionStart`가 24시간 동안 되돌리기(`hm memory:demote <id>`)와 함께 알려 준다; 이후 자동 경로는 손대지 않는다 |
| 그 외 모든 auto 행(시그니처 없는 `pitfall`, `workflow`, `decision`, `architecture_constraint`) | auto | `advise` |

### 자동 티어 — 메모리가 스스로 활성화되는 조건

`decideTier`는 생성되거나 강화된 모든 auto 후보에 대해, 카운터가 재계산된 직후 실행된다:

- 다음이 모두 성립하면 **active**: `type ∈ {pitfall, workflow}`, 유효한 저장소 상대 scope, 트리거 시그니처 또는 `relevant_tools`, 훅이 닿을 수 있는 트리거, `confidence ≥ 0.7`, `evidence_score ≥ 2`, 스캐너 통과, 열린 제안의 대체 행이 아님, 캡 미달(`extraction.max_auto_activations_per_episode` = 3, `max_auto_activations_per_day` = 10), `autonomy_level = standard`. 행은 교정/실패→해결 지식이면 `ttl_expires_at = now + 30 d`(관습은 7 d), `revalidate_after`는 그 절반, `validation_count = evidence_count − 1`을 받는다.
- 그 외에는 **candidate** — 이유(`evidence`, `cap`, `confidence`, `type`, `replacement`, `autonomy`, …)와 함께; `policy`면 `activate_policy` 제안, 시그니처 없는 전역 행이면 `activate_global` 제안이 열린다. `decision`과 `architecture_constraint`는 항상 당신을 기다린다.

"충분한 증거"는 **에피소드 수가 아니라 가중치 합**이다: 교정 하나(2) 또는 실패 → 해결 쌍 하나(2)면 즉시 활성화된다. 비용 쪽은 TTL, 첫 활성화의 신뢰 배수 0.65, 강등에만 적용되는 2-세션 규칙, V10 구체성, override 강등, 일일 캡이다. 강화는 TTL을 줄이지 않는다(`ttl = max(기존, now + max(7·2^validations, base))`, 최대 90 d); 발화한 메모리는 14 d 연장된다.

### 제안과 리뷰

제안 종류 여덟 가지: `supersede`, `stale`, `activate_policy`, `activate_global`, `fix_scope`(v0.5 마이그레이션에서), `fix_signature`, `revalidate`, `merge`. (kind, target, candidate)당 열린 제안은 하나이며, 같은 주장이 반복되면 `support_count` / `support_sessions`만 오른다. 추출기의 `propose_stale` / `propose_supersede`는 **human** 행에 대해서는 제안을 열고 행을 `contested`로 표시할 뿐이고, **auto** active 행에 대해서는 ≥ 2 세션의 지지가 있고 그중 하나가 사람 신호(교정 또는 *remember*)나 결정적 관찰을 가질 때만 자동 적용된다 — 에이전트는 자기 턴 두 번으로 당신의 교정을 지울 수 없다. 제안을 거부하면 같은 주장이 30일 동안 억제된다; 제안은 30일 뒤 만료된다(`fix_scope`는 90일).

리뷰는 예외 처리이며 예산이 있다(활성 일당 ≤ 3건이 dogfood 게이트): `hm review`는 사람 메모리에 대한 제안 → `revalidate` → policy 후보 → 전역 후보 → `fix_scope` / `fix_signature` → `merge` → 미확인 import → 사람 후보 순으로 걷고, 키는 `a`ccept, `r`eject, `s`kip, `t`race, `p`romote다. `supersede`를 수락하면 대체 행이 `human`이 되고, `activate_*`를 수락하면 `hm memory:promote`처럼 행이 승격된다. `SessionStart` 훅은 하루 한 번 `systemMessage` 다이제스트 한 줄을 보여 준다(`harness-memory: N proposal(s) open, M expiring within 7 days — run hm review`). 리뷰 텍스트는 모델의 컨텍스트에 절대 들어가지 않는다.

### `autonomy_level`

`standard`(기본) — 위의 표. `shadow` — 결정을 `audit_log`(`auto_activation_shadow`)에만 기록하고 아무것도 활성화하지 않는다. `off` — `decideTier`가 아무것도 활성화하지 않는다.

## 무엇이 언제 주입되는가

| 트리거 | Claude Code 훅 | 무엇 | 예산 |
|---|---|---|---|
| `session_start` | `SessionStart` | 트리거에 `session_start`가 있고 타입이 baseline / `decision` / `architecture_constraint` / `workflow`인 active 행; 더해서 일일 다이제스트 `systemMessage` | 5개 / 3 KB |
| `before_model` | `UserPromptSubmit`(사용자 턴당 한 번) | baseline 행은 항상; 그 외 행은 scope가 프롬프트의 경로 토큰(또는 마지막으로 건드린 파일)과 교차하고 **그리고** summary / details / aliases에 대한 BM25 ≥ `before_model.min_score`일 때 — 또는 임베딩 helper가 있으면 코사인 ≥ 0.80; 그 다음 `recall.enabled`이면 다른 세션의 과거 에피소드 요약을 최대 `before_model.recall.max_items`개(`[harness-memory] RECALL <날짜>: …`, `snapshot/recall.v1.json`에 대한 BM25 ≥ `before_model.recall.min_score`, 맥락일 뿐 강제 아님) | 5개 / 3 KB(+ 회상 2개 / 1 KB) |
| `before_tool` | `PreToolUse` | 위의 사다리 | 3개 / 2 KB |
| `after_tool` | `PostToolUseFailure` | `failure_index[failure_class]` 힌트(예: 이 툴의 `enoent`에 관한 메모리)를 `additionalContext`로 | 2개 / 1 KB |

`before_tool` 상세: 훅은 툴을 정규화하고(`Bash` / `PowerShell` → `bash`, `Edit` / `MultiEdit` / `NotebookEdit` → `edit`, `WebFetch` → `fetch`, `mcp__server__tool` → `mcp:server/tool`), 대상(`command`, `file_path`, `url` 또는 MCP 입력 JSON)과 그 안의 경로형 토큰을 고르고, ledger 꼬리를 읽어 이 턴에 이미 무엇이 발화했는지 알아낸 뒤 스냅샷을 필터링한다: status와 TTL → 트리거 → `relevant_tools` → 시그니처 일치(`cmd` 패턴은 정규 명령형 위에서 맞춰진다: `npm test` ≡ `npm run test` ≡ `& npm.cmd test`, 계열형 `pm test` / `bin vitest`는 모든 패키지 매니저 / 러너를 덮는다; `glob` / `regex` / `substring`은 대상에 대해) 또는 시그니처 없는 `policy` / `pitfall` 행은 scope regex × 경로 토큰 → 파생 정책 규칙 → enforcement, 시그니처 일치, human 우선, 점수 순 정렬 → 쿼터(policy 2, pitfall 2, workflow 1) → 예산. 호스트가 이미 로드하는 파일(`CLAUDE.md`, `CLAUDE.local.md`)에서 import된 행은 `session_start` / `before_model`에서 건너뛰어 같은 말을 두 번 하지 않는다. `hm memory:why --tool bash --target "npm test"`는 정확히 이 함수를 실행해 모든 활성화와 억제 이유를 출력한다.

## 임베딩(선택)

밀집 검색은 **기본적으로 꺼져 있고** `PreToolUse` 경로에는 절대 없다. `before_model`에 쓰고 싶다면:

```bash
hm install --host claude --with-embeddings   # 패키지 루트에서 npm install @xenova/transformers, embeddings.enabled = true
```

- 작은 **helper 프로세스**(`dist/embed-helper.js <root>`)가 Windows 명명 파이프(`\\.\pipe\harness-memory-embed-<repo_hash>`) 또는 `$XDG_RUNTIME_DIR`(없으면 임시 디렉터리) 아래의 Unix 소켓 `harness-memory-embed-<repo_hash>.sock`(저장소 밖에 두므로 깊은 체크아웃에서도 Unix 소켓 경로 길이 제한에 걸리지 않는다; `hm doctor`가 경로를 보여 준다)으로 top-k 질의에 답한다. `prompt` 훅은 `before_model.dense_timeout_ms`(80 ms) 예산 안에서 묻고, 답이 없으면 lexical 전용으로 넘어간다; 첫 실패가 helper를 분리 스폰한다(60 s에 한 번으로 제한). helper는 `snapshot/dense.v1.bin`을 로드하고 그 파일이 바뀌면 다시 로드하며, `embeddings.idle_exit_minutes`(15) 동안 요청이 없거나 SIGTERM을 받으면 **스스로 종료**한다. 설치되는 서비스도, 고정 포트도 없다.
- 모델: `Xenova/multilingual-e5-small`(양자화), `~/.harness-memory/models`(`embeddings.cache_dir`)에 캐시. 다운로드는 임베딩이 켜져 있고 모델이 없을 때 한 번만 일어난다; 당신의 추출 CLI 외에 유일한 네트워크 접근이다.
- worker는 추출 직후 새 행을 임베딩하고(`passage:` 접두어) `hm dream`이 나머지를 백필한다; `dense.v1.bin`은 임베딩을 가진 행이 하나라도 있을 때만 쓰인다.
- **한국어와 기타 별칭에는 임베딩이 필요 없다:** 추출기는 fact마다 최대 여덟 개의 `aliases`를 내고(프롬프트가 영어가 아니면 사용자 언어로), lexical 스냅샷은 코드 인식·한글 조사 제거 토크나이저로 이를 색인하므로 한국어 프롬프트가 BM25로 영어 메모리에 닿는다.

## 설정

`.harness-memory/config.json`(스키마 `config.v1`). 알 수 없는 키는 무시되고 잘못된 값은 기본값으로 돌아가므로, 잘못된 설정이 훅을 깨뜨리는 일은 없다.

| 키 | 기본값 | 의미 |
|---|---|---|
| `autonomy_level` | `standard` | `off` / `shadow` / `standard`(위 참고) |
| `before_tool.max_items` / `max_bytes` | 3 / 2048 | `PreToolUse` 주입 예산 |
| `before_tool.auto_enforcement` | `advise` | 시그니처가 있는 교정/실패 유래 auto 피트폴이 태어나는 수준(`advise` 또는 `soft_deny`) |
| `before_tool.auto_escalation.enabled` / `sessions` | true / 2 | 자율성 사다리: auto `advise` 피트폴의 증거가 이만큼의 세션에 걸치면 `soft_deny`가 된다 |
| `before_tool.hard_policy` | `confirm` | 시그니처가 있는 hard human policy의 기본값(`confirm`, `advise`, `deny`) |
| `before_model.max_items` / `max_bytes` | 5 / 3072 | `UserPromptSubmit` 주입 예산 |
| `before_model.min_score` | 0.35 | non-baseline 행의 정규화 BM25 임계(`s / (s + 1)`) |
| `before_model.dense` | `helper` | `helper`(`embeddings.enabled`일 때 임베딩 helper 사용) 또는 `off` |
| `before_model.dense_timeout_ms` | 80 | prompt 훅이 helper를 기다리는 시간 |
| `before_model.recall.max_items` / `max_bytes` / `min_score` | 2 / 1024 / 0.5 | `UserPromptSubmit`에서 메모리 항목 뒤에 붙는 회상 항목 |
| `recall.enabled` / `keep_episodes` | false / 300 | 회상 레이어(에피소드 요약, `snapshot/recall.v1.json`, `hm recall`); 쓸모가 증명될 때까지 기본 꺼짐 |
| `session_start.max_items` / `max_bytes` | 5 / 3072 | 시작 예산 |
| `after_tool.max_items` / `max_bytes` | 2 / 1024 | 실패 힌트 예산 |
| `extraction.provider` | `auto` | `auto`, `claude`, `codex`, `replay`(`HARNESS_MEMORY_PROVIDER`가 덮어쓴다) |
| `extraction.model` | `null` | 헤드리스 CLI의 `--model`. `null`이면 claude provider는 `sonnet` 별칭을 넘기고(`~/.claude/settings.json`의 대화용 기본 모델은 헤드리스 first-party 호출이 못 쓰는 게이트웨이 id일 수 있다) codex는 자기 기본값을 쓴다 |
| `extraction.max_runs_per_day` | 40 | 하루 LLM 호출 수; 교정 에피소드는 예외 |
| `extraction.max_auto_activations_per_day` / `_per_episode` | 10 / 3 | 자동 활성화 캡 |
| `extraction.timeout_ms` / `probe_timeout_ms` / `lease_seconds` | 120000 / 20000 / 180 | provider 벽시계, probe 벽시계, 에피소드 lease |
| `embeddings.enabled` / `model` / `idle_exit_minutes` / `cache_dir` | false / `Xenova/multilingual-e5-small` / 15 / `null`(= `~/.harness-memory/models`) | 임베딩 helper |
| `dream.interval_hours` | 6 | consolidation 주기(`SessionEnd`에서 확인) |
| `retention.ledger_days` / `raw_hours` / `audit_days` / `candidate_days` / `proposal_days` | 14 / 24 / 30 / 45 / 30 | GC와 만료 |
| `log.debug` / `max_bytes` / `rotations` | false / 5 MiB / 3 | hooks.log 상세도와 회전 |

환경 변수: `HARNESS_MEMORY_DISABLE=1`은 모든 훅이 아무것도 읽기 전에 종료하게 한다; `HARNESS_MEMORY_DEBUG=1`은 훅 호출마다 전체 JSON 상세 줄을 `logs/hooks.log`에 추가한다; `HARNESS_MEMORY_HOME`은 `~/.harness-memory`를 옮긴다; `HARNESS_MEMORY_CLAUDE_BIN` / `HARNESS_MEMORY_CODEX_BIN`은 추출 바이너리를 고정한다; `HARNESS_MEMORY_PROVIDER`는 provider를 강제한다.

## CLI 레퍼런스

바이너리 `harness-memory`, 별칭 `hm`. 모든 명령은 `--json`(기계가 읽을 수 있는 출력), `--db <path>`(데이터베이스 파일; `<x>/.harness-memory/memory.sqlite`면 프로젝트 `<x>`도 선택된다), `--root <dir>`(프로젝트 루트; 기본값: `.harness-memory/`를 가진 가장 가까운 조상, 없으면 `.git/`, 없으면 cwd)을 받는다. `hm <command> --help`는 명령의 옵션을, `hm --version`은 버전을 출력한다.

종료 코드: `0` 정상 · `1` 오류 · `2` 사용법 오류, 알 수 없는 명령, 또는 이 빌드에 없는 명령 · `75` 데이터베이스 lock이 사용 중(다른 writer가 `locks/db.lock`을 보유; 재시도).

> `hm eval:live`(라이브 3-팔 평가)만 `hm --help`에서 `(not in this build)`로 표시된다; 한 줄 설명을 출력하고 2로 종료한다.

<!-- cli-reference:start -->
| 명령 | 하는 일 |
|---|---|
| **설치** | |
| `hm install --host claude [--user] [--with-embeddings] [--hook-form auto\|exec\|shell] [--hook-script <path>] [--skip-probe] [--skip-self-test]` | 훅 등록, 데이터베이스 마이그레이션(백업 먼저), 스냅샷 빌드, 추출 provider probe, 훅 self-test. `--user`는 `~/.claude/settings.json`에 쓴다; `--with-embeddings`는 `@xenova/transformers`를 설치하고 밀집 검색을 켠다. |
| `hm uninstall [--purge] [--user]` | 매니페스트가 가리키는 훅 항목, `.git/info/exclude` 줄, 매니페스트를 제거한다; `--purge`는 `memory.sqlite.bak-v<N>`을 제외한 `.harness-memory/`도 삭제한다; `--user`는(매니페스트가 없을 때) `~/.claude/settings.json`도 정리한다. |
| `hm doctor [--fix] [--host-debug <path>] [--self-test] [--hook-script <path>]` | 매니페스트 대 등록된 훅, node 경로, `hooks.log`의 이벤트별 마지막 호출과 p95, 데이터베이스(`quick_check`, `user_version`), 스냅샷 신선도, 도달 불가 메모리, 큐 깊이, 마지막 추출, probe, lock, 임베딩, Git Bash를 교차 확인한다. `--fix`는 옮겨진 node / 훅 경로를 다시 쓰고 스냅샷을 재빌드한다; `--self-test`는 `session-start` 훅을 한 번 실행한다; `--host-debug`는 Claude Code 디버그 로그의 `finished with status N` 줄을 센다. |
| `hm db:migrate` | lock 아래에서 대기 중인 스키마 마이그레이션을 적용하고(`memory.sqlite`를 `.bak-v<N>`으로 먼저 복사) 스냅샷을 재빌드한다. |
| `hm db:rollback [--to <version>] [--yes]` | y/N 확인 뒤(`--yes` / `-y`는 TTY가 없을 때) `memory.sqlite.bak-v<N>`(기본: 최신)을 복원한다; 교체된 파일은 `memory.sqlite.rollback-<ts>`로 남기고 `.prev`와 스냅샷을 제거한다. 다음 writer가 다시 앞으로 마이그레이션하므로 먼저 다운그레이드하거나 `hm uninstall` 할 것. |
| `hm snapshot:rebuild` | 데이터베이스에서 `snapshot/active.v1.json`, `lexical.v1.json`, `recall.enabled`이면 `recall.v1.json`(그리고 `dense.v1.bin`)을 재빌드한다; 필요하면 먼저 마이그레이션한다. |
| **상태** | |
| `hm status` | 한 줄: `active N (auto M) \| candidates C \| proposals P (E expiring) \| queue Q (waiting: reason) \| last extraction <ago> <status> \| probe <result> \| snapshot fresh\|stale\|missing \| p95 <ms>`, provider가 주의를 요하면 `probe:` 힌트 한 줄 추가. 설치되지 않았으면 종료 1. |
| **리뷰** | |
| `hm review [--json] [--list] [--keys <a,r,s,p,q>] [--accept-all-kind <kind>]` | 위에 설명한 순서로 제안, 후보, 미확인 import를 대화형으로 리뷰한다(키 `a` / `r` / `s` / `t` / `p` / `q`). 비대화형 경로: `--list`는 묻지 않고 큐만 출력, `--keys`는 쉼표로 구분한 키 순서를 큐에 차례로 적용(스크립트·테스트용), `--accept-all-kind`와 `--json`은 비대화형 경로다. |
| `hm proposals:list [--kind <kind>]` | 열린 제안을 나열한다. |
| `hm proposals:accept <id> \| --kind <kind> --all` | 제안 하나, 또는 한 종류의 열린 제안 전부를 수락한다. |
| `hm proposals:reject <id>` | 제안을 거부한다(같은 주장은 30일 동안 건너뛴다). |
| **메모리** | |
| `hm memory:list [--status <s>] [--type <t>] [--authority <a>] [--source <k>] [--scope <glob>] [--unconfirmed] [--contested] [--limit <n>]` | 메모리를 나열한다 — 기본은 살아 있는 행(`candidate`, `active`, `stale`), `--status all`이면 모든 상태 — 타입, authority, source kind, 정확한 scope, 미확인 import, contested 행으로 필터링한다(기본 최대 200행). |
| `hm memory:show <id>` | 메모리 하나를 시그니처, scope, authority, enforcement, 카운터, TTL과 함께 보여 준다. |
| `hm memory:add --type <t> --summary <text> [--scope <glob>] [--details <text>] [--triggers <a,b>] [--signature <spec>] [--tools <a,b>] [--enforce <level>] [--aliases <a,b>] [--policy-subtype <s>] [--confidence <n>] [--importance <n>] [--active]` | 사람 메모리를 추가한다(`authority = human`, `source_kind = manual`) — 기본은 `hm review`용 사람 후보, `--active`면 즉시 active. `--signature`는 `tool:target:kind:pattern`(예: `bash:command:cmd:npm test`; 부정은 앞에 `!`); 트리거, 툴, enforcement는 타입과 시그니처에서 기본값을 받는다. |
| `hm memory:promote <id>` | 후보(또는 stale 행)를 사람으로서 active로 승격한다 — 행은 `human`이 되고 TTL을 잃는다. |
| `hm memory:demote <id>` | active 메모리를 강등한다. |
| `hm memory:reject <id> [--note <text>]` | 메모리를 거부한다(선택적으로 메모를 남긴다). |
| `hm memory:restore <id>` | 거부된 / stale / superseded 메모리를 active로 되돌린다. |
| `hm memory:enforce <id> <advise\|confirm\|soft_deny\|deny>` | enforcement 수준을 설정한다(사람 편집: 행은 `human`이 된다). |
| `hm memory:history <id>` | 상태 전이, 출처, 그리고 — 한 릴리스 동안 — `legacy_*` 테이블의 v0.5 dream 이력. |
| `hm memory:export [--out <file>]` | 데이터베이스의 결정적 SQL 덤프(같은 내용 → 같은 바이트). |
| `hm memory:export-skill [--out <dir>] [--min-confidence <n>] [--min-importance <n>]` | 성숙한 메모리(confidence와 importance가 임계 이상)를 `SKILL.md` 파일로 내보낸다; 기본 디렉터리는 `.harness-memory/skills`. |
| `hm memory:stats [--since <iso>]` | 상태 / authority / 타입별 카운트, 하루 리뷰 부하(게이트: ≤ 3), 최근 자동 활성화, 기간 내 override 분포(기본: 최근 7일). |
| `hm memory:why --tool <name> --target <text> [--input <json>] [--session <key>] [--permission-mode <m>]` | 툴 호출에 무엇이 발화할지 설명한다: 활성화된 항목, 이유와 함께 억제된 항목(`signature_mismatch`, `already_fired`, `scope_mismatch`, …), 일치한 정책 규칙. `--tool`은 호스트 이름(`Bash`, `Edit`, `mcp__server__tool`) 또는 정규 이름을 받는다; `--input`은 `--target` 대신 원시 `tool_input` JSON을 넘긴다; `--session`은 그 세션의 ledger에서 "이 턴에 이미 발화함"을 끌어온다; `--permission-mode`는 `bypassPermissions` / `dontAsk`를 흉내 낸다. |
| `hm memory:trace <id>` | 메모리 뒤의 에피소드와 추출 run. |
| **파이프라인** | |
| `hm queue [list\|show <id>\|retry <id>\|drop <id>]` | 추출 큐(`queued`, `leased`, `failed`, `dead` 에피소드)를 조회하거나 편집한다. |
| `hm extract [--now] [--provider <name>] [--dry-run]` | 추출 worker를 전경에서 실행한다; `--dry-run`은 provider를 호출하지 않고 프롬프트만 렌더한다. |
| `hm dream` | consolidation을 지금 실행한다(TTL, 만료, override 강등, merge 제안, 임베딩 백필, GC). |
| `hm trace <session_key>` | 세션의 ledger 타임라인: 프롬프트, 발화한 메모리, 툴 호출, 실패와 해결. |
| `hm recall <query> [--limit <n>] [--since <iso>]` | 과거 에피소드를 요약으로 검색한다 — `recall.enabled`일 때 `before_model`이 회상하는 바로 그것: 날짜, 세션(`<host>-<key>`, 그대로 `hm trace`에 쓸 수 있음), 종류(`extracted` = 추출기의 요약, `derived` = worker의 결정론적 요약), 요약을 관련도 높은 최신순으로 출력한다. 스냅샷이 신선하면 `snapshot/recall.v1.json`을, 아니면 데이터베이스를 읽는다(어느 쪽인지 말해 준다). `--since`는 `closed_at` 기준; 점수 임계는 적용하지 않는다. recall이 꺼져 있으면 그렇다고 알리고 exit 0. |
| **Import** | |
| `hm import [--from <file>] [--from auto-memory] [--auto-memory] [--include-project] [--memory-dir <dir>] [--yes] [--sync] [--dry-run] [--provider <name>]` | `CLAUDE.md` / `AGENTS.md` / `.cursorrules`의 불릿을 — 또는 `--from auto-memory`(`--auto-memory`)로 Claude Code 내장 auto memory(`~/.claude/projects/<slug>/memory/`)의 `type: feedback` 노트를(`--include-project`는 `type: project`도, `--memory-dir <dir>`는 유도되지 않는 디렉터리를 지정) — import 에피소드로 쪼개고, 추출기를 `action = create`로 돌리고, 확인 표를 보여 준 뒤 확인된 행을 `source_ref = import:<file>#L<n>`(`import:auto-memory:<file>#L<n>`)의 `human` / `import` 메모리로 삽입한다. 아직 타입을 붙일 수 없는 불릿(추출 CLI 없음)은 그대로 `advise` 행으로 저장했다가 나중에 타입을 붙인다. `--yes`는 확인을 건너뛴다(`import_unconfirmed = 1`, enforcement 상한 `advise`, `hm review`에 표시); `--sync`는 불릿이 사라진 행을 stale로 보낸다(auto-memory는 디렉터리 전체 기준); `--dry-run`은 미리 보기. 재실행은 라인 해시로 멱등이다. |
| **평가** | |
| `hm eval:latency [--local] [--runs <n>] [--threshold <ms>] [--memories <n>] [--large] [--hook-script <path>]` | 생성한 300 메모리 픽스처에 대해 `dist/hook.js pre-tool`을 50회 스폰해 min / p50 / p95 / max를 보고한다; p95가 예산(기본 90 ms, `--threshold`)을 넘으면 1로 종료. `--local`은 픽스처 대신 설치된 프로젝트를 측정, `--large`는 2,000 메모리 참고 측정을 추가, `--hook-script`는 다른 `dist/hook.js`를 지정. |
| `hm eval:replay [--scenario <ids>] [--fixtures <dir>] [--keep] [--verbose]` | 기록된 ledger 픽스처 s01–s12를 실제 훅과 worker(replay provider)로 재생하고 시나리오 단언을 확인한다(저장소 체크아웃의 `test/fixtures/replay` 또는 `--fixtures` 필요); 실패한 검사가 있으면 1로 종료. `--keep`은 시나리오별 임시 프로젝트를 남긴다. |
| `hm eval:live` | 라이브 3-팔 평가(마크다운 전용 / 네이티브 auto-memory / harness-memory) — 이후 릴리스. |
<!-- cli-reference:end -->

이름과 플래그는 디스패처(`src/cli/registry.ts`와 `src/cli/commands/`의 명령 모듈)에서 가져온 것이다; 이 표와 디스패처가 어긋나면 `test/docs-cli-reference.test.ts`가 실패한다.

## 문제 해결

**먼저 `hm status`를 읽는다.** `active 12 (auto 4) | candidates 3 | proposals 1 | queue 2 (waiting: not_logged_in) | last extraction 3h ago ok | probe not_logged_in | snapshot fresh | p95 61ms`는 발화할 수 있는 행이 몇 개인지, 무엇이 리뷰를 기다리는지, 에피소드가 막혀 있는지와 그 이유, provider가 동작하는지, 훅이 최신 스냅샷을 읽는지, `PreToolUse`가 얼마나 느린지를 말해 준다. 그다음 `hm doctor`.

| 증상 | 의미 / 할 일 |
|---|---|
| `probe not_logged_in`, `queue N (waiting: not_logged_in)` | 헤드리스 `claude -p`가 인증되지 않았다(데스크톱 앱 로그인은 이어지지 않는다). 터미널에서 `claude auth login`(구버전 CLI: `claude` 실행 후 `/login`); worker가 10분 안에 다시 probe하고 큐를 비우며, 바로 다시 probe하려면 `hm install --host claude`를 실행한다. 그동안 잃는 것은 없다. |
| `probe missing` | `claude` / `codex` 바이너리를 찾지 못했다. 하나를 설치하거나 `HARNESS_MEMORY_CLAUDE_BIN` / `HARNESS_MEMORY_CODEX_BIN`을 설정한다. |
| `probe nested_refusal` | probe가 Claude Code 세션 안에서 돌았다(`CLAUDECODE` 상속). `hm install` / `hm extract`를 일반 터미널에서 실행한다. |
| `probe provider_error` | 헤드리스 CLI는 떴지만 API 호출이 실패했다; `hm status`와 `hm doctor`가 provider의 메시지를 결과 옆에 보여준다(예: `api 404: There's an issue with the selected model …`). `.harness-memory/config.json`의 `extraction.model`을 계정이 쓸 수 있는 모델로 정하고(기본값은 `sonnet` 별칭) `hm install --host claude`로 다시 probe한다. |
| `probe invalid_output` / `probe_timeout` | `claude -p --output-format json --json-schema`가 `extraction.probe_timeout_ms` 안에 구조화 출력을 돌려주지 않았다. 터미널에서 `claude -p`를 확인한다; 실패 결과는 10분 뒤 다시 시도된다. |
| 아무것도 발화하지 않고 `hooks.calls`가 모든 이벤트에 `never` | Claude Code가 훅을 호출하지 않는다: `.claude/settings.local.json`(`hm doctor`가 매니페스트와 비교한다), Claude Code를 *이 프로젝트에서* 열었는지, node 경로(`install.node`)를 확인한다. `hm doctor --self-test`는 Claude Code가 하는 것과 똑같이 훅을 실행한다. |
| `install.node FAIL` / `install.hook_script FAIL` | 기록된 node 바이너리나 `dist/hook.js`가 옮겨졌다(nvm 전환, 패키지 재설치, npx 캐시 정리). `hm doctor --fix`. |
| `snapshot stale`이 1분 넘게 지속 | 훅이 스냅샷보다 새로운 데이터베이스를 보고 reindex를 요청했지만(`snapshot/.reindex-requested`, 60 s에 한 번) `node dist/worker.js <root> reindex`가 돌지 않았다 — `logs/worker.log`를 보거나 `hm snapshot:rebuild`를 실행한다. |
| `queue`가 늘고 `hm doctor`에 `dead` 에피소드 | 세 번 실패(1 h / 6 h 백오프)하면 에피소드는 `dead`가 된다; `hm queue show <id>`에 `last_error`가 있고 `hm queue retry <id>`가 다시 큐에 넣는다. |
| 종료 코드 `75` | 다른 writer(worker 또는 CLI)가 `locks/db.lock`을 보유하고 있다. 재시도; 오래된 lock(heartbeat > 120 s 또는 죽은 pid)은 자동으로 인수되며 `hm doctor`(`locks.db`)가 보고한다. |
| `database … is newer than this build` | 더 새로운 harness-memory가 데이터베이스를 마이그레이션했다; 패키지를 업그레이드한다. 훅과 읽기 전용 명령은 계속 동작한다. |
| 메모리가 너무 자주 / 엉뚱하게 발화 | `hm memory:why --tool bash --target "<command>"`가 모든 억제를 설명한다; `hm memory:enforce <id> advise`가 행을 낮춘다; 세 번 override된 auto 행은 스스로 강등된다. |
| `confirm` 정책이 묻지 않는다 | `permission_mode`가 `bypassPermissions` / `dontAsk`면 물어볼 사람이 없으므로 `confirm`은 `soft_deny`가 된다(`fired` 라인의 `delivery = before_downgraded`). |
| Windows: Claude Code가 `PowerShell` 툴을 보여 준다 | Git Bash가 없다; 메모리는 여전히 일치한다(정규형 `bash`). `hm doctor`가 `env.git_bash`를 보고한다. |

**`logs/hooks.log`**에는 훅 호출당 한 줄이 남는다:

```text
2026-11-08T12:00:01.234Z pre-tool tool=bash gen=42 activated=1 suppressed=17 decision=deny delivery=before enforcement=soft_deny dur=48ms ok
```

`status`는 `ok`, `bad_stdin`, `snapshot_missing`, `disabled`, `not_installed`, `skipped:<reason>`, `error:<code>` 중 하나이고 `gen`은 스냅샷의 `db_generation`이다. `HARNESS_MEMORY_DEBUG=1`(또는 `log.debug: true`)은 전체 상세(활성화된 id, 억제 종류, 규칙 일치)를 담은 JSON 줄을 추가한다. 훅은 호스트를 절대 실패시키지 않는다: 어떤 예외든 로그 한 줄, stdout `{}`, 종료 0이 된다. `logs/worker.log`에는 worker의 lease / 추출 / 종료 줄이 있다(`lease … waiting=<reason>`이 큐를 막는 원인을 말한다). harness-memory를 배제해 봐야 할 때는 Claude Code 환경에 `HARNESS_MEMORY_DISABLE=1`을 두면 모든 훅이 즉시 종료한다.

## 프라이버시와 보안

- **계정도, 텔레메트리도, 서버도 없다.** 모든 것은 `<project>/.harness-memory/`와 `~/.harness-memory/`에 있다. 네트워크와 통신하는 프로세스는 (1) 당신이 이미 쓰는 추출 CLI — 분리된 worker가 당신의 로그인으로 호출하는 `claude -p` 또는 `codex exec` — 와 (2) `--with-embeddings`를 켰을 때 한 번 일어나는 선택적 임베딩 모델 다운로드뿐이다.
- **추출기가 보는 것.** 자격 있는 에피소드에 대해: 당신의 프롬프트 텍스트(≤ 4,000자), 그 턴의 툴 호출 다이제스트(명령 텍스트 또는 저장소 상대 경로, ≤ 500자), 실패·해결 호출의 툴 출력 head/tail(2,000 / 1,000자)과 오류 텍스트(1,500), 마지막 assistant 메시지(≤ 2,000), 턴이 교정일 때 직전 턴의 ≤ 12 툴 라인, 그리고 기존 메모리 최대 40건(id, type, status, authority, scope, signature, summary). transcript 파일은 절대 보지 않고, 툴 출력이 이미 보여 준 것 이상의 파일 내용도 보지 않는다. 호출은 `--tools ""`, 모든 훅과 auto-memory 비활성화, 세션 비저장, 허용 목록 환경, 모든 저장소 밖의 cwd로 실행된다.
- **무엇이든 쓰기 전에 마스킹.** ledger 라인은 먼저 `redactCredentials`를 거친다: 개인 키 블록, `sk-ant-…`, `sk-…`, GitHub `ghp_…` / `github_pat_…`, GitLab `glpat-…`, npm `npm_…`, Stripe `sk_live_…` / `sk_test_…`, AWS `AKIA…`, Slack `xox…` / `xapp-…`, Google `AIza…`, JWT, `Bearer …`와 `Basic …` 헤더, 어떤 스킴이든 URL 안의 자격 증명(`postgres://user:pass@`), `curl -u user:pass`, `--password …`, `mysql -p…`, 그리고 키 이름이 password / secret / token / API key를 뜻하는 `KEY=value` / `"key": "value"` / `key: value` 대입(`DB_PASSWORD=`, `AWS_SECRET_ACCESS_KEY=`, `accessToken:`)은 `<redacted>`가 된다; `$VAR` 참조는 남긴다. 같은 마스킹이 `scope_refs`, `failure_sig`, `program_token`(토큰당 256자, 합계 4,000자 상한)과 import한 bullet 텍스트에도 적용된다.
- **추출된 텍스트는 스캔된다**(보이지 않는 유니코드와 제어 문자, "ignore previous instructions" / "이전 지시를 무시" 같은 영어·한국어 프롬프트 주입 문구, 자격 증명 대입, 은폐하거나 사용자를 따르지 말라는 지시) 그리고 harness-memory, 그 명령, 메모리 id를 언급하는 fact는 거부되므로(V6) 모델이 툴 출력을 통해 스스로에게 규칙을 써 넣을 수 없다. 추출 프롬프트는 기록된 이벤트, 직전 턴, 마지막 assistant 메시지, 기존 메모리 목록을 데이터 울타리로 감싸고 울타리 안은 지시가 아니라 데이터라고 명시한다; 저장된 텍스트가 스캔에 걸리는 legacy 후보는 강화는 되어도 자동 활성화되지 않는다.
- **훅은 읽기 전용이다.** 데이터베이스를 열지 않고 lock을 쥐지 않으며 모든 경로에서 종료 0을 돌려준다; 유일한 쓰기는 ledger, 세션 state, 큐 파일이다. `PreToolUse`는 절대 `allow`를 내보내지 않으므로 당신의 권한 프롬프트를 넓힐 수 없다.
- **보존.** ledger 세그먼트 14 d, provider 원본 출력 24 h, audit 로그 30 d, hooks.log 5 MB × 3 — `retention` / `log`로 설정 가능. `hm uninstall --purge`는 `memory.sqlite.bak-v<N>` 백업을 제외한 전부를 제거한다.

## 0.5에서 업그레이드

v0.5는 다른 쓰기 경로(대화 버퍼 → evidence 행 → dream consolidation → 사람이 리뷰하는 승격)를 가진 OpenCode 플러그인이었다. v0.6은 당신의 `memory.sqlite`와 다섯 타입 / 네 트리거를 유지하면서 그 주위를 모두 다시 짓는다:

- `hm install --host claude`는 `user_version` 9 / 10 / 16 → **21**로 마이그레이션한다(마이그레이션 017–021), 파일을 `memory.sqlite.bak-v<N>`으로 복사한 뒤에. 메모리 행은 하나도 삭제되지 않는다. 모든 행은 `authority`를 받는다: `candidate` 행과 자동 승격된 행은 `auto`, 그 외는 `human`; scope `**/*`에 `before_model`만 있는 v0.5 LLM 행은 `needs_scope = 1`과 `hm review`의 `fix_scope` 제안(90 d)을 받는다; v0.5 dream 테이블은 `legacy_*`로 이름이 바뀌고(한 릴리스 동안 `hm memory:history`가 읽는다), 템플릿 후보는 거부되며, 중복된 살아 있는 행은 `merge` 제안을 받는다.
- OpenCode는 **0.6.0에서 지원되지 않는다**(V2 플러그인은 0.6.2; Codex 훅은 0.6.1). `opencode.json`의 v0.5 플러그인 항목(그리고 `.opencode/package.json`, `.opencode/commands/harness-memory-*.md`)은 직접 제거할 것; `hm uninstall --purge`가 레거시 `.conversation-buffer.json` / `.dream-extract-state.json` 파일을 제거한다.
- `hm db:rollback`은 마이그레이션 전 백업을 복원한다; 다음 writer가 다시 앞으로 마이그레이션하므로 0.5로 돌아갈 생각이면 먼저 `hm uninstall` 할 것.

상세, 마이그레이션 표, 옛 → 새 명령 대응표는 [docs/redesign/upgrade-from-0.5.md](docs/redesign/upgrade-from-0.5.md)(영문)에 있다.

## 로드맵

- **0.6.0** — Claude Code(이 릴리스). 게이트: `eval:replay` 녹색, `eval:latency` p95 ≤ 90 ms, 2주 dogfood에서 활성 일당 리뷰 항목 ≤ 3, autonomy regret(거부된 자동 활성화 비율) ≤ 10 %.
- **0.6.1** — Codex 호스트(`.codex/hooks.json`, `apply_patch`, `turn_id`, `codex exec` provider).
- **0.6.2** — OpenCode V2 플러그인(`Plugin.define`, `permission.assert`, context 훅).
- **0.7** — 글로벌 메모리 동기화, auto↔auto 병합, heeded-fire 추론, 스냅샷 buckets, `legacy_*` 테이블 삭제.

## 개발

```bash
npm install
npm run build            # tsup → dist/hook.js, hook-bundle.js, worker.js, embed-helper.js, bin/harness-memory.js (+ 마이그레이션)
npm test                 # vitest
npm run typecheck        # tsc --noEmit
npm run package:verify   # pack → 임시 프로젝트에 tarball 설치 → hm install / status / doctor 실행
```

| 디렉터리 | 역할 |
|---|---|
| `src/core/` | 공용 계약: 어휘, ledger / 에피소드 / 추출 / 스냅샷 / 훅 타입, 설정, 경로, id, 오류, 프로세스 헬퍼 |
| `src/adapters/` | 훅 코어(`runHook`), 훅 I/O, Claude Code 호스트 어댑터, 세션 state |
| `src/activation/` | 스냅샷 리더, `before_tool` / `before_model` / `session_start` / `after_tool` 선택, 시그니처 정규화와 매칭, 툴 어휘, lexical 스냅샷, ActivationEngine |
| `src/dream/` | ledger, 에피소드, 추출 프롬프트 / 스키마 / 검증, provider(`claude`, `codex`, `replay`), reconcile, consolidate, worker |
| `src/promotion/` | `transitionMemory`와 §4.7 전이 표, `decideTier` / `enforcementDefault`, 제안, 재검증 |
| `src/policy/` | 정책 엔진(툴 + 인자 시그니처 매칭)과 규칙 파생 |
| `src/db/` | Store(lock → load → migrate → 트랜잭션 → 원자 저장 → 스냅샷), lock, 마이그레이터, 마이그레이션 001–021, 저장소, 스냅샷 빌더 |
| `src/memory/` | `MemoryRepository` |
| `src/embed/` | 임베딩 helper, 클라이언트, `dense.v1.bin` 코덱 |
| `src/cli/` | `hm` 디스패처, 공용 lib, 명령 모듈 |
| `src/security/` | 콘텐츠 스캐너 |

설계 문서: [docs/redesign/spec-v0.6.md](docs/redesign/spec-v0.6.md)(한국어, 권위 있는 설계), [docs/redesign/implementation-plan.md](docs/redesign/implementation-plan.md), [docs/redesign/m0-facts.md](docs/redesign/m0-facts.md)(실제 머신에서 측정한 사실), [docs/redesign/phase-a-notes.md](docs/redesign/phase-a-notes.md)와 [docs/redesign/phase-b-notes.md](docs/redesign/phase-b-notes.md)(모듈 API). `docs/product/`와 `docs/spec/`의 페이지는 v0.5를 설명하며 그렇다는 배너가 붙어 있다.

영문 README: [README.md](README.md). 변경 이력: [CHANGELOG.md](CHANGELOG.md).

## 라이선스

MIT
