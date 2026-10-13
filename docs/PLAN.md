# PLAN.md — Kira

> 實作路線圖。每個 Task 是可派發給 Claude Code 的最小工作單位。
>
> **編號**：開源之前的開發在私有 repo `kira-app` 進行。本文件寫成「kira-app PR #N」的是那邊的 PR，公開 repo 的 PR 從 #1 重新編號；那段時期的 commit hash，以及文件與程式註解裡的審查、決策、計畫代號（例如 Q-S、C3、G7、Codex #5、CL-3、M01、step 4）指的也是當時的私有紀錄，不在本 repo 裡，留著當索引。

---

## 實作策略

### Build Order

```
基礎層（Rust）→ Git Core → 前端 Graph 渲染 → Staging UI → Push/Pull → GitHub 整合 → Diff Viewer → 整合收尾
```

**原則**：Rust 後端先行，前端 Tauri IPC 有東西可呼叫再動 UI，避免 mock 過多。

```mermaid
graph LR
    T1["T1: 專案鷹架"] --> T2["T2: Git Core (Rust)"]
    T2 --> T3["T3: Commit Graph 渲染"]
    T2 --> T4["T4: Staging Area"]
    T3 --> T5["T5: Push / Pull"]
    T4 --> T5
    T5 --> T6["T6: GitHub OAuth"]
    T6 --> T7["T7: PR 面板"]
    T3 --> T8["T8: Diff Viewer"]
    T4 --> T8
    T8 --> T7
    T7 --> T9["T9: 整合與視覺收尾<br/>(T9a/b/c shipped,<br/>RepoSidebar/Branch/Clone 順延)"]
    T8 --> T9
    T9 --> T13a["T13a: RepoSidebar 骨架<br/>(Recent + Guide + disabled Clone)"]
    T13a --> T10["T10: Branch 操作<br/>(Safe/Force checkout + conflict surface)"]
    T10 --> T11a["T11a: git_clone 後端"]
    T11a --> T11b["T11b: Clone Modal 前端"]
    T11b --> T13b["T13b: 整合 BranchList + Clone"]
    T13b --> T12a["T12a: GitHub IPC + patch parser<br/>+ DiffFilesView 抽取"]
    T12a --> T12b["T12b: PR list UI"]
    T12b --> T12c["T12c: PR diff UI"]
    T12c --> T9d["T9d: File Watcher"]
    T9d --> T14["T14: 功能穩固<br/>(cap / dirty-check / concurrency)"]
    T14 --> T15a["T15a: Rhythm Pass"]
    T15a --> T15b["T15b: Graph Craft"]
    T15a --> T15c["T15c: State Design core"]
    T15b --> T15d["T15d: Theme Parity"]
    T15c --> T15d
    T15c --> T15e["T15e: State Design edge"]
    T15d --> T15f["T15f: Motion"]
    T15e --> T15f
    T15f --> T16["T16: v8 雲母路線圖完整複刻"]
```

T3 和 T4 可平行開發（各自依賴 T2 但互不依賴）。

**T10–T13 執行順序**（2026-05-18 多模型重審後重排）：
T13a → T10 → T11a → T11b → T13b → T12a → T12b → T12c。
理由：T13a 是 App 骨架（容器先有）；T10 高頻動作（每日 N 次）優先 Clone (低頻)；T11/T12 後端均未實作，各拆兩段；T12 PR Diff 需 patch parser + DiffFilesView 抽取（前置工作）。
**T9d Watcher 維持 P1**（terminal developer 開外部 CLI commit/reset/pull 都會讓 Kira stale，T10 只解內部 checkout）。

### 測試策略

- **框架**：Rust 端用 `cargo test`，前端用 Vitest
- **覆蓋率目標**：Rust 核心邏輯 ≥ 80%，前端 store 層 ≥ 70%
- **測試金字塔**：單元 75% / 整合 20% / E2E 5%
- **命名慣例**：`test_<模組>_<功能>_<情境>_<預期>`

### 風險與回退

| 風險 | 回退方案 |
|------|---------|
| git2-rs commit graph 計算在大型 repo 超時 | 增加 `limit` 參數，預設只載入最近 1,000 commits，按需載入更多 |
| D3.js graph layout 在複雜 branch 結構下錯位 | MVP 先支援線性 + 單層分支，複雜 rebase 圖形列入 v1.1 |
| GitHub OAuth callback 在 Windows 防火牆被擋 | 提供 token 手動貼入的備用登入入口 |

---

## Task 清單

### Task 1：專案鷹架

**目標**：建立 Tauri v2 + React + TypeScript 專案基礎，確認開發環境可運行。

