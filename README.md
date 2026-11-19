# Baro

Raycast 스타일의 개인용 macOS 런처예요. ⌥Space로 열고, 앱 실행·파일 찾기·계산·AI 질문, 그리고 **Obsidian 노트 검색**을 키보드만으로 해요.
Tauri 2(Rust) + React/TypeScript로 만들었어요.

## 주요 기능

| 기능 | 사용법 |
|---|---|
| 앱 실행 | 한글 이름으로 검색(계산기, 터미널). 자주 쓰는 앱이 위로 와요 |
| 파일 찾기 | 기본 검색에서 두 글자 이상 → 홈 폴더 파일. **파일 찾기 화면**은 홈 + 외장 디스크를 찾고 Enter로 Finder에서 보여 줘요 (⌘O 열기, ⌘C 경로 복사) |
| 계산기 | `12*3+4` → Enter로 결과 복사 |
| ⌘K 액션 패널 | 열기, Finder에서 보기, 경로 복사 등 |
| 노트 검색 | Obsidian 폴더 + 방식 + 단축키를 Baro 화면에서 만들어요. 방식: 명령어 사전 · 일반 노트 · 스니펫 모음 · 비밀번호 모음 |
| 노트 그래프 | Vault 전체의 `[[링크]]` 그래프. 휠 확대, 클릭 미리보기, 더블클릭 Obsidian 열기, ⌘F Finder에서 보기 |
| 비밀번호 모음 | 노트 머리말의 `password`를 가려서 보여 줘요(⌘R 보기). 복사·붙여넣기, ⌘E 수정, 새 노트 추가 |
| 클립보드 기록 | 복사한 글 최근 200개를 검색해 다시 붙여넣기(↵), ⌘C 복사, ⌘N 빠른 메모로, ⌘D 지우기. 비밀번호 관리자가 복사한 것, 키·토큰처럼 보이는 글은 저장하지 않아요 |
| 내 노트에게 묻기 | 질문 입력 후 ⌘↵. Vault에서 관련 노트를 찾아 그 내용으로 답하고 출처 노트를 보여 줘요. 단어 검색(BM25, 한글 두 글자 단위) + `노트 뜻 색인 만들기`를 한 번 하면 뜻 검색(로컬 Ollama `bge-m3`)도 함께 써요. 비밀번호 노트는 넘기지 않고, 본문의 비밀번호 같은 글자는 가려요 |
| 개념 노트 만들기 | 노트 미리보기 아래 "아직 없는 노트"의 `+ 이름`을 누르면 틀에 맞춘 노트를 만들어 Obsidian에서 열어요 (같은 이름이 있으면 그 노트를 열어요) |
| 스니펫 자동 입력 | 켜면 어느 앱에서든 `;키워드` → 스니펫 본문 (영문 입력 상태, 입력 모니터링 권한 필요, 기본 꺼짐) |
| AI에게 묻기 | Tab. 기본은 로컬 Ollama, Claude API로 바꿀 수 있어요. ⌘S로 답변을 Obsidian 노트로 저장 |
| 퀵링크·스니펫 | `yt 검색어`, `today` 등. 검색어 없는 퀵링크는 전역 단축키로 바로 열기 |
| 창 관리 | `창` → 왼쪽/오른쪽 절반, 최대화, 가운데 (손쉬운 사용 권한 필요) |
| 시스템 명령 | 잠자기, 화면 잠금, 휴지통 비우기(두 번 확인), 다크 모드, 음소거 |
| 확장 스토어 | 셸 스크립트 확장 설치·실행·삭제 (예제: 개발 도구, 시스템 정보, 텍스트 도구) |
| 단축키 설정 | 기능·노트 검색·퀵링크마다 전역 단축키를 눌러서 지정 |
| 창 고정 | ⌘P. 맨 앞에 남고, 작게 줄여 옆에 띄워 둘 수 있어요. 맨 위 막대로 창 이동 |
| 창 크기 | 가장자리를 끌어 조절. 목록 · 미리보기 화면(노트·클립보드·메모·AI 답변) · 그래프 · 고정 창마다 크기를 따로 기억해 다시 켜도 유지돼요. 미리보기·그래프는 처음엔 자동으로 크게 열려요. `Baro 창 크기 초기화`로 기본 크기로 |

## 설치·실행

