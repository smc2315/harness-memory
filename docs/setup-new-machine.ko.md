# 새 컴퓨터에서 harness-memory 0.6.0-rc.1 설치하기

두 번째 컴퓨터(Windows 11, macOS, Linux 또는 WSL)에서 dogfood를 시작할 때 위에서부터 따라 하는 체크리스트다. [README.ko.md](../README.ko.md)의 요약이 아니라, 새 기계에서만 생기는 문제를 모아 둔 것이다. 설치·훅·집행 경로(§2–§4, §6의 `memory:why`, §9의 uninstall)는 2026-11-09에 rc.1 tarball을 Windows 11(Node 24)과 WSL Ubuntu 22.04(Node 24, 20)의 새 npm prefix에 설치해 실제로 확인했다; §7의 sudo 없는 우회 경로와 macOS는 확인하지 않았다(`docs/redesign/phase-f-notes.md`의 "Fresh-machine verification" 절).

## 0. 시작 전 확인 (5분)

- 이 기계를 적어 둔다: OS, 셸(PowerShell 5.1 · pwsh · Git Bash · zsh), WSL 사용 여부, **Claude Code가 도는 쪽**(Windows 데스크톱 앱 / 터미널 CLI / WSL). 설치는 Claude Code가 도는 쪽에서 한다.
- `node --version` — 20 이상. nvm이면 계속 쓸 버전으로 `nvm use <v>` + `nvm alias default <v>`: 훅은 `hm install`을 실행한 **그 node의 절대 경로**를 기록하고, 그 버전을 지우면 훅이 조용히 멈춘다(`hm doctor --fix`로 복구). Homebrew의 node는 `brew upgrade node`가 옛 버전을 지우므로 업그레이드 뒤 프로젝트마다 `hm doctor --fix`가 필요하다(install이 경고한다).
- `npm prefix -g` — 이 경로(POSIX는 그 아래 `bin`)가 PATH에 있어야 `hm`이 잡힌다.
- `claude --version`, `claude auth status` — CLI가 PATH에 있는지, 로그인됐는지. **학습에만** 필요하고 집행(import·`memory:add` 규칙의 deny/ask)은 로그인 없이 동작한다. 데스크톱 앱만 있으면 터미널에 `claude`가 없다: winget `Anthropic.ClaudeCode`, 네이티브 설치기, 또는 `npm install -g @anthropic-ai/claude-code`.
- 옛 흔적: `harness-memory --version`이 `0.5.1`이면 OpenCode 플러그인이 남아 있는 것(0.5에는 `hm` 바이너리가 없었다). `npm ls -g harness-memory`.

## 1. 0.5.1 제거 (있을 때만)

```bash
npm uninstall -g harness-memory
```

플러그인을 쓰던 프로젝트에서는 `opencode.json`의 plugin 항목, `.opencode/package.json`의 의존성, `.opencode/commands/harness-memory-*.md`를 손으로 지운다. `~/.harness-memory/global.sqlite`는 그대로 둔다. 0.5와 0.6이 같은 `.harness-memory/memory.sqlite`를 동시에 쓰면 안 된다(0.6이 0.5가 열 수 없는 스키마로 옮긴다).

## 2. rc 설치

```bash
npm install -g https://github.com/smc2315/harness-memory/releases/download/v0.6.0-rc.1/harness-memory-0.6.0-rc.1.tgz
hm --version      # 0.6.0-rc.1
```

- npm의 `latest`는 아직 0.5.1이다. `npm install -g harness-memory`, `npx harness-memory …`는 옛 플러그인을 가져오니 쓰지 않는다. git에서 설치(`github:smc2315/harness-memory#redesign/v0.6`)도 안 된다: `dist/`가 없고 빌드는 `prepack`에서만 돈다.
- 나중에 `next` 태그로 공개되면 `npm install -g harness-memory@next`, 0.6.0이 `latest`가 되면 `npm install -g harness-memory`.
- 전역 대신 프로젝트별로 쓰려면 `npm install -D <같은 URL>` 뒤 `npx hm …`.
- 설치는 6개 패키지, 45 MB, 네이티브 빌드 없음(sql.js는 WASM). sudo가 필요한 prefix(`/usr/local`에 설치된 node)라면 `npm config set prefix ~/.npm-global`과 PATH 추가가 낫다.