**影響範圍**：
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `tailwind.config.ts`
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/lib.rs`
- Create: `.gitignore`（含 `.claude/`、`node_modules/`、`target/`、`dist/`、`.DS_Store`）
- Create: `.github/workflows/build.yml`（多平台 CI）

**依賴**：無

**驗收條件**：
- Given 開發環境安裝完成 → When `npm run dev` → Then Tauri 視窗開啟，顯示空白 React 畫面
- Given 任意 commit → When GitHub Actions 觸發 → Then macOS / Windows build 均通過

**測試設計**：
- 正常：開發模式啟動無 console error
- 正常：`npm run build` 產生可執行 binary

**完成信號**：`npm run dev` 無錯誤啟動 + CI pipeline 綠燈

---

### Task 2：Git Core（Rust）

**目標**：實作全部 git 相關 Tauri 指令，以 git2-rs 為基礎。

**影響範圍**：
- Create: `src-tauri/src/commands/git.rs`
- Create: `src-tauri/src/git/graph.rs`
- Create: `src-tauri/src/git/diff.rs`
- Create: `src-tauri/src/git/stage.rs`
- Create: `src-tauri/src/error.rs`（KiraError 定義）
- Modify: `src-tauri/src/lib.rs`（註冊所有 git 指令）
- Modify: `src-tauri/Cargo.toml`（加入 git2 依賴）
- Create: `src-tauri/src/tests/git_test.rs`

**依賴**：Task 1

**驗收條件**（覆蓋 SPEC.md 全部 10 個 git 指令）：
- Given 合法 repo 路徑 → When `git_open_repo` → Then 回傳正確 branch 名稱和 remote 清單
- Given GitHub URL 與目標路徑 → When `git_clone` → Then 透過 Tauri event 回報進度，clone 完成後可開啟 repo
- Given 有 1,000 commits 的 repo → When `git_get_graph` → Then 在 500ms 內回傳完整 CommitNode 陣列
- Given 合法 commit oid → When `git_get_diff` → Then 回傳 FileDiff 陣列含 hunks
- Given working directory 有修改的檔案 → When `git_get_status` → Then 正確區分 staged / unstaged
- Given unstaged 檔案 → When `git_stage_file` → Then 檔案移入 staged
- Given staged 檔案 → When `git_unstage_file` → Then 檔案移回 unstaged
- Given staged 檔案 + commit message → When `git_commit` → Then 回傳新 commit oid
- Given 有 unpushed commits → When `git_push` → Then 透過 Tauri event 回報進度
- Given 遠端有新 commits → When `git_pull` → Then 回傳 commits_added 數量
- Given 非 repo 路徑 → When `git_open_repo` → Then 回傳 KiraError::NotARepo

**測試設計**：
- 正常：`test_git_open_repo_validPath_returnsRepoInfo`
- 正常：`test_git_clone_validUrl_clonesToDest`
- 正常：`test_git_get_graph_smallRepo_returnsCommits`
- 正常：`test_git_get_diff_validOid_returnsHunks`
- 正常：`test_git_stage_file_validFile_movesToStaged`
- 正常：`test_git_unstage_file_stagedFile_movesToUnstaged`
- 正常：`test_git_commit_withMessage_returnsOid`
- 正常：`test_git_pull_remoteAhead_returnsCommitsAdded`
- 邊界：`test_git_get_graph_emptyRepo_returnsEmptyList`
- 邊界：`test_git_commit_emptyMessage_returnsError`
- 邊界：`test_git_get_graph_limit1000_returnsMaxCommits`
- 錯誤：`test_git_open_repo_invalidPath_returnsNotARepo`
- 錯誤：`test_git_clone_invalidUrl_returnsError`
- 錯誤：`test_git_get_diff_invalidOid_returnsCommitNotFound`
- 錯誤：`test_git_push_noRemote_returnsError`

**完成信號**：所有 Rust 測試通過 + `cargo clippy` 零警告

---

### Task 3：Commit Graph 渲染

**目標**：以 D3.js 實作動態 Commit Graph，含 branch 顏色系統和 commit 節點互動。

**影響範圍**：
- Create: `src/components/CommitGraph/GraphCanvas.tsx`
- Create: `src/components/CommitGraph/CommitNode.tsx`
- Create: `src/components/CommitGraph/BranchLane.tsx`
- Create: `src/components/CommitGraph/CommitTooltip.tsx`
- Create: `src/stores/graphStore.ts`
- Create: `src/lib/graphLayout.ts`（DAG → 座標計算）
- Create: `src/lib/branchColors.ts`（顏色分配邏輯）
- Create: `src/lib/tauri.ts`（IPC 封裝，`getGraph` 等）
- Create: `src/tests/graphLayout.test.ts`
- Create: `src/tests/branchColors.test.ts`

**依賴**：Task 2

**驗收條件**：
- Given `git_get_graph` 回傳資料 → When GraphCanvas 渲染 → Then 每個 branch 有獨立顏色，commit 節點從上到下排列
- Given branch 有分叉 → When 渲染 → Then 分叉以平滑曲線連接，視覺上可辨識
- Given hover commit 節點超過 300ms → When tooltip 顯示 → Then 呈現 message / author / time / changed files 數
- Given 點擊 commit 節點 → When 操作 → Then graphStore.selectedCommit 更新

**測試設計**：
- 正常：`test_graphLayout_linearHistory_returnsVerticalNodes`
- 正常：`test_branchColors_eightBranches_allUniqueColors`
- 正常：`test_branchColors_mainBranch_alwaysFirstColor`
- 邊界：`test_graphLayout_mergeCommit_twoParentLines`
- 邊界：`test_graphLayout_emptyCommits_returnsEmptyArray`
- 邊界：`test_branchColors_moreThanEightBranches_cyclesColors`

**完成信號**：所有前端測試通過 + 目視確認 1,000 commits 的 graph 在 60fps 下流暢渲染

---

### Task 4：Staging Area

**目標**：實作 Stage / Unstage / Commit 的視覺化操作介面。

**影響範圍**：
- Create: `src/components/StagingArea/StagingArea.tsx`
- Create: `src/components/StagingArea/FileItem.tsx`
- Create: `src/components/StagingArea/CommitForm.tsx`
- Create: `src/stores/repoStore.ts`（加入 workingTree 狀態）
- Modify: `src/lib/tauri.ts`（加入 stageFile / unstageFile / commit 封裝）

**依賴**：Task 2

**驗收條件**：
- Given working tree 有檔案 → When StagingArea 開啟 → Then Unstaged / Staged 兩區塊正確列出檔案
- Given 點擊檔案「+」→ When 操作 → Then 檔案移入 Staged，UI 即時更新
- Given Staged 有檔案且 message 非空 → When 點擊 Commit → Then 建立 commit，StagingArea 清空
- Given message 為空 → When 點擊 Commit → Then Commit 按鈕維持 disabled 狀態

**測試設計**：
- 正常：`test_stagingArea_stageFile_movesToStagedSection`
- 正常：`test_stagingArea_unstageFile_movesToUnstagedSection`
- 正常：`test_commitForm_validMessage_enablesCommitButton`
- 邊界：`test_commitForm_emptyMessage_disablesCommitButton`
- 邊界：`test_stagingArea_emptyWorkingTree_showsEmptyState`

**完成信號**：所有測試通過 + 完整 stage → commit 流程可在 UI 操作成功

---

### Task 5：Push / Pull

**目標**：實作 push / pull 操作，含進度動畫與 Graph 即時更新。

**影響範圍**：
- Create: `src/components/RepoSidebar/PushPullBar.tsx`
- Modify: `src/stores/repoStore.ts`（加入 push/pull 狀態）
- Modify: `src/lib/tauri.ts`（加入 push / pull 封裝 + event listener）
- Modify: `src-tauri/src/commands/git.rs`（加入 push / pull 指令，發送 Tauri events）

**依賴**：Task 3、Task 4

**驗收條件**：
- Given 有 unpushed commits → When 點擊 Push → Then 顯示進度動畫，成功後 Graph remote 指示器更新
- Given 遠端有新 commits → When 點擊 Pull → Then fetch + merge，Graph 新增節點
- Given 網路錯誤 → When Push → Then 顯示錯誤訊息，不崩潰

**測試設計**：
- 正常：`test_pushPullBar_pushSuccess_updatesRemoteRef`
- 正常：`test_pushPullBar_pullSuccess_addsCommitNodes`
- 錯誤：`test_pushPullBar_networkError_showsErrorMessage`
- 錯誤：`test_pushPullBar_authFailed_showsAuthPrompt`

**完成信號**：所有測試通過 + 目視確認 push / pull 後 Graph 正確更新

---

### Task 6：GitHub OAuth

**目標**：實作 GitHub OAuth PKCE 流程，token 存入系統 keychain。

**影響範圍**：
- Create: `src-tauri/src/github/auth.rs`
- Create: `src-tauri/src/commands/github.rs`（github_start_oauth / github_oauth_callback）
- Modify: `src-tauri/Cargo.toml`（加入 keyring / reqwest 依賴）
- Create: `src/stores/authStore.ts`
- Create: `src/components/Auth/LoginButton.tsx`

**依賴**：Task 1

**驗收條件**：
- Given 未登入狀態 → When 點擊「Connect GitHub」→ Then 開啟瀏覽器 GitHub OAuth 頁面
- Given 使用者授權 → When callback 完成 → Then token 寫入系統 keychain，authStore.isAuthenticated = true
- Given 已登入 → When 重新開啟 App → Then 自動從 keychain 讀取 token，保持登入狀態

**測試設計**：
- 正常：`test_auth_oauthCallback_validCode_storesToken`
- 正常：`test_auth_appRestart_keychainHasToken_autoLogin`
- 錯誤：`test_auth_oauthDenied_returnsError`
- 錯誤：`test_auth_oauthTimeout_returnsTimeoutError`

**完成信號**：所有測試通過 + 完整 OAuth 流程在 macOS / Windows 上可操作

---

### Task 7：PR 面板

**目標**：實作 GitHub PR 列表與 PR diff 閱讀功能。

**影響範圍**：
- Create: `src-tauri/src/github/pr.rs`
- Modify: `src-tauri/src/commands/github.rs`（加入 github_get_prs / github_get_pr_diff）
- Create: `src/components/PRPanel/PRPanel.tsx`
- Create: `src/components/PRPanel/PRItem.tsx`
- Modify: `src/lib/tauri.ts`（加入 getPRs / getPRDiff 封裝）

**依賴**：Task 6、Task 8

**驗收條件**：
- Given 已登入 → When 切換到 PR 面板 → Then 列出 open PR，含標題 / 作者 / review 狀態 / CI 狀態
- Given 點擊 PR → When 展開 → Then 顯示 PR diff（複用 DiffViewer 元件）

**測試設計**：
- 正常：`test_prPanel_authenticated_listsPRs`
- 正常：`test_prPanel_clickPR_showsDiff`
- 錯誤：`test_prPanel_notAuthenticated_showsLoginPrompt`
- 錯誤：`test_prPanel_repoNotOnGitHub_showsEmptyState`

**完成信號**：所有測試通過 + PR 列表在有 PR 的 repo 正確顯示

---

### Task 8：Diff Viewer

**目標**：實作 commit diff 和 PR diff 的視覺化閱讀介面，含語法高亮。

**影響範圍**：
- Create: `src/components/DiffViewer/DiffViewer.tsx`
- Create: `src/components/DiffViewer/DiffHunk.tsx`
- Create: `src/components/DiffViewer/DiffLine.tsx`
- Create: `src/lib/syntaxHighlight.ts`（整合 highlight.js 或 shiki）
- Modify: `src/lib/tauri.ts`（加入 getDiff 封裝）

**依賴**：Task 2

**驗收條件**：
- Given 點擊 Graph 上的 commit → When DiffViewer 開啟 → Then 正確顯示新增（綠）/ 刪除（紅）行
- Given TypeScript 檔案的 diff → When 顯示 → Then 語法高亮正確
- Given binary 檔案（圖片）的 diff → When 顯示 → Then 顯示「Binary file changed」而非亂碼

**測試設計**：
- 正常：`test_diffViewer_textFile_showsAddDeleteLines`
- 正常：`test_diffViewer_tsFile_appliesSyntaxHighlight`
- 邊界：`test_diffViewer_binaryFile_showsBinaryMessage`
- 邊界：`test_diffViewer_largeFile_1000Lines_rendersWithoutFreeze`

**完成信號**：所有測試通過 + 目視確認 TypeScript / Go / Python 語法高亮正確

---

### Task 9：整合與視覺收尾

**目標**：整合所有模組，完成視覺設計打磨，確認 MVP 驗收標準全部達標。

**影響範圍**：
- Create: `src/components/RepoSidebar/RepoSidebar.tsx`（Open / Clone / Recent Repos）
- Create: `src/components/RepoSidebar/BranchList.tsx`
- Modify: `src/App.tsx`（佈局組裝，Panel 切換邏輯）
- Modify: 所有元件（視覺設計細節調整：間距、顏色、動畫時序）
- Create: `src-tauri/src/commands/fs.rs`（recent_repos 讀寫）
- Create: `docs/CHANGELOG.md`

**依賴**：Task 3、4、5、7、8

**驗收條件**：
- Given 開啟 App → When 沒有 recent repos → Then 顯示 Open / Clone 引導畫面
- Given 非開發者使用者 → When 瀏覽介面 → Then 1 分鐘內可找到所有 P0 功能入口
- Given 5,000 commits 的 repo → When 開啟 → Then Graph 在 2 秒內渲染完成
- Given 任意操作 → When 執行 → Then 不出現 console error，不崩潰

**完成信號**：PRD 所有 P0 / P1 驗收標準全部達標 + 冒煙測試通過

> **實作落差說明 + 結構重排**（2026-05-18 補）：T9a / T9b / T9c 完成 visual identity（dual theme + a11y）與 push/pull experience polish，但 T9 plan 中的 `RepoSidebar` / `BranchList` / `Clone UI` / `fs.rs (Recent Repos)` 未實作。經 Codex + Gemini 重審：T11 `git_clone` 後端與 T12 `github_get_prs/diff` 後端均未實作，T11/T12 各拆兩段；T12 PR Diff 需 patch parser 與 DiffFilesView 抽取（前置工作）；T10 dirty checkout 第一版只支援 Safe/Force/Cancel，stash flow 延後。執行順序：T13a → T10 → T11a → T11b → T13b → T12a → T12b → T12c。

---

### Task 13a：RepoSidebar 骨架（Recent Repos + Guide Screen）

**目標**：先 ship App 骨架（容器）—— Recent Repos + Open / Clone 引導畫面 + 主畫面左側 sidebar。BranchList 與 Clone modal 位置先放 placeholder，待 T10 / T11 接入。

**動機**：Gemini review 指出「先實作骨架，T10/T11 有現成容器可放 UI」。Codex 警告 placeholder Clone button 必須 clearly disabled，不可當主 CTA。

**影響範圍**：
- Modify: `docs/SPEC.md`（補 fs IPC 規格：`recent_repos_get` / `recent_repos_add` / `recent_repos_remove`）
- Create: `src-tauri/src/commands/fs.rs`（3 個 fs IPC）
- Create: `src-tauri/src/fs/recent_repos.rs`（JSON r/w，用 `tempfile` crate `persist` 跨平台 atomic）
- Modify: `src-tauri/src/lib.rs`（註冊 fs handler）
- Modify: `src-tauri/Cargo.toml`（加 `tempfile` dep）
- Create: `src/components/RepoSidebar/RepoSidebar.tsx`（recent + sidebar 容器，BranchList 區為 placeholder）
- Create: `src/components/RepoSidebar/RecentRepoItem.tsx`
- Create: `src/components/RepoSidebar/GuideScreen.tsx`（無 recent repos 引導：Open + disabled Clone tooltip "Available in next release"）
- Modify: `src/App.tsx`（boot 流程改走 GuideScreen / RepoSidebar；主畫面左側 sidebar）
- Modify: `src/stores/repoStore.ts`（recentRepos slice + open repo 自動 add + stale entry prune）
- Modify: `src/lib/tauri.ts`（fs IPC 封裝）

**依賴**：T9c

**驗收條件**：
- Given 第一次開啟 Kira（無 `recent_repos.json`）→ When boot 完成 → Then 顯示 GuideScreen 含 Open button + disabled Clone button（tooltip "Available in T11"）
- Given 有 recent repos → When boot 完成 → Then RepoSidebar 列出最多 10 筆，最近開啟在上
- Given 點擊 recent repo → When 點擊 → Then 自動 `git_open_repo` + 進入主畫面
- Given recent repo 路徑已不存在 → When 點擊 → Then 顯示「找不到」+ 自動從清單移除
- Given 開啟新 repo → When 操作完成 → Then 自動加入 recent repos 頂端
- Given recent repos 達 10 筆 → When 開新 repo → Then 最舊一筆被踢出
- Given 同一 canonical path 重複開啟 → When 操作 → Then 不重複，只更新 `last_opened`
- Given `recent_repos.json` 損壞 → When 讀取 → Then 回空清單 + log warning（fail closed），不崩潰
- Given Windows 上 `recent_repos.json` 已存在 → When 寫入 → Then `tempfile::persist` 正確覆蓋（不 `PermissionDenied`）
- Given 主畫面 RepoSidebar 開啟 → When 顯示 → Then 含 recent repos + BranchList placeholder 區（標 "Coming in T10"）

**測試設計**：
- 正常：`test_recent_repos_addRepo_appearsTop`
- 正常：`test_recent_repos_duplicatePath_updatesLastOpenedNotDuplicate`
- 邊界：`test_recent_repos_overTenEntries_evictsOldest`
- 邊界：`test_recent_repos_missingPath_autoPrunes`
- 邊界：`test_recent_repos_noFile_returnsEmpty`
- 邊界：`test_recent_repos_corruptJson_returnsEmpty_logsWarning`
- 平台：`test_recent_repos_windowsExistingFile_persistsCleanly`（Windows runner 跑）
- UI：`test_guideScreen_noRecentRepos_showsOpenAndDisabledClone`
- UI：`test_repoSidebar_clickRecent_opensRepo`
- 安全：`test_recent_repos_pathOutsideHome_acceptedButCanonicalized`

**安全 / 紀律考量**：
- `recent_repos.json` 路徑 IPC 不收前端輸入，後端固定 `app_data_dir/`（IPC capability 規則）
- Atomic write 用 `tempfile` crate `persist`（跨平台一致，**非** `std::fs::rename`，Windows target 已存在會 `PermissionDenied`）
- Parse 失敗回空清單而非 panic（fail closed）

**完成信號**：所有測試通過（含 Windows 平台測試） + 首次開啟 / 多次開啟 / 路徑失效 / corrupt JSON 四情境 UX 正確 + `recent_repos.json` 在 `app_data_dir/` 正確讀寫 + dev smoke 過

---

### Task 10：Branch 操作（List / Create / Checkout / Delete + Conflict Surface）

**目標**：實作 branch 列表 + 建立 + 切換 + 刪除 IPC + UI，補上 PRD P1 Branch 操作；同時補 conflict surface（`git_get_status` is_conflicted flag + UI 列表）。第一版 checkout 只支援 Safe / Force / Cancel，stash flow 延後。

**動機**：兩家 review 共識「Branch 切換是每日高頻動作，目前 Kira 內部無法切 branch 會反覆跳回終端機」。同時 T9c #5 dev smoke #2 stale repoInfo bug root cause 之一。Conflict surface 是 MVP 命脈（pull merge conflict 場景沒救則使用者立即對 App 失去信任）。

**影響範圍**：
- Modify: `docs/SPEC.md`（**已在 SPEC 補**：`git_list_branches` / `git_create_branch` / `git_checkout_branch` / `git_delete_branch` + `git_get_status` 補 `conflicted` 區塊）
- Modify: `src-tauri/src/commands/git.rs`（4 個新 IPC + `git_get_status` 擴 conflicted）
- Create: `src-tauri/src/git/branch.rs`（branch 操作邏輯 + per-branch ahead/behind 計算）
- Modify: `src-tauri/src/git/stage.rs` 或 `status.rs`（補 conflict detection）
- Modify: `src-tauri/src/lib.rs`（註冊 4 個 handler，順手做全域 `default_attrs` 簡化 `rename_all` 紀律）
- Create: `src/components/BranchList/BranchList.tsx`（list + create + delete + checkout + per-branch ahead/behind 顯示）
- Create: `src/components/BranchList/CheckoutConfirmDialog.tsx`（Safe / Force / Cancel 三選項，**不含 stash 保留**）
- Modify: `src/components/StagingArea/StagingArea.tsx` 或新建 `ConflictList.tsx`（顯示 conflicted files + 「需手動解決」引導）
- Modify: `src/lib/tauri.ts`（listBranches / createBranch / checkoutBranch / deleteBranch 封裝）
- Modify: `src/App.tsx`（接 T13a sidebar 的 BranchList placeholder）
- Modify: `src/stores/repoStore.ts`（checkout 完成後自動 refresh `repoInfo + graph + status`）

**依賴**：T13a（sidebar 容器）

**驗收條件**：
- Given 本地有多個 branch → When 開啟 BranchList → Then 列出所有 local branch，標示 current + per-branch ahead/behind upstream
- Given 點擊某 branch → When 確認 checkout（clean tree）→ Then working tree 切換，Graph + Staging 自動 refresh（無需手動 Refresh）
- Given working tree dirty + 點擊 checkout → When 跳 dialog → Then 三選項：**Safe**（拒絕，fail closed）/ **Force**（覆蓋，二次確認）/ **Cancel**；**不含 stash 保留**
- Given Safe checkout 撞衝突 → Then 顯示 `DIRTY_TREE` 錯誤，引導使用者「手動 commit 或 discard 後再試」
- Given Force checkout → Then 覆蓋 working tree，dirty changes lost（已二次確認）
- Given 點擊 New Branch → When 輸入名稱 + 選擇 base（預設 HEAD）→ Then 建立 branch（不切換），列表更新
- Given 點擊 Delete on non-current branch（merged）→ When 確認 → Then 刪除成功
- Given 點擊 Delete on unmerged branch → When 操作 → Then 需 `force=true` 二次確認
- Given 嘗試刪除當前 branch → Then disabled + tooltip 提示原因
- Given rebase / merge / cherry-pick 進行中 → When checkout / create / delete → Then 回 `REPOSITORY_NOT_CLEAN` 拒絕（state guard）
- Given pull / merge 後有衝突 → When 顯示 status → Then conflicted files 列在 UI（含「需手動解決」訊息引導使用者回 CLI）
- Given branch 名含 spaces / `..` / control chars / leading `-` → When 建立 → Then 回 `INVALID_BRANCH_NAME`

**測試設計**：
- 正常：`test_git_list_branches_returnsAllWithAheadBehind`
- 正常：`test_git_create_branch_validName_createsRef`
- 正常：`test_git_checkout_cleanTree_safe_switchesHead`
- 正常：`test_git_checkout_dirtyTree_force_overwrites`
- 正常：`test_git_delete_branch_merged_succeeds`
- 正常：`test_git_get_status_conflictedFiles_listedInConflicted`
- 邊界：`test_git_checkout_dirtyTree_safe_returnsDirtyTreeError`
- 邊界：`test_git_delete_branch_unmerged_requiresForce`
- 邊界：`test_git_delete_branch_currentBranch_returnsCannotDeleteCurrent`
- 邊界：`test_git_create_branch_invalidName_returnsInvalidBranchName`
- 邊界：`test_git_create_branch_duplicateName_returnsBranchExists`
- 邊界：`test_git_checkout_duringRebaseState_returnsRepositoryNotClean`
- 邊界：`test_git_list_branches_detachedHead_isCurrentAllFalse`
- 邊界：`test_git_list_branches_noUpstream_aheadBehindZero`
- 錯誤：`test_git_checkout_nonExistentBranch_returnsBranchNotFound`

**安全 / 紀律考量**：
- IPC mutating 取 write_lock（IPC capability 規則）
- checkout / delete / create 前 `repo.state() == Clean` check（merge / rebase 進行中寫入會弄壞歷史）
- branch 名 IPC 邊界驗格式（refname 規則 + 字元 cap，IPC 輸入邊界規則）
- `rename_all = "snake_case"` 改全域 default 簡化
- 第一版**不含** stash flow（兩家 review 共識 scope 會炸；stash 另開未來 task）

**完成信號**：所有 Rust + 前端測試通過 + list / create / checkout (safe + force) / delete 完整流程可在 UI 操作成功 + conflict files 在衝突情境正確列出 + `cargo clippy` 零警告 + dev smoke 過

---

### Task 11a：`git_clone` 後端實作

**目標**：實作 clone 三件套 IPC（`git_clone_start` / `git_clone_cancel` / `pick_clone_dest`）+ `clone:progress` / `clone:done` event 推送。Review verify 確認後端 0 行（`lib.rs` handler list 無 clone），從零實作。對齊動工前計畫審查提出的 17 處補強（5 Critical / 6 High / 6 Medium）。

**影響範圍**（從原 4 file 擴成 6 file + 2 doc）：
- Create: `src-tauri/src/git/clone.rs`（RepoBuilder + 全套 RemoteCallbacks/CheckoutBuilder + cancel observed flag + classify_git_error 補丁）
- Create: `src-tauri/src/commands/clone_dest.rs`（`pick_clone_dest` Rust 端 dialog command + `pending_clone_dest_lock` Tauri State）
- Modify: `src-tauri/src/commands/git.rs`（`git_clone_start` async command + `git_clone_cancel` command + URL/dest IPC bounds + userinfo reject + `~` reject）
- Modify: `src-tauri/src/lib.rs`（`CloneRegistry` + `pending_clone_dest_lock` `.manage()` + 3 個 handler 註冊）
- Modify: `src-tauri/src/git/remote.rs`（`github_token_cred_callback` `pub(super) → pub(crate)`；不動 callback 行為）
- Modify: `src-tauri/src/error.rs`（新增 `INSUFFICIENT_DISK_SPACE` / `INVALID_CLONE_ID` / `CANCELLED` variants + classify_git_error 對齊）
- Modify: `docs/SPEC.md`（S1-S6 落地：拆 IPC + events + limitation 段；已在 docs/t11a-pre-impl PR 完成）
- Modify: `docs/PLAN.md`（本段；已在 docs/t11a-pre-impl PR 完成）

**依賴**：T10（避免合併衝突；T10 已 ship，本質上 T11a 可獨立進行）

**驗收條件**（12 BDD，對齊動工前計畫審查提出的項目）：
- Given 合法 HTTPS URL + 已 `pick_clone_dest` 註冊的空 dest → When `git_clone_start` → Then 回 `{ clone_id }`，背景啟動 clone，event 順序 `clone:progress(Receiving) → clone:progress(Resolving) → clone:progress(CheckingOut) → clone:done Ok { path, repo_id }`
- Given dest 已存在且含**非 platform-noise 檔** → When `git_clone_start` → Then 回 `DEST_EXISTS`（preflight 階段，不觸發 libgit2）
- Given dest 只含 `.DS_Store` / `desktop.ini` / `.localized` / `Thumbs.db` → When `git_clone_start` → Then 視為 effectively empty，preflight rm noise files 後進 clone
- Given dest 未經 `pick_clone_dest` 註冊（或 lock 已 5 min 過期）→ When `git_clone_start` → Then 回 `INVALID_PATH`（Layer 1 capability）
- Given URL 含 userinfo（`https://token@github.com/...` / `https://user:pass@...`）→ When `git_clone_start` → Then 回 `INVALID_URL` with hint「不接受 URL embedded credentials，請走 OAuth 登入」
- Given URL scheme 非 HTTPS（`ssh://` / `git://` / `file://`）→ When `git_clone_start` → Then 回 `INVALID_URL`（HTTPS only，與 `Cargo.toml:22` git2 feature 對齊）
- Given dest 為相對路徑 / 含 `~` → When `git_clone_start` → Then 回 `INVALID_PATH`（T11a 不做 expansion）
- Given 私有 GitHub repo URL 無 token → When clone → Then 走 `github_token_cred_callback`（pub crate），無 token 回 `AUTH_FAILED` with hint「請走 OAuth 登入」
- Given 私有 non-github HTTPS → When clone → Then `github_token_cred_callback` allowlist reject，回 `AUTH_FAILED` with hint「私有 repo 僅支援 GitHub」
- Given 網路中斷 in-flight → When clone → Then 回 `NETWORK_ERROR`，libgit2 自動 rmdir cleanup dest；rare 情況殘留時 error hint 提示
- Given user `git_clone_cancel(clone_id)` in-flight → When clone → Then 中止 transfer，回 `CANCELLED`（依 `cancel_observed_in_callback` 判，非靠 `ErrorCode::User`），libgit2 自動 rmdir cleanup dest
- Given user 在 network error 後才點 cancel（`cancel_requested == true` 但 callback 未實際因 cancel return）→ Then 分類 `NETWORK_ERROR` 不是 `CANCELLED`（corner case）
- Given 磁碟空間不足（OS `ENOSPC`）→ When clone 寫 packfile → Then 回 `INSUFFICIENT_DISK_SPACE` with hint 提示清磁碟
- Given clone 空 repo（無 commit）→ Then `clone:done Ok`，dest 含 `.git/`、working tree 空、HEAD unborn（避免誤判 NETWORK_ERROR）
- Given `git_clone_cancel(unknown_id)` 或 settled clone_id → Then 回 `{ cancelled: false }`（idempotent）或 `INVALID_CLONE_ID`