필요: macOS, Node.js 20+, Rust(rustup), [Tauri 사전 요구사항](https://tauri.app/start/prerequisites/)

```bash
npm install
npm run tauri dev                          # 개발 실행 → ⌥Space로 열기
npm run tauri build -- --bundles app       # .app 만들기
cp -R src-tauri/target/release/bundle/macos/Baro.app /Applications/
```

### 코드 서명

`src-tauri/tauri.conf.json`은 키체인의 자체 서명 인증서 **"Baro Dev"**로 서명해요.
서명이 빌드마다 같아야 macOS 권한(손쉬운 사용, 외장 디스크 접근)이 다시 묻지 않아요.

- 인증서가 없으면: `bundle.macOS.signingIdentity` 줄을 지우고 빌드하세요 (ad-hoc 서명, 빌드마다 권한을 다시 물어요).
- 인증서를 만들려면: 키체인 접근 → 인증서 지원 → 인증서 생성 → 이름 `Baro Dev`, 유형 "코드 서명".

## 설정

`~/Library/Application Support/dev.hmc.baro/config.json` (`Baro 설정 열기` 명령으로 열 수 있어요)

| 항목 | 설명 |
|---|---|
| `ai_provider` | `ollama`(기본) 또는 `claude` |
| `ollama_model` | 기본 `qwen3.5:9b` |
| `anthropic_api_key` | Claude 사용 시. 이 파일에만 저장되고 저장소에는 들어가지 않아요 |
| `vault_dir` | 노트 그래프용 Obsidian Vault (기본 `/Volumes/Disk/MyBrain`) |
| `ai_save_dir` | AI 답변 저장 폴더 (기본 Vault의 `00_Inbox/AI`) |
| `note_searches` | 노트 검색 목록 `{id, name, dir, kind}` — 화면에서 만들고 고칠 수 있어요 |
| `quicklinks`, `snippets` | 퀵링크(`{query}` 자리표시)와 스니펫 |
| `hotkeys` | 전역 단축키 (`baro`, `ai`, `store`, `graph`, `files`, `memo`, `clipboard`, `note:<id>`, `link:<keyword>`) |
| `clipboard_history` | 클립보드 기록 (기본 켜짐). 기록은 같은 폴더의 `clipboard.json`(나만 읽기 권한) |
| `snippet_expand` | 스니펫 자동 입력 (기본 꺼짐) |

같은 폴더의 `note-cache.json`(노트 캐시: 바뀐 노트만 다시 읽음)과 `embed-cache.bin`(뜻 색인)은 지워도 다시 만들어져요.
| `store_url` | 확장 스토어 주소 (`index.json`이 있는 폴더, `file://` 또는 `https://`) |

## 확장 만들기

`store/<id>/manifest.json`에 명령을 적고 스크립트를 함께 두면 돼요. 목록은 `store/index.json`.

```json
{ "id": "dev-tools", "name": "개발 도구", "version": "1.0.0",
  "commands": [{ "name": "uuid", "title": "UUID 생성", "keywords": "uuid", "mode": "copy", "script": "uuid.sh" }] }
```

`mode`: `copy`(출력 복사) · `view`(화면에 표시) · `open`(출력 URL 열기) · `silent`. `keyword`를 주면 `b64 텍스트`처럼 인자를 받아요. 실행 시간은 15초로 제한돼요.

## 구조

| 경로 | 역할 |
|---|---|
| `src-tauri/src/main.rs` | Tauri 명령, 전역 단축키, 창 표시·숨김·고정 |
| `src-tauri/src/window.rs` | 화면 종류별 창 크기 기억 (`window.json`), 화면 밖으로 나가지 않게 |
| `src-tauri/src/config.rs` | `config.json` 읽기/쓰기와 기본값 |
| `src-tauri/src/indexer.rs`, `search.rs` | 앱 목록·아이콘·한글 이름, 퍼지 검색 |
| `src-tauri/src/wiki.rs` | 노트 읽기, AI 답변 저장, 머리말 수정·새 노트·개념 노트 |
| `src-tauri/src/clip.rs` | 클립보드 기록 (변경 감시, 비밀 제외) |
| `src-tauri/src/vault.rs` | 노트 파일 캐시 (수정 시각·크기가 같으면 다시 읽지 않음) |
| `src-tauri/src/rag.rs` | 내 노트에게 묻기 (단락 색인·BM25·뜻 검색 합치기·발췌·비밀번호 가리기) |
| `src-tauri/src/embed.rs` | 뜻 색인 (bge-m3 벡터 저장·계산) |
| `src-tauri/src/expand.rs` | 스니펫 자동 입력 (키 입력 감시) |
| `src-tauri/src/system.rs` | 창 배치, 시스템 명령, `mdfind` 파일 검색, 권한 확인 |
| `src-tauri/src/ai.rs` | Ollama / Claude 스트리밍 |
| `src-tauri/src/extensions.rs` | 확장 설치·실행·삭제 |
| `src/App.tsx` | 화면 상태와 키 입력 |
| `src/commands.ts` | 검색 결과 항목(계산기·퀵링크·앱·명령·스니펫·확장) |
| `src/notes.ts` | 노트 방식별 해석과 점수 |
| `src/graph.tsx` | 힘 기반 노트 그래프(canvas) |

## 테스트

```bash
npx tsc --noEmit
cd src-tauri && cargo test
```
