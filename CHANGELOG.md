# CHANGELOG

[English](CHANGELOG_EN.md)

本檔記錄 README 的重大變更。格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/)，版本號採日期格式（YYYY-MM-DD）。

開源之前的開發在私有 repo `kira-app` 進行：條目裡的「kira-app PR #N」與 commit hash 指的是那邊，公開 repo 的 PR 從 #1 重新編號。

## [2026-10-09b] — diff 移出主執行緒，送到畫面的量有上限

### 調整

- 設計抉擇「git2-rs 而非 shell out git CLI」那句改寫：diff 已經改成 async command、在 thread pool 上算，一次送到畫面的量也設了上限（超過的檔整檔收合，只列檔名與大小）；push / pull 還是同步 command，改成 async 仍排在後續工作。同日稍早那版寫的是兩件都還沒做

### 技術細節（不進 README，留 CHANGELOG 記錄）

- 顯示上限：單檔 2,000 行或 128K 字元，整個 commit 5,000 行或 256K 字元。依路徑順序逐檔決定，自己超過單檔上限、或加上去會超過總量的檔整檔收合，後面放得下的檔照送；頂端橫幅寫出幾個檔沒顯示、各是什麼原因。PR 的 diff 套同一套
- 算字元不算 UTF-8 位元組：同樣 60,300 字，中文的排版繪製只比英文多約 15%，算位元組的話中文會提早三倍收合。字元照實際送出的文字數，不合法的 UTF-8 每段換成一個 U+FFFD、算一個字——只數 UTF-8 開頭位元組的話，整行 0x80 不管多長都只算 1 個字，惡意 commit 能讓整個檔繞過上限
- 移出主執行緒之後，前端丟掉的請求後端照樣在算，所以加了一道閘：同時只算一個 diff，排隊中已經被新選取取代的直接跳過
- 按住方向鍵瀏覽 commit 時，大 diff（超過 500 行或 32K 字元）等放開才畫，小 diff 照樣即時預覽；超過 2,000 字元的行不上色（壓縮過的 JS 那種單行，上色後畫完要慢約 4 倍）
- 驗證（release 版，點下 commit → diff 畫完，5 次的中位數）：yarn.lock 大改 530 → 63ms、package-lock.json 大改 797 → 64ms（都被收合）；上限內最壞的情境（500 個檔剛好用滿 5,000 行）417ms

## [2026-10-09] — 更正 IPC 入口、執行緒與主題的過時敘述，補上 v8 移植進度

### 調整

- 系統架構與設計抉擇兩處「唯一接受路徑的入口是 `git_open_repo`」改寫：這個 command 早就不在了，路徑現在只從 Rust 端的原生檔案選擇器（開 repo、選 clone 目的地）或近期清單（`git_open_recent_repo`）進來。「日後若要綁 OS file picker 也只需動那 1 個」一併拿掉——已經綁了
- 設計抉擇「libgit2 是 sync API 但走 Tauri 的 thread pool 不阻塞 UI」是錯的：Tauri 的同步 command 跑在主執行緒，大 diff、push / pull 會卡住畫面。改成照實寫，並註明改成 async command 已經排進後續工作
- 模組表「視覺打磨」的 ink/paper 雙 theme 改為 light / dark（v8 Phase 3 起就換了）
- 模組表新增「v8 設計移植」一列（殼層、路線圖完成；側欄 / 右欄 / diff 與對話框接著做）；「安全護欄」補上路線圖的交叉與訊息長度上限
- 技術棧「UI 樣式」改為 v8 設計基準 CSS + Tailwind CSS（移植過渡期）；專案結構補上 `src/styles/`
- 英文版 Reflections 那句「把 capability 從 7 個入口收斂到 1 個」拿掉數字，跟中文版一樣——現在收路徑的入口不只一個

### 技術細節（不進 README，留 CHANGELOG 記錄）