**測試設計**（10 unit test，全用 `file://` local bare repo bypass IPC scheme validate，不打網路）：
- 正常：`test_git_clone_localBare_returnsRepoPath`
- 正常：`test_git_clone_emitsProgressEventsWithPhase`（驗 Receiving → Resolving → CheckingOut 序列）
- 正常：`test_git_clone_emptyRepo_succeedsWithUnbornHead`
- 邊界：`test_git_clone_destExists_returnsDestExistsError`
- 邊界：`test_git_clone_destPlatformNoiseOnly_treatedAsEmpty`
- 邊界：`test_git_clone_destNotInPendingLock_returnsInvalidPath`
- 邊界：`test_git_clone_invalidScheme_returnsInvalidUrl`（ssh / git / file via IPC bound check）
- 邊界：`test_git_clone_userinfoUrl_returnsInvalidUrl`
- 錯誤：`test_git_clone_cancelled_observedInCallback_returnsCancelled`
- 錯誤：`test_git_clone_cancelAfterFail_returnsNetworkError`（corner case）
- 錯誤：`test_git_clone_diskFull_returnsInsufficientDiskSpace`（mock OS error）
- 錯誤：`test_git_clone_invalidCloneId_returnsInvalidCloneId`

**Commit 邊界**（8 個，依 Codex 建議 incremental ship）：
1. `feat(t11a)`: error.rs 新增 3 variants（`INSUFFICIENT_DISK_SPACE` / `INVALID_CLONE_ID` / `CANCELLED`）+ classify_git_error 對齊（`Exists` / `Os ENOSPC` / `UnbornBranch` 分支）
2. `feat(t11a)`: `CloneRegistry` + `pending_clone_dest_lock` + `CloneHandle` struct + `lib.rs .manage()` + 兩個 Tauri State 註冊
3. `feat(t11a)`: URL/dest IPC bounds + `url::Url` userinfo reject + scheme allowlist + dest absolute check + `pick_clone_dest` Rust 端 dialog command
4. `feat(t11a)`: `clone.rs` engine（`RepoBuilder::clone` + 全套 RemoteCallbacks: transfer_progress / sideband_progress / update_tips + `CheckoutBuilder::notify` + `cancel_observed_in_callback: AtomicBool`）
5. `feat(t11a)`: `remote.rs` `github_token_cred_callback` `pub(super) → pub(crate)` + clone.rs 引用對齊 AUTH_FAILED classify
6. `feat(t11a)`: progress events + `ClonePhase` enum + checkout phase callback + throttle 100ms（per-phase + 切換時強制 emit）
7. `feat(t11a)`: open after clone（內部 `open_repo_inner`）+ recent_repos 整合 + `git_clone_cancel` IPC + `clone:done` Ok/Err payload
8. `feat(t11a)`: 10 unit test + dev smoke fixture + `cargo clippy` 零警告 + `cargo fmt --check` + lint cleanup

