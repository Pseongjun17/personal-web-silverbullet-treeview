# AGENT.md — SilverBullet TreeView Plug

이 문서는 에이전트(Claude Code 등)가 이 저장소를 빠르게 파악하고 수정할 수 있도록 코드 구조, 실행 메커니즘, 수정 시 유의사항을 정리한 것입니다. 사람이 보는 사용 설명서는 `README.md`(전체) / `PLUG.md`(SilverBullet v2 전용 요약, 인앱 라이브러리에 노출됨)를 참고하세요.

## 한눈에 보는 구조

이 저장소는 [SilverBullet](https://silverbullet.md) 노트 앱의 "Plug"(플러그인) 하나입니다. Plug는 Deno/TypeScript로 작성되고, esbuild 기반 번들러로 단일 `.plug.js` 파일로 컴파일되어 SilverBullet 런타임(서버 또는 브라우저 샌드박스)에서 실행됩니다.

```
treeview.plug.yaml   ← 매니페스트: 함수 등록, 커맨드/단축키, 이벤트 훅 정의
treeview.ts           ← 플러그 진입점 (패널 표시/숨김, 툴바 액션 핸들러)
config.ts             ← zod 스키마 기반 설정 파싱 + clientStore(로컬 상태) 접근
api.ts                ← 평면적인 페이지 목록 → 트리(TreeNode[]) 변환 로직
filters/*.ts          ← exclusion 규칙 3종(regex/tags/space-function) 구현체
assets/treeview.js    ← 패널(iframe) 안에서 실행되는 브라우저 스크립트 (SortableTree 초기화 + 페이지/폴더 생성·이름변경·삭제 로직 + 컨텍스트 메뉴)
assets/treeview.css   ← 패널 스타일
assets/sortable-tree/ ← 벤더 라이브러리(서드파티, 직접 수정 금지)
assets/icons/*.svg    ← 툴바/노드 액션 아이콘 (Feather 아이콘 세트, 문자열로 인라인 삽입됨)
treeview.plug.js      ← 빌드 산출물 (커밋되어 있음, 소스 수정 후 반드시 재생성 필요)
```

## 실행 모델 (중요)

두 개의 완전히 분리된 실행 컨텍스트가 있다는 것을 이해해야 코드를 안전하게 수정할 수 있습니다.

1. **플러그 백엔드 (`treeview.ts`, `api.ts`, `config.ts`, `filters/`)**
   - Deno/TS로 작성, `@silverbulletmd/silverbullet/syscalls`의 `editor`, `system`, `space`, `clientStore`, `asset` 등을 통해 SilverBullet API에 접근.
   - `treeview.plug.yaml`에 등록된 함수만 SilverBullet이 호출 가능 (커맨드, 이벤트 훅, 또는 다른 함수의 `system.invokeFunction`을 통해).
   - `import`가 정상 동작하는 일반적인 ESM 환경.

2. **패널 프론트엔드 (`assets/treeview.js` + `assets/treeview.css`)**
   - `treeview.ts`의 `showTree()`가 `editor.showPanel(position, size, htmlString, jsString)`을 호출해 HTML/CSS/JS를 **문자열로 조립**해서 넘김. `asset.readAsset(...)`으로 읽은 파일 내용을 그대로 문자열 템플릿에 삽입하는 방식이라 **import/require가 없고, 전역 함수/전역 변수로만 연결됩니다.**
   - 이 컨텍스트는 별도의 브라우저 sandbox(iframe)에서 실행되며, 백엔드로 다시 호출하려면 브라우저 쪽에 주입된 전역 `syscall(name, ...args)` 함수만 사용 가능.
   - **중요**: `syscall()`은 `system.invokeFunction`/`editor.navigate` 같은 몇 개로 한정된 게 아니라, **SilverBullet의 모든 syscall(`space.*`, `editor.*`, `system.*` 등)을 이름으로 그대로 호출할 수 있는 범용 브리지**입니다 (`panel.tsx`가 받은 메시지를 그대로 `clientSystem.localSyscall(name, args)`로 넘김 — 플러그 백엔드 코드가 쓰는 것과 동일한 syscall 디스패처). 즉 패널 JS에서 `syscall("space.writePage", name, "")`, `syscall("space.deletePage", name)`, `syscall("editor.prompt", ...)`, `syscall("editor.confirm", ...)`처럼 백엔드 함수를 새로 만들지 않고 바로 호출해도 됩니다 — `assets/treeview.js`의 `createEntry`/`renameEntry`/`deleteEntry`가 이 패턴의 실제 예시입니다. 새 백엔드 plug 함수는 "여러 syscall 호출을 서버에서 원자적으로 묶어야 할 때"나 "서버 전용 syscall일 때"만 추가하면 됩니다.
   - `treeview.ts`에서 만든 `treeViewConfig` 객체가 `JSON.stringify`되어 `initializeTreeViewPanel(config)` 호출 인자로 그대로 박혀 들어갑니다 (`treeview.ts:170` 부근). 여기 들어가는 값은 반드시 JSON 직렬화 가능해야 함.
   - 새 툴바 버튼을 추가하려면: (a) `treeview.ts`의 `showTree()` HTML 문자열에 `data-treeview-action="foo"` 버튼 추가 → (b) `assets/treeview.js`의 `handleAction()` switch에 `"foo"` 케이스 추가 → (c) 필요하면 `treeview.ts`에 새 export 함수 + `treeview.plug.yaml`에 함수 등록 (대부분의 경우 위 syscall 직접 호출로 충분합니다).
   - 벤더 라이브러리(`SortableTree`)는 컨텍스트 메뉴나 노드 추가/삭제 API를 제공하지 않습니다 (`renderLabel`로 라벨 마크업만 커스터마이즈 가능). 노드별 액션 아이콘이나 우클릭 메뉴는 전부 이 플러그가 직접 구현한 것 (`renderLabel` 안에 `<button data-tv-action="...">` 삽입 + `#treeview-tree` 엘리먼트에 캡처 단계 `mousedown`/`click` 리스너로 라이브러리의 드래그/클릭 처리보다 먼저 가로채기, `contextmenu` 이벤트는 별도 커스텀 메뉴를 `document.body`에 직접 렌더링). 이 UI를 건드릴 때는 `assets/treeview.js` 하단의 `interceptNodeAction`/`openMenu`/`performNodeAction`을 참고하세요.
   - 노드 추가/삭제/이름변경 후에는 트리를 증분 업데이트하는 API가 없으므로 항상 `syscall("system.invokeFunction", "treeview.show")`로 패널 전체를 다시 그립니다 (드래그앤드롭의 `onChange`가 원래 하던 방식과 동일).

## 데이터 흐름 (트리 렌더링)

`showTree()` (`treeview.ts:66`) 실행 순서:

1. `getPlugConfig()`로 space 설정 로드 (SETTINGS/CONFIG → zod 파싱, `config.ts`).
2. `getPageTree(config, showHidden)` (`api.ts:48`) 호출:
   - `system.invokeFunction("index.queryLuaObjects", "page", {})`로 페이지 목록을 가져옵니다. **`space.listPages()`을 쓰지 않는 이유**는 태그(`tags`) 속성이 빠지기 때문 — 태그 기반 exclusion을 쓰려면 인덱스 쿼리가 필요합니다.
   - `config.exclusions` 배열을 순회하며 regex/tags/space-function 필터를 순차 적용 (`showHidden`이 true면 스킵).
   - 페이지 이름을 `/`로 split해서 폴더/페이지 노드 트리(`TreeNode[]`)를 만듦 (경로의 중간 세그먼트는 잠정적으로 `folder`, 마지막 세그먼트에 해당 페이지가 나타나면 `page`로 교체됨 — "folder note" 개념).
   - `config.attachments.enabled`면 `space.listAttachments()`로 첨부파일도 같은 방식으로 트리에 병합.
   - `config.sort`(순서/가중치)에 따라 재귀 정렬.
3. 아이콘 SVG, `sortable-tree` 라이브러리, `treeview.js/css`를 전부 `asset.readAsset`로 읽어 하나의 HTML/JS 문자열로 조립 → `editor.showPanel()`.
4. `setTreeViewEnabled(true)` + `currentPosition` 갱신.

## 설정 스키마 (`config.ts`)

- `treeViewConfigSchema` (zod)가 **유일한 진실 공급원**입니다. SilverBullet v1(YAML `SETTINGS`)과 v2(Lua `CONFIG`)는 입력 형식만 다르고 둘 다 `system.getSpaceConfig("treeview", {})`를 거쳐 동일 스키마로 파싱됩니다.
- 새 설정 옵션 추가 시 체크리스트:
  1. `config.ts`의 `treeViewConfigSchema`에 필드 추가 (`.optional().default(...)`로 하위 호환 유지).
  2. `README.md`의 v1/v2 예시 **양쪽** 다 갱신.
  3. `PLUG.md`(v2 전용 축약본, 프런트매터로 SilverBullet 라이브러리에 노출됨)도 갱신 — README와 내용이 중복되어 있으니 둘 다 빠뜨리지 말 것.
  4. `CHANGELOG.md`에 Unreleased 항목 추가 (Keep a Changelog 형식).
  5. 파싱 실패 시 `showConfigErrorNotification`이 사용자에게 알림을 띄우므로, 필드 검증 실패 메시지가 사용자 친화적인지 확인.

## Exclusion(필터) 시스템 확장 방법

현재 3종: `regex` / `tags` / `space-function`. 새 필터 타입을 추가하려면 3곳을 동시에 고쳐야 합니다:

1. `config.ts` — `exclusionRuleBy___Schema` zod 스키마 추가 + `treeViewConfigSchema.exclusions`의 discriminated union에 등록.
2. `filters/filterBy___.ts` — 실제 필터링 함수 구현 (기존 파일들처럼 `(pages, options) => PageMeta[]` 형태, 에러는 잡아서 원본 배열 그대로 반환하는 방어적 패턴 유지).
3. `api.ts`의 `getPageTree()` 안 `switch (exclusion.type)`에 케이스 추가 + import.

첨부파일(attachment) exclusion은 현재 `regex` 타입만 별도로 재적용됩니다 (`api.ts:200` 부근) — tags/space-function으로 확장하려면 이 블록도 함께 고쳐야 함.

`hideLibraries`(기본값 `true`)는 이 범용 `exclusions` 배열과는 별개로, `config.ts`에 독립된 boolean 필드로 존재하는 **전용 토글**입니다 (`Library/` prefix를 하드코딩으로 숨김). "사용자가 매번 exclusion 규칙을 직접 안 써도 되는, 기본값이 있는 자주 쓰는 필터"를 추가하고 싶을 때 이 패턴(전용 필드 + `!showHidden` 블록 안에서 `pages`/`attachments`에 동일하게 적용)을 참고하세요. `showHidden`(눈 아이콘 토글)이 켜지면 이 필터도 다른 exclusion처럼 무시됩니다.

## 상태 저장: `clientStore` vs `config`

- `config` (zod 스키마, space 전체 공용, SETTINGS/CONFIG에서 옴): position, size, exclusions 등 — **여러 기기/사용자가 공유하는 설정**.
- `clientStore` (`config.ts`의 `ENABLED_STATE_KEY`, `SIZE_OVERRIDE_KEY`, `SHOW_HIDDEN_KEY`): 브라우저 로컬 상태 — 트리뷰 켜짐/꺼짐, 너비 임시 override, "숨김 파일 보기 토글" 같은 **기기별 UI 선호도**. 새로운 "기기별 토글"을 추가할 때는 `config`가 아니라 이쪽 패턴을 따르세요.

## 빌드/배포

- `deno task build` → `silverbullet plug:compile -c deno.json treeview.plug.yaml` 실행 (SilverBullet CLI가 로컬에 설치되어 있어야 함, 단순 `deno` 설치만으론 부족).
- `deno task watch`로 변경 감시 빌드 가능.   
- **중요**: 사용자는 `github:joekrill/silverbullet-treeview/treeview.plug.js`처럼 컴파일된 `treeview.plug.js`를 직접 참조해서 설치합니다. 즉 소스(`*.ts`, `assets/*`)를 고치고 나면 **반드시 `deno task build`로 재빌드하고 `treeview.plug.js`도 함께 커밋**해야 실제로 반영됩니다 (과거 커밋 로그에 "Rebuild plug bundle"만 단독으로 있는 커밋들이 이 패턴).
- 테스트: `deno.json`에 `"test": "deno test -A --unstable-kv --unstable-worker-options"` 태스크가 정의되어 있지만, **현재 저장소에는 `*_test.ts` 파일이 하나도 없습니다.** 새로 로직을 추가한다면(특히 `filters/`, `api.ts`의 트리 변환 로직) 이 태스크를 활용해 유닛 테스트를 신설하는 것을 고려하세요.

## 파일/폴더 관리 기능 (생성·삭제·이름변경)

트리에서 직접 페이지/폴더/첨부파일을 새로 만들거나, 이름을 바꾸거나, 삭제할 수 있는 기능입니다. 관련 코드는 전부 `assets/treeview.js`에 있고 (백엔드 plug 함수를 새로 추가하지 않음 — 위 "실행 모델" 항목 참고), 세 가지 트리거로 노출됩니다:

- **호버 아이콘**: `renderLabel`이 각 노드 라벨 안에 `.tv-node-actions`(파일 추가/이름변경/삭제 버튼)를 렌더링하고, CSS `:hover`/`:focus-within`로 평소엔 숨겨둡니다.
- **우클릭 컨텍스트 메뉴**: `#treeview-tree`에 붙인 `contextmenu` 리스너가 클릭 위치에 커스텀 메뉴(`openMenu`)를 띄웁니다. 노드 위에서 우클릭하면 해당 노드 기준 액션을, 빈 공간에서 우클릭하면 루트에 새 페이지/폴더 생성 액션을 보여줍니다.
- **툴바 버튼**: `treeview.ts`의 헤더에 추가된 "New page"/"New folder" 버튼 → `handleAction()`의 `"new-page"`/`"new-folder"` 케이스 → 루트 경로로 `createEntry("", ...)` 호출.

핵심 함수 (모두 `assets/treeview.js`):
- `createEntry(parentName, isFolder)` — `editor.prompt`로 이름을 받고 `space.writePage(name, "")`로 생성. **SilverBullet에는 빈 폴더 개념이 없으므로** "폴더 생성"도 결국 그 경로에 내용 없는 placeholder 페이지 하나를 만드는 것입니다 (하위에 다른 페이지가 생기면 자동으로 "folder note"로 표시됨 — `api.ts`의 폴더/페이지 판별 로직 참고). 생성 직후 `deleteIfEmptyPlaceholder(parentName)`을 호출.
- `renameEntry(name)` — 새 이름을 받아 드래그앤드롭이 이미 쓰던 `index.renamePrefixCommand`를 그대로 재사용합니다. 단일 페이지든 폴더(prefix)든 동일하게 동작하고, 백링크 갱신도 그 커맨드가 알아서 처리합니다.
- `deleteEntry(name, nodeType)` — `nodeType`이 `"attachment"`가 아니면 **트리의 nodeType 라벨을 신뢰하지 않고** `space.listPages()`/`listAttachments()`를 다시 조회해서 `name` 자신과 `name + "/"`로 시작하는 모든 페이지·첨부파일을 찾아 전부 삭제합니다. 이렇게 하면 순수 가상 폴더든, 자식이 있는 "folder note" 페이지든 상관없이 항상 하위 전체가 올바르게 삭제됩니다. 삭제는 되돌릴 수 없으므로 영향받는 파일 개수를 포함한 확인 메시지를 항상 띄웁니다.
- `deleteIfEmptyPlaceholder(parentName)` — `parentName`이 실제 페이지이면서 `size === 0`(내용 없음)이면 삭제합니다. `createEntry`가 자식을 만든 직후, 그리고 드래그앤드롭 `confirm` 콜백이 이동을 성공시킨 직후(`targetParentNode`가 있을 때) 둘 다에서 호출됩니다 — **placeholder는 "언제 지워지냐"의 답은 "빈 상태로 있다가 처음으로 실제 자식을 갖게 되는 바로 그 순간"** 입니다. 가상 폴더(nodeType `"folder"`, 실제 페이지가 아님)에 대해서는 `space.getPageMeta`가 "Not found"로 실패하므로 자연스럽게 스킵됩니다.
- `canAddChildTo(data)` — "여기에 추가" 액션(호버 아이콘 + 컨텍스트 메뉴)을 보여줄지 결정하는 유일한 판단 지점입니다. `nodeType === "folder"`이거나, `nodeType === "page"`이면서 `hasChildren === true`(이미 폴더노트)이거나 `size === 0`(아직 아무 내용도 안 쓴 페이지·placeholder)일 때만 허용합니다. **실제 내용이 있는 일반 페이지 위에는 절대 노출되지 않도록** 하는 게 목적 — 안 그러면 트리에서 무심코 클릭 몇 번으로 작성 중이던 페이지가 폴더노트로 바뀌어버릴 수 있습니다. `renderLabel`이 이 값을 `data-can-add-child` 속성으로 라벨에 심어두고, 호버 아이콘과 컨텍스트 메뉴 둘 다 이 하나의 속성만 읽습니다 (판단 로직 중복 없음). `data.hasChildren`은 `api.ts`의 `sortNodes`가 트리를 다 만들고 정렬한 뒤에 채워주는 필드이고, `data.size`는 `PageMeta`(→ `index.queryLuaObjects`)에 원래 들어있는 필드를 그대로 씁니다.

노드 액션 버튼(`[data-tv-action]`)의 클릭/mousedown은 `treeElement`에 **capture 단계**로 등록한 `interceptNodeAction`이 가장 먼저 가로채서 `stopPropagation()`합니다 — 그래야 SortableTree 라이브러리 자체의 드래그 시작/노드 클릭(페이지 이동) 로직이 절대 끼어들지 않습니다. 이 아이콘/메뉴 관련 UI를 수정할 때 이 가로채기 순서를 깨지 않도록 주의하세요.

**참고**: 이 저장소에는 실행 중인 SilverBullet 인스턴스가 없어 브라우저에서 실제 동작을 확인하지 못했습니다. `deno task build` 후 실제 space에 배포해서 호버 아이콘 위치/컨텍스트 메뉴 표시 여부/드래그 간섭 여부를 눈으로 확인하는 것을 권장합니다.

## 알려진 이슈 / 정리 대상 (수정 시 참고)

- `.vscode/settings.json`이 여전히 `"deno.importMap": "import_map.json"`을 참조하지만 해당 파일도 같은 리팩터링 커밋에서 제거되어 존재하지 않습니다 (임포트는 `deno.json`의 `imports` 필드로 이관됨). 에디터 경고만 발생시키는 수준의 사소한 잔재입니다.
- `config.ts`의 `PLUG_NAME` 상수 옆에 "TODO: is there a way to get this programatically?"라는 주석이 있음 — 플러그 이름을 얻는 API가 생기면 정리 대상.
- ~~`treeview.ts`의 `compatability.ts` 죽은 import~~ — 파일/폴더 관리 기능을 추가하면서 함께 제거했습니다 (2026-08-02).

## 문서 동기화 규칙

이 저장소는 설정 예시가 세 군데(README.md v1 섹션, README.md v2 섹션, PLUG.md)에 거의 중복 기술되어 있습니다. 설정 스키마(`config.ts`)를 바꾸면 이 세 곳 + `CHANGELOG.md`를 함께 갱신하세요. 다르게 말하면: "코드만 고치고 문서 하나만 갱신"하는 실수가 나기 쉬운 구조입니다.