- 4b 的品質流水線（串聯式：Codex 審查 → 簡化 → 安全審查 → 最終驗證）加了三道上限：站牌的訊息最多 4 行（最小視窗的 graph 區只有 388px，4 行時任何一列的上方或下方都放得下）、進 DOM 的訊息最多 1000 個 UTF-16 單位（舊 graph 截在 50 字，v8 交給 CSS 之後，惡意 repo 的超長訊息會整段進 DOM）、橋的預算（搜尋量 2,000 萬 / 洞 5 萬，拿 git/git 1000 列的 18,331 個洞校準，實測捲動每格都在 50ms 內）
- 不在主執行緒跑的只有 GitHub 的網路指令、clone，以及開 repo / 選 clone 目的地的兩個對話框；本機的 git 指令（graph、diff、push / pull 等）都還是同步 command
- 驗證：與設計基準逐像素比對，224/224 格 0 差異

## [2026-10-08] — Graph 換成 v8 路線圖，技術棧拿掉 D3.js

### 調整

- 技術棧「Graph 渲染」從 D3.js + SVG（7）改為 React + SVG——graph 換成 v8 路線圖（HTML 列 + SVG 路線層）。`d3` 其實從來沒有被任何程式 import，這次一併從 `package.json` 移除，繼續寫 D3.js 是事實錯誤
- 模組表「Commit Graph 渲染」括號改寫成現在的畫法；專案結構的元件目錄 `CommitGraph` 改名為 `Graph`

### 技術細節（不進 README，留 CHANGELOG 記錄）

- v8 Task 16 Phase 4（4a：kira-app PR #42；4b）：走線照設計基準的 0 / 45 / 90° 規則（組合 A 加列界匯流，交叉處在下層直段挖洞成橋）、每站的 ref 依字元預算收合、金箔「你在這裡」與漣漪；graph 區與設計基準逐像素比對 0 差異

## [2026-07-30] — T15f Motion P0，技術棧與動畫敘述校正

### 調整

- 技術棧「動畫」列從 Framer Motion（規劃中）改為 CSS transitions + @keyframes——T15f 的 Framer Motion go/no-go 判定 no，純 CSS 全覆蓋、零動畫依賴。繼續標「規劃中」會讓讀者以為未來仍打算引入
- 技術棧 Zustand 版本從 4 改為 5——`package.json` 實際是 5.0.12，標 4 是事實錯誤
- 核心理念「動畫是資訊」的舉例改寫——原文宣稱「Commit 進入、branch 分叉、merge 收合都有對應的動態語意」，**三者皆未實作**。改為實際 ship 的面板進場與 hover 回饋，並補上「離場刻意不做動畫」這個反面案例，它比正面舉例更能說明原則被認真執行

### 技術細節（不進 README，留 CHANGELOG 記錄）

- T15f P0（kira-app PR #36）：`@keyframes kira-fade-in`（專案第一個 keyframes）+ tab panel 200ms 進場 fade + 3px 上移 + FileItem/PRItem hover 100ms。調性定案「紙感克制 + 頻率分層」——高頻互動 100-120ms、低頻狀態變化 200-300ms、只動 `opacity` 與 `transform`（走 GPU compositing）、刻意不用 scale
- 三路平行品質 review 抓到一條靜默錯誤：裸寫 `transition-colors` 會 fallback 到 `--default-transition-timing-function`，而 Tailwind 把該值設成與 `--ease-in-out` 完全相同的曲線——三處 hover 實際跑的是 ease-in-out，違反「曲線一律 ease-out」的定案。已補顯式 `ease-out`，並把這個陷阱寫進 `CLAUDE.md` 技術約束避免再犯
- 本輪一併補記 2026-05-21 漏掉的「隨想」章節（見下方該條目）

## [2026-06-08b] — T15 視覺打磨（a–d），Graph 重繪 + 雙 theme 校準

### 新增

- 「視覺打磨」列——T15a-d 四輪收尾的總結：共用 Button/Skeleton/EmptyState/ErrorBanner 元件、Graph bullseye node + pill ref labels、ink/paper 雙 theme 校準
- ThemeSwitcher 補進 components 清單——T9 已加入但 README 漏列

### 技術細節（不進 README，留 CHANGELOG 記錄）