**安全 / 紀律考量**：
- **IPC bounds**：URL length cap = 2048（HTTP URL practical limit）；dest length cap = `MAX_REPO_PATH_LEN` = 4096；含 NUL 一律 reject；對齊 IPC 輸入邊界規則
- **URL parse**：`url::Url::parse` 後 check `parsed.username().is_empty() && parsed.password().is_none()`（token 落地防護，呼應 token 只存系統 keychain 的規則）；scheme 必須 `"https"`
- **dest capability**：必須先經 `pick_clone_dest` 註冊到 `pending_clone_dest_lock`（HashMap<canonical, Instant>，5 min lifetime），對齊 T13a Layer 1 capability。Layer 2 gap（同 webview 內 prompt-injected renderer 可在 5 min 內覆用註冊 dest）documented 在 SPEC，T14+ 統一處理
- **Cancel signal cross-thread**：`Arc<AtomicBool> cancel_requested` + `Arc<AtomicBool> cancel_observed_in_callback`，所有 RemoteCallbacks + `CheckoutBuilder::notify` 都讀 `cancel_requested`、實際 return false 時 set `cancel_observed_in_callback`
- **Cancel error classify**：`cancel_observed_in_callback == true` → `CANCELLED`；否則走 `classify_git_error`（網路 / auth / disk / generic），**不靠 `err.code() == ErrorCode::User`**（git2-rs 0.19 拿掉 GIT_EUSER mapping）
- **Sidecar callbacks 全掛 cancel**：transfer_progress / sideband_progress / update_tips / `CheckoutBuilder::notify(NotifyFlags::ALL)`；`pack_progress` 對 HTTPS 不是主路徑，不掛
- **Async worker**：`git_clone_start` 加 `#[tauri::command(async)]`，內部 `tokio::task::spawn_blocking` 跑 `RepoBuilder::clone`（避免 main thread block 收不到 cancel IPC）
- **Progress event throttle**：per-phase 100ms gate（`Arc<Mutex<Instant>>`），phase 切換時強制 emit 一筆無視 throttle（libgit2 對小 packfile 不觸發 callback，throttle 仍需 unit test 驗 phase 切換序列）
- **Credential callback**：複用 `github_token_cred_callback`（remote.rs，pub crate up，**不改 callback 行為**，allowlist 仍 GitHub-only）
- **Partial state 字樣移除**：BDD / SPEC / error message 全不主張「partial state」，改「libgit2 attempts cleanup; rare residual on AV / external file handle / Windows」（libgit2 clone 失敗的清理行為，推翻 v0 plan 契約）

**完成信號**：
- 10 unit test 全綠（cargo test，不打網路）
- `cargo clippy --all-targets --all-features -- -D warnings` 零警告
- `cargo fmt --check` 通過
- `npx tsc --noEmit` + `npm run lint` 通過
- Dev smoke 4 情境 macOS verified：
  1. 公開 github.com clone（`https://github.com/octocat/Hello-World.git`）
  2. 私有 github.com OAuth clone（user 已登入）
  3. Cancel mid-clone（cancel button 觸發，progress 凍結，event `clone:done Err CANCELLED`）
  4. 已 `pick_clone_dest` 註冊的 dest reuse（5 min 內二次 clone 成功）
- 品質流水線 4 階段（Codex / Simplify / Security / Final Verify）通過
- 動工前計畫審查的 Critical / High 全部已 commit；Medium 已 documented 在 SPEC limitation 段

---

### Task 11b：Clone Modal 前端

**目標**：接 T11a 的三件套後端（`git_clone_start` / `git_clone_cancel` / `pick_clone_dest`）+ `clone:progress` / `clone:done` event，加 Clone modal UI + 進度條（含 phase 文案）+ cancel button + 整合 T13a 的 disabled Clone button。

> **動工前 SOP trail**：4 phase pre-impl review（多模型審查抓 9+ critical gap → plan v3 落地）。

**影響範圍**（T11a 已含 `pick_clone_dest` Rust 端 command，T11b 純前端 4 檔）：
- Create: `src/components/CloneRepo/CloneRepoModal.tsx`（純展示 + 表單 + a11y 三件套）
- Create: `src/hooks/useCloneFlow.ts`（state machine + early listener + buffer-by-clone_id replay + opening race guard + close-while-* state handling，集中所有 Tauri event lifecycle / clone_id ownership / 寬鬆 settle 邏輯）
- Modify: `src/components/RepoSidebar/RepoSidebar.tsx`（landing mode line 43-50 Clone button 移除 disabled + tooltip + 加 onClick 觸發 modal；panel mode Clone button 留 T13b）
- Modify: `src/lib/tauri.ts`（`pickCloneDest` / `cloneStart` / `cloneCancel` / `onCloneProgress` / `onCloneDone` 封裝 + INVALID_URL / INVALID_PATH / DEST_EXISTS / CLONE_IN_PROGRESS / INSUFFICIENT_DISK_SPACE error code → 文案 mapping）

**依賴**：T11a（含 kira-app PR #16 commit `65ab8e5` 的 `KiraError::InvalidUrl` fix，由 T11b pre-impl 多模型審查抓出）

**state 機（6 階段）**：
```
idle → starting → in-flight { clone_id, progress }
              ↘ (sync invoke reject) → done-err
       in-flight → cancelling { clone_id }
                ↘ (done Ok) → opening { path, repo_id } → close modal
       cancelling 收到任何 terminal done 都 settle (不只等 CANCELLED)
       opening 期間禁止 cancel/close override (race guard)
```

