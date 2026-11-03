# dori-superagent-for-codex

[sisyphuslabs/dori-superagent](https://github.com/sisyphuslabs/dori-superagent)를 upstream으로 삼는 **Codex app-server 기반 로컬 실행기**입니다. 작업 지시서 → 작업 세션 → 증거 확인 → 정확한 커밋의 리뷰 → 머지 흐름을 유지합니다.

## 시작

Bun 1.3 이상, `app-server`를 지원하는 Codex CLI, `codex login`이 필요합니다. PR 리뷰·머지는 로그인된 GitHub CLI `gh`도 필요합니다. Unix socket을 사용하므로 macOS·Linux를 대상으로 합니다.

```sh
bun install --frozen-lockfile --ignore-scripts
bun link
dori-codex up --cwd /절대/프로젝트/경로
dori-codex doctor
dori-codex send lead --text '현재 프로젝트를 확인하고 요청한 작업을 진행해줘'
dori-codex read lead
dori-codex status
dori-codex down
```

`up`은 로컬 실행기와 lead·duty 세션을 준비합니다. 메시지를 보내기 전에는 모델을 실행하지 않습니다. `down`은 이 실행기가 소유한 턴을 중단하고 자기 프로세스를 종료합니다. 기존 Codex 서비스나 원격 호스트에는 종료 명령을 보내지 않습니다. 로그인 자동 실행이나 예약 작업을 등록하지 않습니다.

명령 이름은 `dori-codex`입니다. 기존 `dori` 명령은 덮어쓰지 않습니다. `bash install.sh`는 현재 체크아웃의 CLI와 스킬만 연결하며 자동으로 pull하거나 서비스를 시작하지 않습니다.

## 작업과 완료

```sh
dori-codex start fix-login --brief ./brief.md --cwd /절대/프로젝트
dori-codex report fix-login --text '기존 오류를 재현했고 수정 검증 중'
dori-codex ready fix-login --text '검토 준비 완료' --evidence https://github.com/owner/repo/pull/123
dori-codex review owner/repo#123
dori-codex merge owner/repo#123 --dry-run
dori-codex done fix-login
```

READY에는 증거가 필요하고, 리드가 실제 증거를 확인해야 합니다. 모델 응답이 끝났다는 이유로 완료 처리하거나 머지하지 않습니다. 머지에는 현재 head의 CLEAR 리뷰와 하나 이상의 통과한 체크가 필요합니다. head가 바뀌거나 체크가 없거나 모두 skip이면 거절합니다. 리뷰는 읽기 전용 Codex 세션에서 실행합니다.

바쁜 세션으로 보낸 메시지는 로컬 inbox에 보관했다가 받을 수 있을 때 묶어서 전달합니다. 메시지 묶음은 고정된 전달 ID로 중복 제출을 막습니다. 수신을 확인할 수 없는 타임아웃은 재시작 후에도 자동 재전송하지 않습니다. Codex 이력을 확인한 뒤 `reconcile 대상 --delivered true` 또는 `--delivered false`로 전달 여부를 명시해야 합니다. `read`는 최근 응답을 표시하고, 전체 이력은 Codex 자체 로컬 저장소에 남습니다.

## 승인과 중단

일반 세션은 `workspace-write`와 `on-request`, 리뷰는 `read-only`를 사용합니다. 승인을 자동으로 허용하지 않습니다.

```sh
dori-codex requests
# 요청을 확인하고 응답 파일 작성: 예) {"decision":"decline"}
dori-codex requests answer 요청ID --json /절대/응답.json
dori-codex interrupt fix-login
```

이 실행기에 등록된 세션만 조작합니다. 로그인과 자격 증명은 Codex가 관리합니다.

## 자동 감시와 백로그

duty는 60초마다 큐와 작업 상태를 확인합니다. 작업 중으로 등록된 세션이 10분·20분 동안 조용하면 확인 메시지를 보내고, 40분이면 리드에게 알립니다. 외부 대기·승인 대기 상태는 재촉하지 않습니다.

시간별 백로그 실행은 `up --auto-loop` 또는 `loop`를 명시적으로 실행할 때 켜집니다. 기본 한도는 열린 작업 3개, 한 번에 시작 2개이며 호스트 부하도 확인합니다. 사용자가 요청한 작업만 백로그에 넣습니다.

## 저장과 통신

기본 상태는 `~/.dori-codex`에 저장합니다. `DORI_HOME`으로 변경할 수 있고, 구형 `~/.dori` 기록과 분리됩니다. `DORI_CODEX_BIN`은 사용할 Codex 실행 파일입니다. 로컬 socket과 상태 파일은 소유자 전용 권한을 사용합니다.

이 포크에는 **사용 통계 수집기·설치 등록·분석 키·텔레메트리 전송 코드가 없습니다.** Dori 자체 통신은 로컬 Unix socket과 app-server 표준 입출력입니다. Codex의 모델 호출과 사용자가 설정한 도구·제공자의 통신은 그대로 필요합니다. GitHub 작업에는 `gh`를 사용합니다. Slack·Notion·카카오 연동 코드는 포함하거나 시작하지 않습니다.

이 실행기는 자체 app-server를 시작합니다. Codex 데스크톱 앱이 쓰는 서버에 직접 붙는 방식은 아니며, 앱 사이드바의 자동 표시·즉시 갱신은 보장하지 않습니다. 저장된 thread ID는 호환되는 Codex 클라이언트에서 이어갈 수 있습니다.

## 검증과 upstream

```sh
bun run typecheck
bun run check:boundaries
bun test ./test/
# 실제 로그인된 모델로 응답 한 번을 확인하는 별도 명령
bun run smoke:live
```

일반 테스트는 가짜 app-server와 격리된 상태 디렉터리를 사용합니다. 실제 모델 테스트는 테스트 세션을 보관 처리하고 실행기를 종료합니다.

upstream 기준 커밋은 `248c291319a1e45db061f1b3eae1cce9640084f7`입니다. 최신 변경은 `git fetch upstream` 후 수동으로 통합하고, 실행기·통신 경계 검사와 전체 테스트를 통과시킵니다. [전체 명령·설계](README.md), [이전 버전과의 차이](docs/migration.md)를 참고하세요.
