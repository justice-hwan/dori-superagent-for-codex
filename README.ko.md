# dori-superagent-for-codex

[sisyphuslabs/dori-superagent](https://github.com/sisyphuslabs/dori-superagent)를 upstream으로 삼는 **Codex app-server 기반 로컬 실행기**입니다. 작업 지시서 → 작업 세션 → 증거 확인 → 정확한 커밋의 리뷰 → 머지 흐름을 유지합니다.

## 시작

Bun 1.3 이상, Codex CLI 0.164 이상, Git 2.38 이상, `codex login`이 필요합니다. PR 리뷰·머지는 로그인된 GitHub CLI `gh`도 필요합니다. Unix socket을 사용하므로 macOS·Linux를 대상으로 합니다.

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

READY에는 증거가 필요하고, 리드가 실제 증거를 확인해야 합니다. 모델 응답이 끝났다는 이유로 완료 처리하거나 머지하지 않습니다. 머지에는 현재 head와 base의 CLEAR 리뷰와 하나 이상의 통과한 체크가 필요합니다. head가 바뀌거나 체크가 없거나 모두 skip이면 거절합니다. 리뷰는 정확한 head·base의 로컬 원본 Git 소스 스냅샷과 diff를 만들어 읽기 전용 Codex 세션에서 실행합니다. 해당 커밋을 가진 로컬 clone에서 명령을 실행해야 합니다. 리뷰 중 head나 base가 바뀌면 승인 기록을 만들지 않습니다. 병합은 검토한 head와 base만 부모로 갖는 고정 merge commit을 만들고, 원격 base가 검토 당시 값일 때만 반영합니다. 병합 후보를 먼저 기록하므로 응답 유실 후에도 같은 후보를 확인합니다. PR head가 뒤늦게 바뀌면 새 커밋은 들어가지 않으며, 검토한 쌍의 반영과 GitHub PR 병합 상태를 구분해서 보고합니다. merge commit만 지원해 upstream 이력을 보존합니다.

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

duty는 60초마다 큐와 작업 상태를 확인합니다. `duty stop --text 이유`, `duty status`, `duty resume`으로 다음 감시 주기를 중지·확인·재개합니다. 이미 실행 중인 턴의 중단에는 `interrupt`를 사용합니다. 작업 중으로 등록된 세션이 10분·20분 동안 조용하면 확인 메시지를 보내고, 40분이면 리드에게 알립니다. 외부 대기·승인 대기 상태는 재촉하지 않습니다.

시간별 백로그 실행은 `up --auto-loop` 또는 `loop`를 명시적으로 실행할 때 켜집니다. 기본 한도는 열린 작업 3개, 한 번에 시작 2개이며 호스트 부하도 확인합니다. 사용자가 요청한 작업만 백로그에 넣습니다.

## 저장과 통신

기본 상태는 `~/.dori-codex`에 저장합니다. `DORI_HOME`으로 변경할 수 있고, 구형 `~/.dori` 기록과 분리됩니다. `DORI_CODEX_BIN`은 사용할 Codex 실행 파일입니다. 로컬 socket과 상태 파일은 소유자 전용 권한을 사용합니다.

이 포크에는 **사용 통계 수집기·설치 등록·분석 키·텔레메트리 전송 코드가 없습니다.** Dori 자체 통신은 로컬 Unix socket과 app-server 표준 입출력입니다. Codex의 모델 호출과 사용자가 설정한 도구·제공자의 통신은 그대로 필요합니다. GitHub 작업에는 `gh`를 사용합니다. Slack·Telegram·Discord는 [명시적 설정과 시작](docs/messengers.md) 후에만 소유자 요청을 받고 검증된 완료를 원래 경로로 자동 회신합니다. 일반 `up`은 메신저 연결이나 자격 증명 조회를 시작하지 않습니다. Notion·카카오 연동은 포함하지 않습니다.

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

최초 upstream 기준은 `248c291319a1e45db061f1b3eae1cce9640084f7`이며, 현재 반영한 커밋은 `.upstream.json`에 기록합니다. `dori-codex upstream check`는 원본 remote를 확인하고 새 커밋을 fetch하여 목록을 보여줍니다. 새 clone에는 선언된 upstream remote를 등록하지만, pull·merge·commit·push나 정기 실행을 하지는 않습니다. 통합 전용 브랜치에서 변경을 반영하고 검증과 독립 리뷰를 거친 뒤 merge commit으로 병합합니다. 그래야 원본 커밋 이력이 보존됩니다. [전체 명령·설계](README.md), [이전 버전과의 차이](docs/migration.md)를 참고하세요.


런타임·inbox의 오래된 잠금은 claim gate 안에서 회수합니다. 짧은 잠금 생성 구간에서 프로세스가 죽어 `.claim` 파일이 남으면 소유자 상태를 확인한 뒤 수동으로 정리해야 합니다. 시작 여부가 불명확한 lane은 대기 상태로 유지하며, 확인 전에는 대체 세션을 만들지 않습니다. 종료는 자신이 시작한 app-server의 실제 종료까지 확인합니다.

재시작 때 idle이라는 이유만으로 성공을 추정하지 않고 최신 저장 turn 결과를 조회합니다. 실패·미완료·결과 불명 상태로는 READY를 닫을 수 없으며, 명시적인 새 복구 지시를 받을 수 있습니다. 전달 여부의 불확실성은 여전히 `reconcile`로 판단해야 합니다.