**驗收條件**：
- Given landing mode RepoSidebar Clone button → When 點擊 → Then 開啟 modal，URL 欄位 focus
- Given 點擊 dest picker → When 觸發 → Then 走 Rust 端 dialog command（非 webview）開啟原生資料夾選擇器；`isPickingDestRef` 期間 modal 內 ESC 不關 modal
- Given 貼上合法 HTTPS URL + 經 picker 選 dest → When 點 Clone → Then 先 attach listener（early listener）再 call `git_clone_start`，pre-clone_id 抵達的 terminal event 進 buffer，start resolve 後 replay；顯示 80/20 weighted 進度條（Receiving 0-75% / Resolving 75-80% / CheckingOut 80-100%）+ 「Connecting...」初始文案 + 三 phase 文案 + Cancel button
- Given `git_clone_start` invoke **sync reject** (INVALID_URL / INVALID_PATH / DEST_EXISTS / CLONE_IN_PROGRESS / INSUFFICIENT_DISK_SPACE) → Then state 直接進 done-err，不等 event
- Given `total <= 0`（libgit2 phase 切換或無 progress）→ Then 顯示 indeterminate bar，不顯示 stale 百分比
- Given `clone:done Ok` event → When 收到 → Then state 進 `opening`（**禁止 cancel/close override**），call `getRepoInfo(repo_id)` → funnel `applyOpenResult({ repo_id, info })` → close modal；若 `getRepoInfo` fail 退化成 done-err with hint=path
- Given `clone:done Err` event → When 收到 → Then modal 顯示 `code` 對應文案 + `message` + 次行 `hint`；`INVALID_PATH` 額外顯示「Path reservation expired, please re-pick destination」+ [Re-pick] button
- Given 點 Cancel → Then state 進 `cancelling`，call `git_clone_cancel(clone_id)`，遇 `INVALID_CLONE_ID` swallow（settled 已收到 done）；任何 terminal done（不只 CANCELLED）都 settle 顯示對應文案；modal 不關讓 user 看訊息
- Given 在 `starting` state 按 ESC/X → Then set `closeRequestedRef`，等 start promise 結算後立即 cancel
- Given 在 `in-flight` / `cancelling` state 按 ESC/X → Then trigger cancel + 顯示 cancelling state，等 done 才 unmount
- Given multi-AI 視角 / SOP 抓出的 9+ critical gap → 已全數落進 `useCloneFlow` hook

**測試設計**（9+ unit test）：
1. `test_cloneFlow_progressEventUpdatesBar`（各 phase 權重正確）
2. `test_cloneFlow_success_opensRepoAndClosesModal`（opening state 流經）
3. `test_cloneFlow_destPicker_callsRustCommand_isPickingDestRefGuardsEsc`
4. `test_cloneFlow_failure_showsErrorAndOptionalHint`
5. `test_cloneFlow_cancel_abortsTransfer_settlesOnAnyTerminalDone`
6. `test_cloneFlow_listenAttachedBeforeStartInvoke`（early listener）
7. `test_cloneFlow_doneArrivesBeforeStartResolve_bufferReplays`（early done race）
8. `test_cloneFlow_startSyncReject_movesToDoneErr`（5 種 sync error）
9. `test_cloneFlow_cancelReturnsInvalidCloneId_swallowsAndWaitsDone`
10. `test_cloneFlow_progressZeroOverZero_indeterminate`（libgit2 edge）
11. `test_cloneFlow_reopenModal_ignoresOldAsyncSettle`（cross-session ownership）
12. `test_cloneFlow_openingState_blocksCancelOverride`（race guard）

**Commit 邊界（8 個）**：
1. `feat(t11b): tauri.ts clone IPC wrapper + types + error mapping`
2. `feat(t11b): useCloneFlow hook skeleton + early listener + buffer-by-clone_id replay`
3. `feat(t11b): wire clone:progress + 80/20 weighted bar + 3 phase 文案 + indeterminate fallback`
4. `feat(t11b): wire clone:done Ok (opening state + getRepoInfo + funnel applyOpenResult) + Err display + hint`
5. `feat(t11b): cancel + cancelling 寬鬆 settle + INVALID_CLONE_ID swallow + close-while-* state machine`
6. `feat(t11b): CloneRepoModal UI + dest picker isPickingDestRef + a11y 三件套`
7. `feat(t11b): enable RepoSidebar landing Clone button + open modal + 5min lock UX (re-pick)`
8. `test(t11b): 9+ UI unit tests + final lint`

**安全 / 紀律考量**：
- dest picker 走 Rust 端 IPC，**不** import `@tauri-apps/plugin-dialog`（不把 dialog plugin 開給 webview）
- Modal a11y 三件套: overlay 用 `<button>`、focus trap、restore focus；`pickDest` 期間 `isPickingDestRef` 暫停 ESC handler
- 所有 mutable state 透過 `useRef` 不 `useState`（避 listener closure stale，Codex 與 Gemini 共識的 critical fix）
- Frontend transport state ownership key = `clone_id`（長時間的非同步狀態帶 owner key），buffer pre-clone_id terminal event 避 early done race
- Sync invoke reject 必走 try/catch 進 done-err，不靠 event 退場（Codex 與 Gemini 共識）
- IPC error 統一 wrap 在 `tauri.ts`，component / hook 不見 raw error

**Out of Scope**（v1 明寫不做）：
- 不做 clone retry / partial resume UI
- 不做 multi-concurrent clone（modal 一次一個）
- 不做 LFS / submodule progress
- 不做 i18n 文案 map（沿用 T9c push/pull inline 中文 pattern）
- panel mode Clone button 留 T13b（v1 唯一入口是 landing mode）
- 不做 dest 5min lifetime UI 倒數（過期 `INVALID_PATH` 後引導 re-pick）

**完成信號**：所有 9+ test pass + 品質流水線全綠 + dev smoke 4 情境過（公開 github / 私有 OAuth / cancel mid-clone / dest reuse 5min 內） + 動工前計畫審查的 Critical / High 全部已 commit

---

### Task 13b：整合 BranchList + Clone 進 RepoSidebar

**目標**：T10 BranchList 與 T11b Clone button 都 ship 後，整合進 T13a 的 sidebar placeholder。

**影響範圍**：
- Modify: `src/components/RepoSidebar/RepoSidebar.tsx`（BranchList placeholder 換成 T10 BranchList 元件）
- Modify: `src/components/RepoSidebar/GuideScreen.tsx`（已在 T11b 啟用 Clone button；本 task 確認整合無回歸）
- Modify: `src/App.tsx`（如需調整 sidebar 寬度 / layout）

**依賴**：T10 + T11b

**驗收條件**：
- Given 主畫面 RepoSidebar 開啟 → When 顯示 → Then 含 recent repos + BranchList（T10）兩區塊，layout 正確
- Given 在 sidebar 切 branch → When 點擊 → Then 整合 T10 checkout 流程，UI 整體 refresh
- Given GuideScreen 上 Clone button → When 點擊 → Then 開啟 T11b modal（無 disabled）
- Given dev smoke：開新 repo → clone repo → 切 branch → 切回 recent repo → Then 全程無 console error

**測試設計**：
- UI：`test_repoSidebar_integratesBranchList`
- UI：`test_guideScreen_cloneButtonEnabled_postT11`
- UI：`test_repoSidebar_endToEndDevSmoke`（整合測試）

**完成信號**：T13a / T10 / T11b 三者整合無回歸 + dev smoke pass（open / clone / branch switch / recent 切換）

---

### Task 12a：GitHub IPC 後端 + Patch Parser + DiffFilesView 抽取

**目標**：實作 `github_get_prs` / `github_get_pr_diff` 後端（review verify 確認 0 行）+ GitHub unified diff patch parser（轉成 `FileDiff` schema）+ 從現有 `DiffViewer` 抽出 presentational `DiffFilesView` 元件（解耦 commit oid，可同時供 commit diff / PR diff）。

**動機**：兩家 review 抓 critical gap——後端未實作、GitHub API 回 unified diff 文字非結構化 hunks、`DiffViewer.tsx:69` 耦合 commit oid 不可直接複用。

**影響範圍**：
- Modify: `docs/SPEC.md`（**已在 SPEC 補**：`github_get_prs` / `github_get_pr_diff` 改 `repo_id`-based + 加 `NOT_A_GITHUB_REPO` / `PATCH_PARSE_FAILED` / `RATE_LIMITED`）
- Create: `src-tauri/src/github/pr.rs`（fetch open PRs + fetch PR unified diff）
- Create: `src-tauri/src/github/patch_parser.rs`（unified diff 文字 → `FileDiff` 陣列；含 binary / too_large / truncated flags）
- Modify: `src-tauri/src/commands/github.rs`（2 個新 IPC，從 `repo_id` 反查 path 解析 origin 為 owner/repo）
- Modify: `src-tauri/src/lib.rs`（註冊 handler）
- Refactor: `src/components/DiffViewer/DiffViewer.tsx`（解 commit oid 耦合，抽出 presentational `DiffFilesView.tsx`）
- Create: `src/components/DiffViewer/DiffFilesView.tsx`（純展示 `FileDiff[]`，commit diff / PR diff 共用）
- Modify: `src/lib/tauri.ts`（getPRs / getPRDiff 封裝）

**依賴**：T13b（避免合併衝突）；T6 OAuth、T8 DiffViewer

**驗收條件**：
- Given 已 OAuth + repo origin 指向 github.com → When `github_get_prs` → Then 30 秒內回傳 PR 列表
- Given repo origin 非 github.com（GitLab / local）→ When `github_get_prs` → Then 回 `NOT_A_GITHUB_REPO`
- Given token 過期（401）→ When 呼叫 → Then 回 `NOT_AUTHENTICATED`（前端 silent logout）
- Given API rate limited（403 + `X-RateLimit-Remaining: 0`）→ When 呼叫 → Then 回 `RATE_LIMITED`，訊息含 `X-RateLimit-Reset` 時間
- Given 合法 PR number → When `github_get_pr_diff` → Then patch parser 解析 unified diff 為 `FileDiff[]`，含 binary / too_large flags
- Given patch parse 失敗 → When 呼叫 → Then 回 `PATCH_PARSE_FAILED`
- Given 既有 `DiffViewer` 顯示 commit diff → When refactor 後 → Then 行為不變（regression test 過）
- Given `DiffFilesView` 直接餵 `FileDiff[]` → Then 渲染與既有 commit diff 一致

