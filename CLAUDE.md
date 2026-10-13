# Kira — 市場上最美的 Git GUI Desktop App

Tauri v2 + React + TypeScript。Rust 後端（git2-rs），SVG 路線圖 Commit Graph，GitHub PR 整合。

> 新 session 開始前，先讀取 `.claude/RESUME.md`（跨對話進度快照）。

## 指令

```bash
npm run dev          # 啟動開發模式（Tauri + Vite HMR）
npm run dev:renderer # 只啟動前端
npm run build        # 生產建構
npm run test         # Vitest（前端）
cargo test           # Rust 單元測試（在 src-tauri/ 執行）
npm run lint         # ESLint
cargo clippy         # Rust lint（零警告為標準）
```

## 工作流程

- branch 命名：`feat/xxx`、`fix/xxx`、`refactor/xxx`
- commit 前通過 `tsc --noEmit` + `eslint` + `cargo clippy`
- 每個 PR 附改動摘要與對應的 Task 編號（見 docs/PLAN.md）
- 註解與文件寫理由，不寫審查或決策代號（例如 Codex #5、Q-S：那些紀錄不在 repo 裡）；提到開源前的 PR 寫成「kira-app PR #N」（公開 repo 的 PR 從 #1 重新編號）

## 技術約束

- Tauri IPC 統一透過 `src/lib/tauri.ts` 封裝，元件不直接呼叫 `invoke()`
- 狀態管理只用 Zustand，不引入 Redux
- 錯誤處理統一在 `src/lib/tauri.ts`，元件層只處理 UI 狀態
- GitHub token 只存系統 keychain（keyring crate），絕不寫入 localStorage 或磁碟明文
- Rust 端所有 git 操作透過 git2-rs，不 shell out 執行 git CLI
- Motion 一律純 CSS（`transition` / `@keyframes`），不引 Framer Motion；只動 `opacity` 與 `transform`，不動 `height` / `margin` / `top` 等觸發 reflow 的屬性
- Motion 時長分層：高頻互動（hover）100-120ms，低頻狀態變化（tab 進場、載入）200-300ms。曲線一律 `ease-out`，且 `transition-*` 必須**顯式**帶 `ease-out`——裸寫會 fallback 到 Tailwind 預設值，那個值與 `ease-in-out` 完全相同。v8 樣式的曲線照設計基準：減速曲線 `--curve-settle`（同屬 ease-out 型），連續旋轉用 `linear`
- 帶位移或縮放的 animation 必須加 `motion-safe:` 前綴；純顏色 transition 不需要（reduced-motion 針對的是前庭不適，顏色變化不觸發）
- v8 樣式（Task 16 Phase 3 起）：`src/styles/v8.css` 是設計基準 `<style>` 的逐字副本，由 `mockup/tools/sync_v8_css.py` 產生，禁止手改（改樣式 = 改基準 → commit → 重跑；`--check` 驗逐字相同）。`index.css` 以 `@import "./styles/v8.css" layer(components);` 載入，**不可不分層**（它的 `button` / `body` 規則會壓過舊元件的 utility）
- 圖示 sprite 同理：`src/styles/v8-sprite.svg` 是基準 0×0 `<svg>` 的逐字副本（同一支腳本產生、`--check` 一併驗），App root 以 `?raw` + innerHTML 注入一次（放在 `.app` 外），圖示一律 `<use href="#…">`，不內嵌 path
- diff 上色器同理（Phase 5 起）：`src/lib/v8-highlight.js` 是基準 highlight 區塊的逐字副本（同一支腳本產生、`--check` 一併驗），型別在手寫的 `v8-highlight.d.ts`。語料 `src/tests/fixtures/highlight-corpus.js` 由 vitest（V8）與 `mockup/tools/hl_probe.mjs`（Node + WebKit）共用：app 跑在 JSC 上，正規式結果可能跟 V8 不同，改上色器（＝改基準）兩關都要過。src 不放原始雙向控制字元（`rawBidi.test.ts` 擋），要用就寫成跳脫序列
- 已移植成 v8 的節點只帶 v8 class，不混 Tailwind utility（utilities 層會蓋過 components 層）
- macOS Overlay 標題列：站牌是 `data-tauri-drag-region="deep"`；沒有站牌的畫面、蓋住站牌的全窗遮罩（對話框）要自己在頂端加 60px 拖曳帶（`components/ui/TitleBarDragStrip`），否則視窗拖不動；deep 子樹裡的非互動彈出物（選單）設 `data-tauri-drag-region="false"`，否則按住會拖動視窗、雙擊會 zoom
- 殼層操作（pull / push / refresh / 開 repo / 登入登出）的失敗一律寫進 `noticeStore`（站牌上的提示），不另做行內錯誤；只有使用者發起的操作清它，watcher / focus 觸發的背景 refresh 不清
- v8 CSS 變數不得落在 Tailwind theme 命名空間（同名會蓋掉 theme 層、悄悄改掉 utility 的值；sync 腳本會擋）；基準不依賴瀏覽器預設值（按鈕 padding、tab-size 都明寫）
- 過渡期：舊 `--color-*` token 是 v8 變數的別名（`index.css` 的 `@theme static`），各區移植後刪；主題寫在 `html[data-theme]`（`light` / `dark`），強調色寫在 `html[data-line]`（App 依路線圖寫入）
- 路線圖（`components/Graph/`）只把純模組的輸出轉成 DOM：歸屬與顏色 `routeMap.ts`、走線與繪製 `routeGeometry.ts`（照搬基準 `edges()` / `drawMap()`）、每站的 ref `rowRefs.ts`。改走線先改基準，再跑 `mockup/tools/routes/` 的 `route_compare` 與 `compare_geometry`（加 `mutate_geometry.sh`）；`RouteLayer` 的 SVG 分組、屬性與數字格式照抄基準，改了結構跑 `mockup/tools/graph_render_controls.py`（四種改壞 D1 都要抓到）
- 改捲動相關 CSS（`overflow` / `overscroll-behavior`）跑 `mockup/tools/wheel_check.py`：基準一次、`--url http://localhost:1420/fidelity.html` 對 app 一次（vite 先開）。它送原生滾輪與觸控板事件（含 MayBegin），合成的 `WheelEvent` 量不到觸控板把手勢交給最內層捲動容器；包在捲動區裡、捲另一軸的容器把不能捲的那軸設 none，觸控板會整片卡死
- CSP 寫在 `tauri.conf.json`（各指令的原因見 SPEC「Webview CSP」），**只在打包版套用**，dev、fidelity、D1 都看不到違規：新增資源類型（外部圖片或字體、webview 端 fetch、`<style>` 元素、worker、iframe）先改 CSP，再跑 `mockup/tools/csp_check.sh`；`'unsafe-inline'` 只放 `style-src-attr`（`index.html` 一有 `<style>`，Tauri 就在 `style-src` 補 nonce，放在那裡的 `'unsafe-inline'` 隨之失效）。CSP 擋不住已經在執行的腳本，也不管頂層導航（見 SPEC）

## 參考文件

- 完整系統架構與 IPC 規格：`docs/SPEC.md`
- 使用者故事與驗收標準：`docs/PRD.md`
- Task 清單與實作順序：`docs/PLAN.md`