## 3. `hm`이 안 잡힐 때

- 새 터미널을 연다(PATH는 터미널 시작 시점의 것이다). `npm prefix -g` 경로가 PATH에 있는지 본다 — Windows 기본 `%APPDATA%\npm`, nvm `~/.nvm/versions/node/<v>/bin`, Homebrew `/opt/homebrew/bin`.
- 임시로: `node "$(npm root -g)/harness-memory/dist/bin/harness-memory.js" --version`.
- **Windows PowerShell에서 `hm.ps1 cannot be loaded because running scripts is disabled on this system`** — Windows 기본 실행 정책(Restricted) 아래에서 npm의 PowerShell 심(shim)이 막힌 것이다. `npm` 자체도 같은 식으로 실패하므로 npm이 되는 PowerShell이면 `hm`도 된다. 한 번만 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, 또는 `hm.cmd` / cmd.exe / Git Bash를 쓴다. 훅은 심을 거치지 않고 `node.exe`를 직접 실행하므로 영향이 없다.
- **WSL/Linux에서 `/usr/bin/env: 'node': No such file or directory`** — `hm`은 `#!/usr/bin/env node` 스크립트라 CLI를 쓰는 셸에 `node`가 PATH에 있어야 한다(nvm은 `nvm.sh`를, 사용자 공간 node는 그 env 스크립트를 source). 훅은 절대 경로의 node를 쓰므로 영향이 없다. WSL에서는 `/tmp`가 부팅마다 지워지니 prefix나 node를 `/tmp`에 두지 않는다.
- `harness-memory --version`이 0.5.1이면 다른 Node의 전역 디렉터리가 먼저 잡힌 것이다: 그 Node에서 `npm uninstall -g harness-memory`.

## 4. 프로젝트에 설치

```bash
cd <project>
hm install --host claude
hm doctor --self-test
hm status
```

- **일반 터미널에서** 실행한다. Claude Code 안의 셸에서 돌리면 probe가 `nested_refusal`로 끝날 수 있다(README 문제 해결 표); 그러면 일반 터미널에서 `hm install --host claude`를 다시 실행하거나 `--skip-probe`로 넘기고 나중에 다시 probe한다. WSL에서 Claude Code를 쓰면 WSL 안에서 설치한다: 훅 명령은 리눅스 node 경로여야 하고, `/mnt/c` 아래 체크아웃은 `.claude/settings.local.json`이 하나뿐이라 한쪽만 고른다.
- 출력에서 확인할 것: `hooks 9 events → .claude/settings.local.json (exec form)`, `node <절대경로>  (claude x.y.z)`(버전이 없으면 CLI를 못 찾은 것), `database … v22 (created)` — v0.5 DB가 있던 프로젝트면 `v22 (migrated from v9, backup …bak-v9)`, `provider claude — probe ok` 또는 `not_logged_in`, `self-test session-start ok`.
- `hm doctor`: FAIL 0이어야 한다. 로그인 전의 정상 WARN은 `extraction.probe probe not_logged_in`(첫 Stop 뒤에는 `extraction.waiting`도)과 Git Bash 없는 Windows의 `env.git_bash`뿐이다. INFO 줄(`queue.depth`, `extraction.last_run`, `extraction.worker`, `embeddings off`, `hooks.p95`)은 정상이다.
- v0.5 DB가 있던 프로젝트: 설치 전에 `memory.sqlite` 사본을 하나 더 두고(설치도 `memory.sqlite.bak-v<N>`을 만든다), 설치 뒤 `hm review`에서 `fix_scope`·`merge` 제안을 본다. 자세한 것은 [docs/redesign/upgrade-from-0.5.md](redesign/upgrade-from-0.5.md).
- 설치 출력이 제안하면 `hm import --from CLAUDE.md`, `hm import --from auto-memory`(Claude Code의 자동 메모리 노트를 사람 규칙으로). 확인 표에서 골라 승인한다.
- 옛 기계에서 가져올 것은 없다. 메모리를 옮기려면 Claude Code를 닫은 상태에서 그 프로젝트의 `memory.sqlite`(와 `config.json`)만 복사해 여기서 `hm install --host claude`를 실행한다. `.claude/settings.local.json`과 `install-manifest.json`은 옛 기계의 node·hook 경로를 담고 있으니 복사하지 않는다.
- 같은 프로젝트에 `hm install`을 다시 실행해도 된다(멱등; `.claude/settings.local.json`에서는 harness-memory 훅 항목만 교체하고 다른 훅은 그대로 둔다. DB 마이그레이션·재probe·self-test는 다시 돈다).