**測試設計**：
- 正常：`test_github_get_prs_validGithubRepo_returnsList`
- 正常：`test_github_get_pr_diff_validPR_returnsParsedFileDiff`
- 正常：`test_patch_parser_validUnifiedDiff_returnsHunks`
- 邊界：`test_patch_parser_binaryDiff_setsBinaryFlag`
- 邊界：`test_patch_parser_truncatedDiff_setsTruncatedFlag`
- 邊界：`test_patch_parser_emptyDiff_returnsEmptyFiles`
- 邊界：`test_github_get_prs_nonGithubOrigin_returnsNotAGithubRepo`
- 錯誤：`test_github_get_prs_notAuthenticated_returnsError`
- 錯誤：`test_github_get_prs_rateLimited_returnsRateLimitedWithReset`
- 錯誤：`test_patch_parser_malformedDiff_returnsPatchParseFailed`
- 前端：`test_diffViewer_postRefactor_commitDiffRendersIdentically`
- 前端：`test_diffFilesView_acceptsFileDiffArray_rendersCorrectly`

**安全 / 紀律考量**：
- Token 從 keychain 讀（沿用 T6）
- Owner / repo 從 `repo_id` 反查 path 解析 origin，**不收前端傳的 owner 字串**（防越權，IPC capability 規則的延伸）
- PR diff 走 `git_get_diff` 的相同 cap 機制（複用 binary / too_large logic）

**完成信號**：所有 Rust + 前端測試通過 + tznthou/kira 自身 PR 列表可 fetch + PR diff 經 patch parser 渲染 + `DiffViewer` refactor regression-free + dev smoke 過

---

### Task 12b：PR List UI

**目標**：接 T12a 後端，加 PR list 元件 + review / CI badge + Tab 切換（Staging / PR）。

**影響範圍**：
- Create: `src/components/PRPanel/PRPanel.tsx`（PR list 容器 + 空狀態 + 未登入引導 + rate limit 訊息）
- Create: `src/components/PRPanel/PRItem.tsx`（單筆 PR + review state / CI state badge）
- Modify: `src/App.tsx`（右側區塊改 Tab：Staging / PR）
- Modify: `src/stores/authStore.ts`（補 token 過期 silent logout 邏輯，若 T6 未做）

**依賴**：T12a

**驗收條件**：
- Given 已 OAuth + GitHub origin → When 切到 PR Tab → Then 30 秒內列出 open PR
- Given 未登入 → When 切到 PR Tab → Then 顯示 Login prompt
- Given non-GitHub origin → Then 顯示「Kira 目前僅支援 GitHub PR」空狀態
- Given 列表為空 → Then 顯示「No open PRs」空狀態
- Given PR 有 review / CI state → Then badge 顏色對應（APPROVED 綠 / CHANGES_REQUESTED 紅 / PENDING 灰；CI success 綠 / failure 紅 / pending 黃）
- Given token 過期（401）→ When IPC 回 `NOT_AUTHENTICATED` → Then silent logout + 顯示 Login prompt（不彈錯誤 dialog）
- Given rate limit → When IPC 回 `RATE_LIMITED` → Then 顯示「Rate limited, retry after `<reset_time>`」

**測試設計**：
- UI：`test_prPanel_authenticatedGithubRepo_listsPRs`
- UI：`test_prPanel_emptyList_showsNoOpenPRs`
- UI：`test_prPanel_nonGithubOrigin_showsUnsupportedState`
- UI：`test_prPanel_notAuthenticated_showsLoginPrompt`
- UI：`test_prPanel_tokenExpired_silentLogoutAndPrompt`
- UI：`test_prPanel_rateLimited_showsRetryAfter`
- UI：`test_prItem_reviewAndCiBadges_correctColors`

**完成信號**：所有測試通過 + tznthou/kira PR 列表 dogfooding 可見 + dev smoke 過

---

### Task 12c：PR Diff UI

**目標**：點 PR 展開 PR diff，複用 T12a 抽出的 `DiffFilesView`。

**影響範圍**：
- Modify: `src/components/PRPanel/PRPanel.tsx`（選中 PR 觸發 fetch diff + 渲染）
- Modify: `src/components/PRPanel/PRItem.tsx`（expand state + 觸發 diff fetch）
- Modify: `src/lib/tauri.ts`（getPRDiff 已在 T12a；本 task 接 UI）

**依賴**：T12b

**驗收條件**：
- Given 點擊 PR → When 展開 → Then `DiffFilesView` 顯示 PR diff（複用 commit diff 同元件）
- Given PR diff binary 檔 → Then 顯示「Binary file changed」（同 commit diff 行為）
- Given PR diff too_large → Then 顯示「File too large to display」
- Given 切換 PR → When 點不同 PR → Then diff 重新 fetch + 渲染，無 stale 資料

**測試設計**：
- UI：`test_prPanel_clickPR_showsDiffInDiffFilesView`
- UI：`test_prPanel_binaryPRDiff_showsBinaryMessage`
- UI：`test_prPanel_tooLargePRDiff_showsTooLargeMessage`
- UI：`test_prPanel_switchPR_refreshesDiff`

**完成信號**：所有測試通過 + tznthou/kira 任一 open PR 點開可看 diff + dev smoke 過

---

### Task 9d：File-System Watcher（已完成）

**目標**：監聽 `.git` 目錄變更，外部 CLI 操作（commit / reset / pull）後自動重刷 UI。

**完成**：kira-app PR #24。selective `.git` watch（排除 objects）+ debounce 400ms + RAII Drop + event/focus 雙路徑。338 Rust + 133 JS tests。

---

### Task 14：功能穩固（已完成）

**目標**：T12c + T9d 合併後的安全 / 品質強化，確保 T15 視覺打磨前功能面穩定。

**完成**：kira-app PR #26（unstaged file cap + checkout dirty-check + console discipline）+ kira-app PR #27（branch stats refresh + watcher generation guard）+ kira-app PR #28（enrichment concurrency cap + centralized silent logout）。338 Rust + 140 JS tests。

**待做（獨立於 T15）**：
- [ ] **T14-1: viewport culling impl**（L）— 依 Chrome DevTools profile 結果定方案，SVG culling + React.memo。T15b Graph Craft 動工前確認狀態。

---

### Task 15：視覺收尾

**目標**：從「功能做完」推到「視覺做對」。Kira 的產品宗旨是「最美的 Git 觀看工具」，T15 是兌現這個承諾的最後一哩路。

**前置**：T14 全完成（kira-app PR #26-#28 merged）。T14-1 viewport culling 獨立進行但 T15b 動工前需確認狀態。

**紀律**：每軌動工前先在對話中確認 visual direction（不用畫 Figma，但需確認方向：skeleton vs spinner、badge 圓角 vs 方角等），避免做完再翻。

**執行順序與依賴**：

```
T15a (Rhythm) ──→ T15b (Graph Craft) ──→ T15d (Theme Parity) ──→ T15f (Motion)
       │                                          ↑                      ↑
       └──→ T15c (State Design core) ─────────────┘                      │
                      │                                                  │
                      └──→ T15e (State Design edge) ─────────────────────┘
```

Rhythm 定骨架 → Graph Craft 在骨架上做主角視覺 → State Design 統一狀態語言 → Theme Parity 雙 theme 校準 → Motion 最後加 subtle transitions。

---

#### Task 15a：Rhythm Pass（P0, M）

**目標**：定義全 app 的骨架尺寸——spacing / sizing / typography 統一，抽出共用 UI 元件消除重複。

**動工前 direction check**：row height 基準（32px? 36px?）、button size scale（sm/md/lg 還是 sm/md 就夠）、typography scale（text-xs / text-sm 的使用邊界）。

**具體工作**：
1. 共用 `Button` 元件——目前按鈕樣式在 15+ 元件重複（`px-3 py-1 rounded bg-surface-2 hover:bg-surface-3`），抽成 `<Button variant="primary|secondary|ghost" size="sm|md">`
2. Status badge 色彩修正——`FileItem.tsx`、`DiffFilesList.tsx` 用硬編碼 `bg-yellow-500 / bg-green-500 / bg-red-500`，改用 semantic token（`warning-bg / success-bg / danger-bg`）
3. Sidebar density——`RepoSidebar` panel mode section padding 統一、`BranchList` item 行高對齊
4. StagingArea row——`FileItem` 的 `py-1.5` 與其他 list row（PR、Branch）對齊，section header typography scale 統一
5. DiffViewer typography——line height / gutter 寬度 / hunk header sizing 審視
6. PushPullBar——按鈕 / status text 對齊 Button 元件

**影響範圍**：

| 檔案 | 動作 |
|------|------|
| `src/components/ui/Button.tsx` | create |
| `src/components/StagingArea/FileItem.tsx` | modify |
| `src/components/DiffViewer/DiffFilesList.tsx` | modify |
| `src/components/RepoSidebar/RepoSidebar.tsx` | modify |
| `src/components/BranchList/BranchList.tsx` | modify |
| `src/components/PushPullBar/PushPullBar.tsx` | modify |
| `src/components/PRPanel/PRItem.tsx` | modify |

**驗收條件**：
- 所有 list row 行高一致
- 所有按鈕用共用 Button 元件，零散 inline 按鈕樣式清除
- FileItem / DiffFilesList 零硬編碼 Tailwind 顏色值（全用 semantic token）
- 雙 theme 目視：badge 在 ink / paper 都清晰可辨

**完成信號**：`tsc --noEmit` + `eslint` + `cargo clippy` 通過 + 雙 theme 全流程目視確認

---

#### Task 15b：Graph Craft（P0, L）

**目標**：Commit Graph 是 Kira 的主角畫面，視覺精雕到「值得盯著看」。

**動工前 direction check**：
1. node shape 方向（merge 用雙圈 / 菱形 / 粗環？HEAD 用光暈 / 填色 / icon?）
2. label badge 風格（圓角 pill / 方角 tag / 帶 icon?）
3. edge curve 弧度偏好（緊湊 vs 寬鬆）

**前置確認**：T14-1 viewport culling 狀態。如果 culling 尚未實作，hover / glow 效果限定在可見 viewport 內的 node，不對隱藏 node 套用 DOM 操作。

**具體工作**：
1. Node shape 升級——merge commit 用雙圈或菱形、HEAD commit 加粗或光暈、regular commit 保持簡潔
2. Hover + Selected state——node 放大 / glow / ring、selected commit 持續高亮（目前無 selected 視覺）
3. Edge curve 精煉——cubic bezier control point 調整，分叉 / merge 弧線更平滑
4. Label badge 重設計——branch name / tag label 從純 SVG text 改成帶圓角背景的 badge，HEAD 與 remote 視覺區分
5. Subject 截斷——長 commit message 在 graph 行內的 truncation + ellipsis
6. **（optional）Collision avoidance**——多 label 擠在同一 commit 時的佈局策略。算法工作，其餘 5 項不依賴它，時間不夠優先砍。