- T15a Rhythm Pass（kira-app PR #29）：Button 元件 + badge semantic tokens + row height 統一
- T15b Graph Craft（kira-app PR #31，審查修正 5 項）：bullseye node shape + pill ref labels + bezier 40% + diff overflow scroll + flex min-w-0 layout fix + memo comparator stale render fix + BranchRef is_remote
- T15c State Design core（kira-app PR #30）：Skeleton/EmptyState/ErrorBanner + cn() utility
- T15d Theme Parity（kira-app PR #32）：8 graph-specific CSS tokens，paper theme 深底淺字 badge 策略，merge subject textMuted→textTertiary

## [2026-06-08] — T14 完成，現況表全面更新

### 新增

- 「自動重刷」列——T9d 的 file watcher 監聽 `.git` 目錄，terminal 下 commit / reset / pull 時 Kira 自動跟上，不用手動按 refresh
- 「安全護欄」列——T14 三波強化的總結：unstaged file cap 防大 repo 拖垮 UI、checkout dirty-check 阻擋髒目錄切換、PR enrichment concurrency cap 避免 GitHub API 打爆
- `watcher.rs` 進專案結構圖——fs 模組不再只有 `recent_repos.rs`
- DiffViewer 補進 components 清單——T12c 抽出 `DiffFilesList` 後 DiffViewer 已是獨立子目錄，原先漏列

### 調整

- PR 面板狀態從 🚧 升為 ✅——T12a/b/c 三階段全部合併（IPC + patch parser → 列表 UI → diff UI），描述加上 diff 功能

## [2026-05-28]

### 新增

- 「現況」表加上 Branch 操作（checkout / create / delete）與 Clone Modal + Recent Repos Sidebar 兩列，標「✅」——T10 branch 操作 + T11a/T11b clone + T13a/T13b sidebar 已在 kira-app PR #11-#20 併進 main
- 「現況」表的 PR 面板從「⏳」改為「🚧 PR 待 merge」，補上「列表 + review/CI badge」描述——T12a（後端 IPC + patch parser）與 T12b（PR list UI + review/CI 徽章 + tab 切換）分別為 kira-app PR #21 與 #22，CI 綠等待 merge
- 專案結構新增 `github/`（auth + pr + patch_parser）、`fs/recent_repos.rs`、`git/branch.rs`、`git/clone.rs`——這些模組在 T10-T13 陸續加入，README 一直沒跟上

## [2026-05-21] — 新增「隨想」章節（補記）

> 當時漏記，2026-07-30 回頭補上。

### 新增

- 「隨想」章節（中英雙版，README.md +18 行 / README_EN.md +22 行）——談 AI 時代 Git 工具的定位：執行可以外包（commit message、rebase 指令、conflict 解法，AI 都能代勞），理解不能（拓撲、分支關係、為什麼某個 rebase 會丟東西，必須自己看）。同時補上 Non-goals 沒講清楚的切割線：不是「CLI 已經很順手」，而是「執行 vs 理解」

## [2026-05-06]

### 調整

- 「現況」表把 Diff Viewer 與 GitHub OAuth Device Flow 兩列從「🚧 PR 待 merge」改成「✅」——kira-app PR #3 + #4 已併進 main（merge commits `993876b` / `d4917e5`），cargo 126 tests + RTL 32 tests + 品質流水線全綠，OAuth flow 主路徑（modal 顯示、瀏覽器授權、polling、token 入 keyring、username 顯示）已通過 dev smoke

## [2026-05-03]

### 新增

- 「現況」表加上 Commit Graph 渲染、Staging Area UI、Push / Pull + transfer progress 三項——這三條已併進 main，從原本的「🚧」改成「✅」，讓讀者一眼看出 Kira 已經能做哪些動作
- 「現況」表加上 Diff Viewer 與 GitHub OAuth Device Flow 兩列，標「🚧 PR 待 merge」——CI 已綠、等手動 dev smoke 收尾就會進 main，預告下一波讀者會多看到什麼
- 專案結構補上 `src/components`、`src/stores`、`src/lib`、`src/tests` 四個前端子目錄，以及後端的 `git/remote.rs`（Push/Pull/Fetch 路徑）——原本只列鷹架階段的 `App.tsx`，跟實際 repo 落差太大

### 調整

- 技術棧拿掉 D3.js 與 Zustand 後面的「（規劃中）」標籤——兩者已實際進 `package.json`，再標規劃中會誤導讀者
- Framer Motion 維持「（規劃中）」——尚未進 dependencies，誠實標出