## 5. 로그인 (학습 켜기)

```bash
claude auth login            # 구버전 CLI: claude 실행 후 /login
hm install --host claude     # 바로 다시 probe → "probe ok"; 안 해도 worker가 10분 안에 다시 probe한다
```

- 데스크톱 앱 로그인은 `claude -p`에 적용되지 않는다.
- 로그인 전에는 `probe not_logged_in`, `queue N (waiting: not_logged_in)`이 정상이고 에피소드는 큐에 남아 유실되지 않는다.
- `probe provider_error`면 메시지를 그대로 적어 둔다(모델 404면 `.harness-memory/config.json`의 `extraction.model`을 계정이 쓸 수 있는 모델로; 기본은 `sonnet` 별칭).
- `claude`가 환경변수로 로그인·라우팅되는 기계(`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex, 회사 CA)라면 그 변수들은 worker로 전달된다; 그 밖의 변수에 로그인이 걸려 있으면 `hm doctor --json`의 probe detail을 본다.

## 6. 설치 검증 (로그인 없이도 가능)

```bash
hm memory:add --type pitfall --summary "Run pnpm test from packages/api, not npm test" --signature "bash:command:cmd:npm test" --enforce soft_deny --active
hm memory:why --tool Bash --target "npm test"     # decision: deny (soft_deny는 턴당 첫 시도만 막는다)
hm memory:why --tool Bash --target "pnpm test"    # suppressed: signature_mismatch
hm memory:list                                     # id를 확인한 뒤
hm memory:demote <id>                              # 시험용 규칙 비활성화(active → stale; 스냅샷에서 빠진다. 행은 남는다 — 삭제 명령은 없다)
```

- 그다음 Claude Code를 **이 프로젝트에서** 연다. Claude Code의 파일 감시자가 새 훅을 읽으므로 재시작은 필요 없지만, 첫 프롬프트 뒤에도 `hm doctor`의 `hooks.calls`가 모든 이벤트에 `never`면 새 세션을 연다.
- 확인: `hooks.calls`에 `session-start`, `prompt`, `pre-tool`, `stop`이 보이고 `.harness-memory/logs/hooks.log`에 줄이 늘어난다. Claude 쪽에 훅 오류가 매 호출 뜨면 Claude Code가 2.1.139보다 오래된 것이다: `hm install --host claude --hook-form shell`.
- 훅 한 번의 벽시계 시간은 node 시작이 대부분이다: Windows 11 데스크톱에서 PreToolUse 약 95–100 ms(훅 자체 10–15 ms), WSL2에서 약 50 ms. `hm status`의 p95와 `hooks.log`의 `dur=`는 훅 내부 시간이라 node 시작은 들어가지 않는다; 90 ms를 넘으면 `hm doctor`가 `hooks.p95` WARN을 내지만 설치가 깨진 것은 아니다(훅 timeout은 5 s).

## 7. 선택: 임베딩

```bash
hm install --host claude --with-embeddings
```

- 설치된 **패키지 디렉터리**(전역이면 `$(npm root -g)/harness-memory`)에 `npm install @xenova/transformers`를 돌린다. 지금 빌드는 그 package.json의 devDependencies까지 끌어와 약 350 MB, 빠른 기계에서 17 s다(0.6.1에서 `~/.harness-memory/` 아래 전용 디렉터리로 옮길 예정). sudo로 설치한 prefix에서는 쓰기 권한이 없어 실패한다(`installed with problems`; 훅은 등록된다): `hm install`을 sudo로 돌리지 말고(프로젝트에 root 소유 파일이 남는다) 패키지 옆에 `npm install -g @xenova/transformers`를 설치한 뒤(그 prefix가 요구하면 sudo로) `.harness-memory/config.json`에 `"embeddings": { "enabled": true }`를 쓴다.
- 패키지를 업그레이드하면 그 복사본이 사라지므로 `--with-embeddings`를 다시 실행한다.
- 모델(`Xenova/multilingual-e5-small`, 약 130 MB)은 첫 사용 때 `~/.harness-memory/models`에 받는다. `hm doctor`가 helper의 rendezvous 경로(Windows 명명 파이프 / `$XDG_RUNTIME_DIR` 소켓)를 보여 준다.
- dogfood 첫 주는 꺼 둔 채 lexical만으로 시작하고, 두 번째 주에 켜서 `before_model` 품질을 비교하는 편이 두 변수를 섞지 않는다.

## 8. dogfood 관찰 (매일 2분, 같은 순서로)

- `hm status` 한 줄을 그대로 기록한다(`hm status --json > <노트>/<날짜>.json`도 좋다): active/auto, candidates, proposals, queue와 waiting 이유, last extraction, probe, snapshot, p95.
- `hm memory:stats`: 리뷰 부하(릴리스 게이트: 활성일당 ≤ 3건), auto 활성화 수, fires/overrides, 에피소드 queued/extracted/skipped/failed/dead.
- `hm memory:list`: 새 auto 행의 summary·signature·enforcement가 말이 되는지. 이상한 행은 id를 적고 `hm memory:why --tool <t> --target <x>`, `hm memory:trace <id>`, `hm memory:history <id>`.
- `.harness-memory/logs/hooks.log`: 이벤트별 `dur=`, `ok`가 아닌 status(`bad_stdin`, `snapshot_missing`, `error:*`), `decision=deny` 줄.
- `.harness-memory/logs/worker.log`: 첫 Stop 뒤 `lease … waiting=<reason>`, `probe … result=`, `provider … status= model= cost_usd=`(추출 비용), `end … exit=` 줄.
- 쌓이면 `hm review`; `dead` 에피소드는 `hm queue` → `hm queue show <id>`; 세션 복기는 `hm trace <session_key>`.
- 기록할 것: 날짜, Claude Code 버전, `hm status` 한 줄, 리뷰 건수와 accept/reject, 잘못 발화·미발화 사례(명령, memory id, `memory:why` 출력), p95, probe 결과와 오류 메시지, 설치 중 막힌 지점과 해결책(README 문제 해결 표의 재료).

## 9. 업데이트 / 되돌리기

- 새 rc: `npm install -g <새 tgz URL>` → 각 프로젝트에서 `hm install --host claude` 다시(백업 후 마이그레이션, 훅 교체, 재probe, self-test). 전역 설치는 hook.js 경로가 같아 그 사이에도 훅은 돈다. `hm doctor`의 `install.manifest` 버전으로 뒤처진 프로젝트를 찾는다.
- Node 버전을 바꾸거나 지운 뒤 훅이 조용히 멈추면 `hm doctor`(`install.node FAIL`) → `hm doctor --fix`.
- 제거: `hm uninstall`(훅·exclude 줄·매니페스트만; 데이터 유지) / `hm uninstall --purge`(`.harness-memory/`까지, `memory.sqlite.bak-v<N>` 제외) / `npm uninstall -g harness-memory`. 0.5로 돌아가려면 upgrade 문서의 "Rolling back" 순서.

## 10. npm에 올리기 (작성자용)

```bash
npm login
npm publish --tag next          # prepack이 빌드한다; 깨끗한 트리에서
npm dist-tag ls harness-memory  # latest 0.5.1, next 0.6.0-rc.1
```

`latest`는 dogfood 뒤 0.6.0 정식 때 옮긴다. 그때까지 README의 설치 명령은 프리릴리스 tarball이다.

## 11. 데이터가 있는 곳

| 위치 | 내용 | 옮길 때 |
|---|---|---|
| `<project>/.harness-memory/` | `memory.sqlite`(원본), `config.json`, `snapshot/`, `ledger/`, `logs/`, `install-manifest.json` | `memory.sqlite` + `config.json`만; `.gitignore`가 `*`라 git에는 없다 |
| `<project>/.claude/settings.local.json` | 훅 9개(이 기계의 node·hook.js 절대 경로) | 복사하지 않는다; `hm install`이 새로 쓴다 |
| `~/.harness-memory/` | `worker/<repo_hash>/`(추출 CLI의 빈 cwd), `models/`(임베딩 모델 캐시), 옛 0.5 `global.sqlite` | 없음 |
| `~/.claude/` | harness-memory는 `--user`를 쓰지 않는 한 손대지 않는다 | 없음 |