**影響範圍**：

| 檔案 | 動作 |
|------|------|
| `src/components/CommitGraph/CommitNode.tsx` | modify |
| `src/components/CommitGraph/BranchLane.tsx` | modify |
| `src/components/CommitGraph/GraphCanvas.tsx` | modify |
| `src/components/CommitGraph/CommitTooltip.tsx` | modify |
| `src/lib/graphLayout.ts` | modify |

**驗收條件**：
- merge / HEAD / regular commit 視覺可區分
- hover + selected 有明確視覺回饋
- label badge 在多 branch 情境不互相遮擋（或 optional collision avoidance 完成）
- 10k commits repo 下 hover / select 無明顯卡頓（依賴 T14-1 culling）

**完成信號**：雙 theme 目視 + 大 repo smoke + `tsc --noEmit` + `eslint` 通過

---

#### Task 15c：State Design — Core（P1, M）

**目標**：loading / empty / error 三種日常路徑從純文字升級為刻意設計的視覺，統一全 app 狀態語言。

**動工前 direction check**：loading 用 skeleton shimmer / branded spinner / 文字 + pulse？empty state 用 illustration / icon + text / 純文字？error 用 inline banner / toast / modal？

**具體工作**：
1. 共用 Loading 元件（`Skeleton.tsx` 或 `Spinner.tsx`）——取代各處 "Loading..." 純文字
2. 共用 `EmptyState.tsx`——帶 icon slot + 訊息 + optional action button，取代分散的灰色文字
3. 共用 `ErrorBanner.tsx`——統一 error 視覺（inline banner with retry action），取代各處 `text-danger-fg` 文字
4. 套用到 GraphCanvas 首次載入 / refresh
5. 套用到 PRPanel（loading / empty / not-github / error）
6. 套用到 DiffViewer（idle / loading / error）
7. 套用到 StagingArea 空狀態

**影響範圍**：

| 檔案 | 動作 |
|------|------|
| `src/components/ui/Skeleton.tsx` 或 `Spinner.tsx` | create |
| `src/components/ui/EmptyState.tsx` | create |
| `src/components/ui/ErrorBanner.tsx` | create |
| `src/components/PRPanel/PRPanel.tsx` | modify |
| `src/components/DiffViewer/DiffViewer.tsx` | modify |
| `src/components/StagingArea/StagingArea.tsx` | modify |
| `src/App.tsx` | modify |

**驗收條件**：
- 每個 panel 的三態（loading / empty / error）有統一的視覺元件，不是各自寫的灰字
- Loading 元件有 accessible `role="status"` + `aria-busy`
- 雙 theme 下三態都好看

**完成信號**：全 panel 三態目視確認 + `tsc --noEmit` + `eslint` 通過

---

#### Task 15d：Theme Parity（P1, M）

**目標**：Dark（ink）+ Light（paper）都是一等公民，T15a/b/c 的視覺在兩邊都精確。

**具體工作**：
1. 並排 audit——逐 panel 截圖對比，找 ink / paper 之間的不對稱
2. Syntax highlight 平衡——`highlight.css` 的 ink / paper 色彩亮度 / 對比度校準
3. Graph edge / node 在 light theme 的可見度——OKLCH token `graph-edge` 在 paper theme 可能太淡
4. T15a/b/c 的新視覺在雙 theme 校準——Badge、Button、Loading、EmptyState 在兩邊都好看

**影響範圍**：

| 檔案 | 動作 |
|------|------|
| `src/index.css` | modify（ink + paper token 微調）|
| `src/styles/highlight.css` | modify |
| T15a/b/c 新增的 UI 元件 | modify（如需）|

**驗收條件**：
- 雙 theme 全流程目視：無刺眼 / 看不清 / 色彩斷裂
- Syntax highlight 在 ink 和 paper 都能舒服閱讀
- Graph 在 paper theme 下 edge / node / label 清晰可辨

**完成信號**：雙 theme 全流程目視通過

---

#### Task 15e：State Design — Edge（P2, S）

**目標**：次要狀態套用 T15c 的共用元件，統一視覺語言。

**具體工作**：
1. Unauth——「Sign in with GitHub」改用 `EmptyState` + GitHub icon
2. Rate-limited——加 countdown 或 retry 提示，用 `ErrorBanner` 變體
3. Truncated——StagingArea 截斷 banner 用統一 warning 風格
4. Conflicted——沿用 `ErrorBanner` warning pattern

**影響範圍**：各 Panel 元件 + T15c 的 UI 元件

**驗收條件**：所有次要狀態用統一視覺語言，不是各自為政的文字

**完成信號**：目視確認 + 雙 theme 通過

---

#### Task 15f：Motion（P2, S-M）

**目標**：加 subtle transitions，動畫是資訊不是裝飾——每個 transition 都傳遞狀態變化。

**動工前 direction check**：確認 motion 調性（克制 vs 活潑）。

**Framer Motion go/no-go**：CSS `transition` + `@keyframes` 能做就不引 Framer Motion。只在需要 `AnimatePresence`（exit animation）或 `staggerChildren` 時才引入。

**具體工作**：
1. Tab 切換——Staging ↔ PR 面板的 fade / slide transition（目前 instant `hidden` toggle）
2. Hover feedback——Button / list item 的 hover 加 subtle scale 或 background ease
3. Graph load——commit nodes 首次渲染的 stagger fade-in（可能觸發 Framer Motion go/no-go）
4. Refresh indicator——watcher 觸發 refresh 時的 subtle pulse

**影響範圍**：

| 檔案 | 動作 |
|------|------|
| `src/App.tsx` | modify（tab transition）|
| `src/components/CommitGraph/GraphCanvas.tsx` | modify（graph load）|
| `src/components/ui/Button.tsx` | modify（hover）|
| `src/index.css` | modify（transition utilities）|
| `package.json` | modify（如觸發 Framer Motion）|

**驗收條件**：
- Tab 切換有流暢 transition，不是瞬間跳轉
- Hover 有視覺回饋
- 動畫不影響操作速度（60fps）
- 雙 theme 下動畫都自然

**完成信號**：目視確認 + 效能無回歸 + `tsc --noEmit` + `eslint` 通過

**進度（2026-07-30，P0 完成、P1 未動工）**：

- **調性定案**：紙感克制 + 頻率分層——高頻互動（hover）100-120ms、低頻狀態變化 200-300ms、曲線一律 `ease-out`、刻意不用 scale（密集列表會晃）、只動 `opacity` 與 `transform`（走 GPU compositing，不觸發 layout / paint）。慣例已寫入 `CLAUDE.md` 技術約束
- **Framer Motion go/no-go 判定：no**。CSS `@keyframes` + `transition` 全覆蓋，未引入任何動畫依賴，因此 `package.json` 未改動、README 技術棧同步更正
- **已完成（具體工作 1 + 2）**：`src/index.css` 新增 `@keyframes kira-fade-in`；`src/App.tsx` 兩個 tab panel 進場 200ms fade + 3px 上移（只做進場——`hidden` 是 `display:none`，`display` 不可動畫，且離場不傳遞資訊）；`src/components/StagingArea/FileItem.tsx` 與 `src/components/PRPanel/PRItem.tsx` 的 row hover 100ms
- **與上方影響範圍表的落差**：`src/components/ui/Button.tsx` **實際未動**——它已有 `transition-colors`，只改 duration 屬純一致性追求，而它是全 app 共用 primitive、blast radius 最大，動工前的計畫審視已判定排除。表格漏列實際改動的 `FileItem.tsx` / `PRItem.tsx`
- **驗收條件達標**：tab 切換流暢 ✅／hover 有視覺回饋 ✅／60fps（大 repo react 下切 tab 無掉幀）✅／雙 theme（ink + paper）✅
- **未完成**：具體工作 3（graph load）方案調整為容器層一次性 fade、**不**逐節點 stagger（1000 節點 stagger 有 60fps 風險），尚未實作；具體工作 4（refresh pulse）降為 optional
- **結案（2026-10-04）**：具體工作 3 放棄——v8 設計基準沒有 graph 容器淡入，「載入完成」改由 HEAD 車站的首繪漣漪表達（Task 16）；具體工作 4 一併不做

#### Task 16：v8 雲母路線圖完整複刻（XL）

**目標**：app 與 v8 設計基準**完全一樣**——同 token 值、同 CSS 規則、同 DOM 結構、同字型堆疊、同幾何常數，一致靠構造保證，再以截圖比對驗證，不靠目測。

**硬約束**：不打包字體（顧慮 app 體積與授權）→ 設計基準本身改為系統字版本（SF Pro / SF Mono / 蘋方）；基準只畫 app 做得到的事——資料排序、diff 格式等一律以真實後端的輸出為準。

**完成條件**：
- **D1 像素比對**：系統 WKWebView 渲染（即 Tauri 在 macOS 的引擎），1400×900 與 1200×800、亮暗雙主題，每區（topbar / sidebar / graph / side pane / diff）**0 差異像素**；門檻依據是同一頁兩次獨立渲染的差異為 0，例外須事前列出並核可
- **D2 CSS 規則比對**：hover / focus / transition / reduced-motion 等截圖拍不到的狀態，規則逐字相同
- **D4** 互動清單全數成立（鍵盤導覽、tooltip 意圖延遲、commit 後提示、忙碌狀態等）
- **D5** 實機與設計基準同尺寸並排目視核可（允許 hash、時間等資料差異）
- **D6** 既有 gate 全綠

**分期**（每期一個 PR）：

| Phase | 內容 | 狀態 |
|-------|------|------|
| 0 | 設計基準改系統字、Overlay 標題列、motion 約束 | 完成 |
| 0b | 補設計基準未畫的狀態（逐區，在該區移植前完成） | 進行中（強調色跟隨所在路線 ✅、標題列殼層狀態 ✅、graph 狀態與走線規則 ✅、側欄 / 右欄 / diff 狀態 ✅；對話框、Clone、device code、首頁待補） |
| 1 | 比對工具：dev-only fidelity 入口、逐區像素比對、實機 fixture repo 與真後端輸出的語意比對 | 完成 |
| 2 | Graph 資料契約 + 路線語彙（分支歸屬、lane、顏色、字母） | 完成 |
| 3 | 基礎層：token、light/dark 主題、殼層、Overlay 標題列 | 完成（3a：v8 CSS 逐字同步、舊 token 別名、light/dark 主題、強調色；3b：殼層、站牌與失敗提示、Overlay 標題列） |
| 4 | Graph：HTML 列 + SVG 路線層、0/45/90° 走線 | 完成（4a 資料契約與純模組，kira-app PR #42；4b graph 本體，kira-app PR #46；效能量測與實機驗收 D5 於 2026-10-09 通過） |
| 5 | 側欄、右欄、diff（含跨行 highlight 修正、hunk 標頭函式名） | 完成（5a 側欄，kira-app PR #48；5b diff，kira-app PR #49；5c 右欄，kira-app PR #50；實機驗收 D5 於 2026-10-13 通過） |
| 6 | 其餘畫面（對話框、Clone、首頁）、實機驗證、收尾 | — |

**Phase 1 產出**：
- `fidelity.html` + `src/dev/fidelity/`：以 fixture 資料啟動真正的 App（mockIPC；dev-only，不在 vite build 輸入內）
- `src-tauri/src/git/fidelity_dump.rs`：在實機 fixture repo 上傾印真後端的 IPC 輸出（`#[ignore]`，需明確指定執行）
- 修正：`list_branches` 不再回傳 `origin/HEAD` 等符號參照，與 graph 的行為一致
- 結果：baseline 每區 100% 不同（移植起點）；手寫 fixture 與真後端在實機 repo 上的輸出語意全數吻合

**Phase 2 產出**（純邏輯，畫面零變化；graph 仍用 `graphLayout.ts`，Phase 4 切換）：
- 後端 `git_get_graph` 補欄位：`head`（與 commits 同一次快照；detached 時 `branch` 為 null）、`default_branch`（`<remote>/HEAD` 指向且仍存在的分支）、`BranchRef.upstream`（只回報 remote-tracking）、`BranchRef.name_on_remote`（依 fetch refspec 反推，tracking ref 的前綴不一定是 remote 名）
- `src/lib/routeMap.ts` 的 `computeRoutes()`：分支歸屬（推論，依優先序認領）、欄位（半列佔用範圍、主幹固定第 0 欄）、字母（詞首優先；先全視窗唯一，用完後只和重疊的線不同）、顏色（名稱 hash 偏好色 + 鄰線讓位，HEAD 的線永遠拿偏好色）、邊的型別
- B3（detached HEAD 時「你在這裡」消失）：資料面由 `head` 補上，畫面隨 Phase 4 生效
- 驗證：設計基準 23 列的 lane 全數一致；合成歷史共用一組不變式；規則變異 17 種全數被測試抓到；與另外獨立實作的規則原型在 4 個真實 repo（含 react 1000 筆）逐 commit 比對 0 不一致
- 設計基準依演算法回填：HEAD 分支字母 G → T，三條線換色（fix/toolbar-jump、feat/t15f-motion、feat/t15c-state-design）

**Phase 3 產出**（標題列換新；側欄、graph、右欄、diff 的內容仍是舊元件，坐在 v8 的 sheet 裡）：
- v8 CSS 與圖示：`src/styles/v8.css`（基準 `<style>`）與 `src/styles/v8-sprite.svg`（基準的圖示 sprite）都是逐字副本，由同步腳本產生、`--check` 驗；CSS 放 components 層，舊 `--color-*` token 以別名接到 v8 變數，各區移植後刪
- 主題 light / dark（新 key，舊 key 只讀遷移、首繪前套用）；強調色跟著所在路線（`html[data-line]`）
- 殼層：雲母地 + grid + 四張 sheet；首頁也坐在雲母地上
- 站牌：品牌、站名與 `~` 路徑、「你在這裡」（載入中與 unborn 不畫）、Pull / Push / Refresh、主題、帳號選單、Switch repo；各處的失敗訊息統一成一則佔站牌位置的提示，× 關掉或使用者下一個操作開始時清掉（背景 refresh 不清）
- 行為改變：沒東西可推時 Push 停用；沒有 upstream 時 Push 叫 Publish；upstream 狀態未知時 Push / Pull 都停用（原本當成沒 upstream 而帶 set_upstream）；upstream 有設定但追蹤 ref 被 prune 時兩顆照常可按、不覆蓋 upstream；commit 中工具列也停用；登出失敗看得到
- 後端：`AheadBehindInfo.tracking_ref_exists` 區分「已同步」與「upstream 解析不到」（兩者原本同為 0 / 0 / true）
- macOS Overlay 標題列：站牌即標題列（可拖、雙擊 zoom）；首頁與 Clone、分支、device code 三個對話框各加一條拖曳帶；全螢幕時站牌收回紅綠燈讓出的位置；非 macOS 首繪前就收回
- 驗證：topbar 區 17 個狀態 × 兩尺寸 × 亮暗 0 差異像素、fidelity 入口每個狀態零錯誤；其他四區仍是舊元件，不在本期要求內

**Phase 4 產出**（graph 換成 v8 路線圖；側欄、右欄、diff 仍是舊元件）：
- 4a 資料契約（kira-app PR #42）：unborn 的 HEAD 帶分支名（站牌寫「You are on (M) main · No commits yet」、工具列理由「No commits yet」）、unborn 的 HEAD 分支可當主幹（第一筆 commit 前後同色）、`RefPlacement.target`；commit 後重讀 repo 資訊
- 4a 純模組：`routeGeometry.ts`（照搬基準的走線規則 1–5 與繪製：0/45/90°、Z、反向 merge 走空隙、列界匯流、交叉處下層直段挖洞成橋、站型）、`rowRefs.ts`（排序、同一條線的 remote 只寫 origin、32 字截斷、40 字預算收進 +N、detached 的 HEAD pill、寄宿 ref、朗讀用的全名清單）
- 4b graph 本體（`components/Graph/`）：HTML 列 + SVG 路線層；截斷時線在最後一列下方淡出並接頁尾、HEAD 比視窗舊時頁尾多一行說你在哪、載入骨架、空 repo 的空狀態；點選、↑↓ Home End Enter Space、Esc 清除、roving tabindex（沒有選取時焦點那列留作 tab stop）；站牌（tooltip）300ms 意圖延遲；金箔外的漣漪只在 HEAD 換了時重播；開 repo 選 HEAD、commit 後選新的 HEAD；列的朗讀帶上該站全部 ref
- 行為改變：detached HEAD 有了標示（金箔 + HEAD pill）；截斷提示從警示橫幅改成頁尾；ref 不再撐寬整張 graph（截斷與收合）；舊 graph（`CommitGraph/`、`graphLayout` 等）與用不到的 `d3` 移除
- 驗證：graph 與站牌兩區 27 個狀態 × 兩尺寸 × 亮暗 0 差異像素、站牌（tooltip）4 格 0 差異；render 層四種改壞 D1 都抓得到；fidelity 入口每個狀態零錯誤

**Phase 5 產出**（側欄、diff、右欄換成 v8；對話框（含 device code）、Clone、首頁仍是舊元件）：
- 5a 側欄（kira-app PR #48）：近期清單、分支區、底部 Open / Clone 換成基準的 markup；分支清單本機在前、遠端在後，圓標照路線圖（自己的線、寄宿、視窗外的分支畫虛線圈），graph 的列與側欄共用圓標規則；目前分支的 ↑↓ 與工具列同源；pruned 用標籤說原因；忙碌時列保持原樣、用 title 說原因
- 5b diff（kira-app PR #49）：hunk 標頭帶函式名（git 與 PR 兩條路徑共用清理）；基準的上色器由同步腳本逐字搬進 app，依副檔名上色（JS / TS、Rust、JSON、CSS），JSX 的文案不上色，雙向控制字元與 LS / PS 換成看得見的標記，超過 2,000 字元的行不上色；收合的檔給 `git show` 指令；commit 的 diff 與 PR 展開共用檔案元件，`\ No newline at end of file` 畫成註記行
- 5c 右欄（kira-app PR #50）：Changes 與 Pull Requests 兩個分頁（←→ 換分頁）；Changes 有衝突區段、截斷條、骨架與讀不到的狀態，commit 後「Committed <7 碼>」顯示 2.4 秒；Pull Requests 有 via 圓標、狀態圖示、各種空 / 錯誤狀態，rate limit 寫出幾點可以再試，PR 太大時一條說明、不給 Retry；後端 RATE_LIMITED 帶 `reset_at`、401 只刪當次請求帶的 token、PR 檔案超過 GitHub 上限或 1 MB 回 `PR_DIFF_TOO_LARGE`
- 行為改變：stage、commit、分支操作的失敗統一走站牌提示（`repoStore.error` 移除），建立分支失敗留在對話框、保留輸入；status 與分支清單的讀取分使用者發起與背景兩種來源，使用者發起的讀取失敗才清掉清單、給一行錯誤 + Retry，背景讀取失敗留著舊清單；Commit 只被使用者發起的忙碌擋（watcher / focus 的背景 refresh 不擋）；換 repo 後才回來的結果不碰新 repo；detached HEAD 不再在分支清單畫虛擬列（站牌寫 Detached at）；按住方向鍵時大 diff 等放開再畫的門檻從 500 行降到 300 行；highlight.js 依賴與被取代的 diff、右欄舊元件移除
- 驗證：67 個狀態組合 × 兩尺寸 × 亮暗共 268 張，逐區（站牌 / 側欄 / graph / 右欄 / diff）比對 1,196 個區域 0 差異像素，整頁也 0 差異；fidelity 入口每個狀態零錯誤（每個狀態宣告預期的 IPC 錯誤，帳外的與沒用到的都算失敗）；上色器語料在 V8 與 WebKit 兩個引擎都跑；捲動用原生的滑鼠滾輪與觸控板事件驗；實機驗收 D5 於 2026-10-13 通過

**不做**：大 repo 的 graph 密度自適應（17+ lane；v8 graph 落地後重新量基準）、viewport culling、Windows / Linux 的像素一致

---


## 驗證計畫

### 冒煙測試清單（每次 release 前執行，< 5 分鐘）

- [ ] 開啟本地 repo，Graph 正確顯示
- [ ] Clone 一個公開 GitHub repo
- [ ] Stage 一個檔案並 commit
- [ ] Push 到遠端成功
- [ ] GitHub OAuth 登入
- [ ] PR 面板列出 open PR
- [ ] 點擊 commit 節點，Diff Viewer 開啟
- [ ] 重新開啟 App，recent repos 正確顯示

### 整合驗證情境

1. **完整工作流**：Open Repo → Stage → Commit → Push → 在 PR 面板確認 commit 出現
2. **大型 repo 壓力測試**：開啟幾萬 commits 的 repo — hard gate for no crash + UI responsive
3. **1M+ commits**（Linux kernel）：advisory — 跑看看記錄結果，不擋 ship
4. **雙 theme 全流程**：ink + paper 各跑一遍完整冒煙
5. **Console zero unexpected errors**
6. **跨平台驗證**：上述冒煙測試在 macOS / Windows / Ubuntu 各跑一次
