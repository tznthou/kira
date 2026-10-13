# SPEC.md — Kira

> 系統契約文件。定義模組邊界、Tauri IPC 指令規格、資料模型。不涉及實作細節與測試設計。

---

## 系統架構（詳細）

```mermaid
graph TB
    subgraph Frontend["前端層 (React)"]
        CommitGraph["Graph<br/>路線圖（HTML 列 + SVG）"]
        DiffViewer["DiffViewer"]
        StagingArea["StagingArea"]
        PRPanel["PRPanel"]
        RepoSidebar["RepoSidebar"]
        Stores["Zustand Stores<br/>repoStore / graphStore / authStore"]
    end

    subgraph IPC["Tauri IPC Bridge"]
        Commands["Tauri Commands<br/>invoke()"]
    end

    subgraph Backend["後端層 (Rust)"]
        GitModule["git module<br/>graph.rs / diff.rs / stage.rs"]
        GitHubModule["github module<br/>auth.rs / pr.rs"]
        FSModule["fs module"]
        Git2["git2-rs<br/>(libgit2)"]
        Reqwest["reqwest<br/>(HTTP Client)"]
        Keychain["系統 Keychain<br/>keyring crate"]
    end

    CommitGraph --> Stores
    DiffViewer --> Stores
    StagingArea --> Stores
    PRPanel --> Stores
    RepoSidebar --> Stores
    Stores --> Commands
    Commands --> GitModule
    Commands --> GitHubModule
    Commands --> FSModule
    GitModule --> Git2
    GitHubModule --> Reqwest
    GitHubModule --> Keychain
```

---

## 模組職責

| 模組 | 層 | 職責 | 依賴 |
|------|---|------|------|
| `Graph` | Frontend | 路線圖：`routeMap` 推論分支歸屬、欄位、字母與顏色，`routeGeometry` 算走線與車站，`rowRefs` 排每站的 ref；畫成 HTML 列 + SVG 路線層，管選取、鍵盤與站牌（tooltip） | graphStore |
| `DiffViewer` | Frontend | 顯示 unified / side-by-side diff，語法高亮 | repoStore |
| `StagingArea` | Frontend | 列出 unstaged / staged 檔案，觸發 stage 操作 | repoStore |
| `PRPanel` | Frontend | 列出 GitHub PR，展開 PR diff | authStore, repoStore |
| `RepoSidebar` | Frontend | Repo 選取，branch 列表，recent repos | repoStore |
| `repoStore` | Frontend | 持有當前 repo 路徑、branch 列表、working tree 狀態 | Tauri IPC |
| `graphStore` | Frontend | 持有 commit graph 資料、選取的 commit、顏色映射 | Tauri IPC |
| `authStore` | Frontend | 持有 GitHub token 狀態、user info | Tauri IPC |
| `git module` | Backend | 所有 git 操作的 Rust 實作層 | git2-rs |
| `github module` | Backend | GitHub REST API 呼叫、OAuth PKCE 流程 | reqwest, keyring |
| `fs module` | Backend | 目錄掃描、recent repos 持久化 | std::fs |

---

## Tauri IPC 指令規格

### IPC Capability Model

所有 repo-scoped 指令採 **capability-based** 設計：唯一接受 path 的入口是 `git_open_repo`，它在 backend 註冊 canonicalized repo root 並回傳 `repo_id`（隨機 21-char URL-safe token）。後續所有指令僅接受 `repo_id`，backend 從受信任的 registry 反查 path，不再信任前端傳來的任意 path。

Clone 流程不收任意 path：`pick_clone_dest` 是唯一的 dest 寫入點（Rust 端 dialog），它把 picker 結果寫進 backend `pending_clone_dest_lock`（HashMap，5 min lifetime）；後續 `git_clone_start` 必須在該 lock 命中，否則 `INVALID_PATH`（Layer 1 capability，呼應 T13a 的 IPC capability 規則）。Clone 完成後 backend 內部 `open_repo_inner` 拿到 `repo_id`，透過 `clone:done` event payload 連同 path 一起回給前端。

未知 / 失效的 `repo_id` 一律回 `INVALID_REPO_ID`。

mutating 指令（`git_stage_file` / `git_unstage_file` / `git_commit` / `git_push` / `git_pull`）在 backend 取 per-repo write lock，避免並發 read-modify-write index 互相覆蓋。

### Webview CSP

上面的 capability 管的是「前端傳什麼進來」，不管「誰能叫」：Kira 沒有 app ACL（`build.rs` 沒設 `AppManifest`，`src-tauri/permissions/` 也不存在），tauri 2.11 對沒有 `plugin:` 前綴的指令就跳過 ACL 檢查（`webview/mod.rs` 的 `has_app_acl_manifest`），main frame 載入的頁面叫得到全部自訂指令，包含 `git_push` / `git_delete_branch`。之後若新增 `permissions/` 檔，app ACL 就會啟用，沒在 capability 授權的自訂指令全部被拒。

CSP 擋的是「注入的 markup 變成腳本」。repo 內容會進畫面（commit 訊息、ref 名、diff），其中 diff 的行、hunk 標頭與檔頭路徑以 innerHTML 插入（`FileDiff.tsx`），由上色器 `src/lib/v8-highlight.js`（設計基準的逐字副本）的 `highlight` / `escCode` 跳脫，雙向控制字元換成看得見的標記（Trojan Source）；`v8Highlight.test.ts` 驗 innerHTML 之後只有上色器自己的 span、文字一字不差。CSP 擋不住已經在執行的腳本：`connect-src` 不是 IPC 的閘門，custom protocol 被擋時 IPC 改走 postMessage（`scripts/ipc-protocol.js`）；CSP 也不管頂層導航，沒有 navigation handler 時 main frame 可以被導到任何頁面。這兩塊要靠 app ACL（只授權本地頁面）與導航守衛，另案處理。

`tauri.conf.json` 的 `app.security.csp`：

| 指令 | 值 | 原因 |
|---|---|---|
| `default-src` | `'self'` | |
| `script-src` | `'self'` | `index.html` 的首繪主題內嵌腳本由 Tauri 編譯時補 hash |
| `style-src` | `'self'` | 樣式只來自打包的 CSS |
| `style-src-attr` | `'unsafe-inline'` | 圖示 sprite 以 innerHTML 注入，帶 `style="position:absolute"`。不放在 `style-src`：`index.html` 一有 `<style>`，Tauri 就在 `style-src` 補 nonce，同一條指令裡的 `'unsafe-inline'` 隨之失效 |
| `img-src` | `'self' data:` | v8.css 的雲母斑點（`.flecks`）是 `data:` SVG 背景 |
| `connect-src` | `ipc: http://ipc.localhost` | Tauri IPC：macOS / Linux 是 `ipc://localhost`，Windows 是 `http://ipc.localhost`（`useHttpsScheme` 改成 true 時變 https，要一併加） |
| `object-src` / `base-uri` / `form-action` | `'none'` | 沒用到 |

**只有打包版套用**（Tauri 2.11 由送出內嵌資源的 `get_asset` 加上 CSP）：`tauri dev` 直接載 Vite 的 devUrl，CSP 不生效，dev、fidelity、D1 都看不到違規，`devCsp` 對這個流程也沒有作用。新增資源類型（外部圖片或字體、webview 端 fetch、`<style>` 元素（含執行期注入的）、worker、iframe）前先改 CSP，再用打包版驗：`mockup/tools/csp_check.sh`（`tauri build --debug --no-bundle --config` 疊加 report-uri，收 WebKit 的違規回報；附兩組必須收到回報的對照）。innerHTML 帶的 style 屬性已由 `style-src-attr` 放行。

驗證過的平台只有 macOS 27（tauri 2.11.0）。Windows / Linux 未實機驗證：WebKitGTK 是否套用 custom scheme 回應帶的 CSP header、WebKitGTK 與 WebView2 是否支援 `style-src-attr` 都未確認；不支援時退回 `style-src`，sprite 的 style 屬性會被擋（影響外觀，不影響安全）。

### Git 指令

#### `git_open_repo`
```
Input:  { path: String }
Output: RepoOpenResult {
          repo_id: String,
          info: RepoInfo {
            path: String,
            head_branch: Option<String>,   // null for unborn / detached HEAD
            branches: Vec<Branch>,
            remotes: Vec<String>
          }
        }
Error:  "NOT_A_REPO" | "PERMISSION_DENIED"
Note:   info.path 為 backend canonicalize 過的 worktree root（解 symlink）。
        bare repo 不支援，回 NOT_A_REPO。
        對同一 canonical path 多次呼叫回相同 repo_id。
        head_branch=null 涵蓋三種情境：unborn HEAD（剛 init 沒 commit）、
        detached HEAD（checkout 到 OID 不是 branch）、shorthand 不可解析。
        前端 fail closed：null 時站牌工具列（Toolbar）停用 Pull / Push，title 寫原因。
```

#### `pick_clone_dest` (T11a)
```
Input:  { }
Output: PickCloneDestResult {
          dest: String   // canonicalized 絕對路徑
        } | null         // user 取消 picker 時 null
Error:  "PERMISSION_DENIED" | "INVALID_PATH"
Note:   Rust 端 dialog command（capabilities/default.json 不暴露 dialog
        plugin 給 webview）。Pick
        成功後 backend 將 canonical dest 寫進 pending_clone_dest_lock
        HashMap<dest_canonical, Instant>（lifetime 5 min），作為
        git_clone_start 的 Layer 1 capability gate。同一 dest 重複 pick
        會 refresh timestamp。
        INVALID_PATH：picker 回傳的 path 非絕對 / 含 `~` / 含 NUL / 超過
        MAX_REPO_PATH_LEN (4096)。
```

#### `git_clone_start` (T11a)
```
Input:  { url: String, dest: String }
Output: CloneStartResult {
          clone_id: String   // 隨機 21-char URL-safe token，CloneRegistry 註冊
        }
Error:  "INVALID_URL" | "INVALID_PATH" | "DEST_EXISTS"
        | "INSUFFICIENT_DISK_SPACE"
Side:   非同步啟動 clone（#[tauri::command(async)] + tokio::spawn_blocking）。
        後續透過 clone:progress 與 clone:done event 帶 clone_id 推送狀態。
Note:   url 必須符合：HTTPS only / 不含 userinfo（`https://token@...` 直接
        reject，避免 token 落地 dest/.git/config 破 keyring-only 紀律）
        / 長度 ≤ 2048（HTTP URL practical
        limit）/ url::Url::parse 成功。
        dest 必須符合：絕對路徑（不接受 `~` / 相對 path）/ canonicalize
        後在 pending_clone_dest_lock 命中（5 min lifetime）/ 長度 ≤
        MAX_REPO_PATH_LEN (4096)。
        DEST_EXISTS 判定：libgit2 對非空 dir 回 ErrorCode::Exists，但 libgit2
        「非空」只忽略 `.` / `..`，不忽略 platform noise（`.DS_Store` /
        `desktop.ini` / `.localized` / `Thumbs.db`）。T11a 入口先做 preflight
        readdir + filter platform noise，effectively empty 時 rm noise files
        後進 clone，否則回 DEST_EXISTS。
        INSUFFICIENT_DISK_SPACE：classify_git_error 對 ErrorClass::Os + message
        含 "No space left" 分類，hint 提示 user 清磁碟。
        Cancel 與失敗時的 dest 狀態見 git_clone_cancel Note 與 clone:done。
```

#### `git_clone_cancel` (T11a)
```
Input:  { clone_id: String }
Output: { cancelled: bool }   // false = clone 已 settled（完成或失敗），idempotent
Error:  "INVALID_CLONE_ID"
Note:   設 CloneHandle.cancel_requested = true。RemoteCallbacks 內的
        transfer_progress / sideband_progress / update_tips 與 CheckoutBuilder
        ::notify 讀到 cancel_requested 時 return false / Err 中止 transfer，並
        set cancel_observed_in_callback = true（用於分類 CANCELLED 而非
        NETWORK_ERROR）。
        Cancel 不保證即時生效：DNS/TLS handshake 階段 callback 尚未掛上，
        最壞情況等到第一個 progress phase 才能中止。
        CANCELLED 分類紀律：cancel_observed_in_callback == true → CANCELLED；
        cancel_requested == true 但 callback 未實際因 cancel return（例如
        user 在 network error 後才點 cancel）→ NETWORK_ERROR（不是 CANCELLED）。
        ⚠️ libgit2 RepoBuilder::clone 在 non-zero error 後會自動執行
        git_repository_free + git_futils_rmdir_r(local_path) 清理 dest；
        rare 情況下（外部 process
        持有 file handle / Windows AV / external drive）dest 可能殘留，error
        hint 文案誠實標明「cleanup attempted; may need manual rm」。
```

#### Clone Events (T11a)
```
clone:progress payload {
  clone_id: String,
  phase: "Receiving" | "Resolving" | "CheckingOut",
  current: u32,
  total: u32,
  bytes: u64    // 累計 received bytes（Receiving 階段有效，其他為 0）
}

clone:done payload (adjacent-tagged + flatten, see CloneDoneEvent in commands/git.rs) {
  clone_id: String,
  kind: "Ok" | "Err",   // tag flattened into outer payload
  data:                  // adjacent content
    | { path: String, repo_id: String }                              // kind == "Ok"
    | { code: ErrorVariant, message: String, hint: String | null }   // kind == "Err"
}

ErrorVariant for clone:done kind=="Err":
  "INVALID_URL" | "INVALID_PATH" | "DEST_EXISTS" | "AUTH_FAILED"
  | "NETWORK_ERROR" | "INSUFFICIENT_DISK_SPACE" | "CANCELLED" | "CLONE_FAILED"
```

Phase 切換語意：
- `Receiving`：transfer_progress 第一階段，`current = stats.received_objects()`、`total = stats.total_objects()`、`bytes = stats.received_bytes()`
- `Resolving`：當 `stats.received_objects() == stats.total_objects()` 時切入，`current = stats.indexed_deltas()`、`total = stats.total_deltas()`、`bytes = 0`
- `CheckingOut`：libgit2 checkout 階段，由 `CheckoutBuilder::progress` callback emit，`current = completed_steps`、`total = total_steps`、`bytes = 0`

Throttle：phase 內 100ms emit gate（`Arc<Mutex<Instant>>`），避免小 packfile 一次 burst；phase 切換時強制 emit 一筆無視 throttle。libgit2 對小 packfile 不觸發 progress callback：unit test 用 `file://` local bare repo 驗 phase 切換序列，真實大 repo throttle 行為靠 dev smoke。

#### T11a v1 範圍限制

明列在 SPEC，BDD 與 UI 文案需對齊：

- **私有 repo 僅支援 GitHub HTTPS**。公開 HTTPS 任意 host 可 clone（credential callback 不觸發）；私有 non-github HTTPS 回 `AUTH_FAILED` with hint「私有 repo 僅支援 GitHub」（呼應 T5 push allowlist `is_github_https_url`，T14+ 視需求補 generic credential helper）。
- **scheme allowlist 僅 HTTPS**。`ssh://` / `git://` / `file://` IPC 入口 reject `INVALID_URL`（Cargo.toml git2 features = `["vendored-libgit2", "vendored-openssl", "https"]`，無 ssh feature）。`file://` 在 unit test 內部 helper fn 仍可使用（test 不過 IPC scheme validate）。
- **不支援 URL embedded credentials**。`https://token@...` / `https://user:pass@...` 一律 `INVALID_URL`。
- **不支援 self-signed certificate / private CA**。`certificate_check` callback 不掛，憑證錯誤一律走 `NETWORK_ERROR`。T14+ 視企業 user 需求加 per-host opt-in trust list。
- **dest 必須先經 `pick_clone_dest` 註冊**。webview 任意 path 不被信任（Layer 1 capability）；Layer 2 gap（同 webview 內 prompt-injected renderer 可在 5 min 內覆用 picker 註冊的 dest）documented limitation，等 T14+ capability model 統一重設計。
- **不支援的 git clone 選項**：LFS / submodule init / shallow（`--depth`）/ mirror / bare / template-dir / sparse checkout。T14+ 視 PRD 反饋逐項評估。
- **不支援 partial clone resume**。clone 失敗後 libgit2 自動 rmdir cleanup，rare 情況殘留時 error hint 提示 user 手動 rm 後重試（不提供 backend resume API）。

#### `git_get_graph`
```
Input:  { repo_id: String, limit: Option<u32> }
Output: GraphData {
          commits: Vec<CommitNode>,
          branches: Vec<BranchRef>,
          tags: Vec<TagRef>,
          truncated: bool,                 // revwalk 在 limit 處截斷（預設 1000、上限 10,000）
          head: HeadInfo,                  // 與 commits 同一次快照
          default_branch: Option<String>   // <remote>/HEAD 指向、而且還存在的分支在遠端上的名字；origin 優先
        }
CommitNode: {
  oid: String,       // 7-char short hash
  full_oid: String,  // full SHA
  message: String,   // first line
  author: Author { name, email, timestamp },
  parents: Vec<String>,
  refs: Vec<String>  // branch/tag names pointing here
}
BranchRef: {
  name: String,                    // local "feat/x"；remote "origin/feat/x"（libgit2 shorthand）
  target: String,                  // full SHA
  is_remote: bool,
  upstream: Option<String>,        // local 分支設定的 upstream，只回報 remote-tracking（"origin/feat/x"）；
                                   // 本機 upstream 為 None；tracking ref 被 prune 時仍回名字
  name_on_remote: Option<String>   // remote-tracking 分支在遠端上的名字（"feat/x"），依 fetch refspec 反推；
                                   // 找不到 remote 或有歧義時為 None
}
TagRef: { name: String, target: String }                   // annotated tag 已 peel 成 commit oid
HeadInfo: { oid: Option<String>, branch: Option<String> }  // detached：branch=None；unborn：branch=分支名、oid=None；讀不到：皆 None
Error:  "INVALID_REPO_ID" | "REPO_NOT_OPEN"
```
- 符號參照（如 `origin/HEAD`）不列入 `branches`。
- `branches` 是 libgit2 的列舉順序（loose refs 排序後接 packed refs 排序），**不是字母序**；需要排序的 UI 自行排序。
- tracking ref 的前綴不一定是 remote 名（自訂 fetch refspec 時 remote 叫 `origin`、ref 卻在 `refs/remotes/upstream/`），所以「在遠端上的名字」由後端依 refspec 算，前端不切字串。
- `default_branch`：`origin/HEAD` 指向已不存在的分支時（遠端預設分支改名後 prune 的常見結果）視同沒有，改看下一個 remote。

#### `git_get_diff`
```
Input:  { repo_id: String, oid: String }
Output: DiffResult {
          files: Vec<FileDiff>,
          truncated: bool      // 改動的檔超過 500 個，只列前 500 個
        }
FileDiff: {
  path: String,
  status: "Added" | "Modified" | "Deleted" | "Renamed",
  hunks: Vec<Hunk>,
  binary: bool,              // libgit2 BINARY flag；too_large 時為 false
  too_large: bool,           // 新舊任一側的 blob 超過 10MB
  omitted: Option<Omitted>   // 超過顯示預算被收合（見下）；null = 沒被收合
}
Omitted: {
  reason: "File" | "Total",  // File = 這個檔自己超過單檔上限；Total = 總量已被前面送出的檔用掉
  lines: usize,              // 這個檔自己的行數
  bytes: usize               // 這個檔自己的位元組數（每行內容 + 1），只給收合訊息顯示
}
Error:  "INVALID_REPO_ID" | "REPO_NOT_OPEN" | "COMMIT_NOT_FOUND"
        | "CANCELLED"        // 排隊中已被新的請求取代（見下）
Note:   binary / too_large / omitted 有值時 hunks=[]，前端在那個檔的位置顯示對應提示；
        有檔被收合時頂端另有橫幅，寫出收合的檔數與原因（可與 truncated 的橫幅同時出現）。
        實際對齊 src-tauri/src/git/diff.rs。
```
- **執行緒**：async command（`rename_all = "snake_case", async`），在 `spawn_blocking` 裡算，不佔主執行緒。請求一律經過 `DiffGate`（`state.rs`）：同時只算一個 diff；排隊中已被新請求取代的直接回 `CANCELLED`（前端本來就會丟掉過期的結果）；正在算的停不下來（libgit2 不能中斷），新的請求等它算完。「新」看的是領到號碼的先後：號碼在 task 第一次執行時才領，不保證等於前端送出的順序，幾乎同時送出的兩個請求可能反過來 → 目前的選取若回 `CANCELLED`，前端（`DiffViewer`）重送。每個較舊的請求只領一次號、最多這樣取代它一次，重送到它們都領過號就會成功；前端另設 5 次上限當保險（例如以後兩個地方同時抓 diff、互相取代）。算的途中 panic（只有 dev / 測試會發生，打包版是 `panic = "abort"`）回 `GIT_ERROR`，不回 `CANCELLED`，免得前端把同一個會壞的 diff 重送。
- **顯示預算**：單檔上限 2,000 行或 128K 字元，總量上限 5,000 行或 256K 字元（K = 1,024）。依 libgit2 列出的順序（依路徑）逐檔決定：
  - 超過單檔上限 → 收合，`reason = "File"`
  - 否則，加上去會超過總量 → 收合，`reason = "Total"`，然後**繼續看下一個檔**：後面放得下的小檔照送，所以收合的檔可能夾在送出的檔中間
  - 否則整檔送出、計入總量。送出的檔 hunk 一定完整，不會只送半個檔
- **計數**：行數 = 送出的 `DiffLine` 數（context、增、刪都算；git 路徑另有「\ No newline at end of file」標記，也算）；字元 = 每行去掉行尾換行後、實際送出的文字的字元數（Unicode code point）+ 1。不合法的 UTF-8 跟送出時一樣，每一段換成一個 U+FFFD、算一個字元（只數 UTF-8 開頭位元組的話，單獨的 0x80–0xBF 一個都不算，整行 0x80 就能繞過上限）。算字元不算 UTF-8 位元組：渲染成本跟著字元數走，算位元組的話中文會提早約三倍被收合。`github_get_pr_diff` 用同一套計數；同一份變更兩條路徑算出的行數與字元數相同，只差 PR 解析器略過「\ No newline」標記（每檔最多差兩行）。收合訊息的位元組數是各自看到的大小：不合法的 UTF-8 時，git 路徑是 repo 裡的原始大小，PR 路徑是解碼後的大小。
- binary / too_large 的檔沒有 hunk，不計入預算。
- 預算限制的是送出與渲染的量，不是後端的工作量。每個列出的檔仍要先算完 patch 才知道大小；10MB 與 500 檔這兩個上限也只管到 patch。rename / copy 偵測（`find_similar`）在 500 檔上限之前跑，比對相似度時把整個 blob 讀進來、不看 10MB（libgit2 1.8.1 `diff_tform.c` 的 `similarity_sig`；兩個檔大小相差超過 8 倍才跳過）。後端的 CPU 與記憶體目前沒有整體上限。

#### `git_stage_file`
```
Input:  { repo_id: String, path: String }
Output: { success: bool }
Error:  "INVALID_REPO_ID" | "FILE_NOT_FOUND" | "REPO_NOT_OPEN"
```

#### `git_unstage_file`
```
Input:  { repo_id: String, path: String }
Output: { success: bool }
Error:  "INVALID_REPO_ID" | "FILE_NOT_STAGED"
```

#### `git_commit`
```
Input:  { repo_id: String, message: String }
Output: { oid: String }
Error:  "INVALID_REPO_ID" | "NOTHING_TO_COMMIT" | "EMPTY_MESSAGE" | "REPOSITORY_NOT_CLEAN"
```

#### `git_push`
```
Input:  { repo_id: String, remote: String, branch: String }
Output: { success: bool }
Error:  "INVALID_REPO_ID" | "AUTH_FAILED" | "NETWORK_ERROR" | "REJECTED"
Side:   Tauri event 回傳進度
```

#### `git_pull`
```
Input:  { repo_id: String, remote: String, branch: String }
Output: { commits_added: u32 }
Error:  "INVALID_REPO_ID" | "CONFLICT" | "NETWORK_ERROR" | "AUTH_FAILED"
```

#### `git_get_status`
```
Input:  { repo_id: String }
Output: WorkingTreeStatus {
          staged: Vec<FileStatus>,
          unstaged: Vec<FileStatus>,
          conflicted: Vec<ConflictedFile>
        }
FileStatus:    { path: String, status: "Modified" | "New" | "Deleted" }
ConflictedFile: {
  path: String,
  conflict_type: "BothModified" | "DeletedByUs" | "DeletedByThem"
               | "BothAdded" | "RenamedByBoth"
}
Error:  "INVALID_REPO_ID"
Note:   conflicted 為 merge/rebase/cherry-pick 中的衝突檔案，由 libgit2
        Index stage 1/2/3 entries 推導 conflict_type。
        T10 v1 UI 顯示衝突列表 + 「需手動解決，目前 Kira 不支援衝突解決」
        引導使用者回 CLI（conflict surface 是 MVP 必備但 resolver 超出 MVP）。
        Modify/Delete conflict（DeletedByUs / DeletedByThem）UI 渲染與 BothModified
        不同：前者磁碟無檔不顯示 diff，後者顯示「N conflict markers」摘要。
```

#### `git_get_repo_info`
```
Input:  { repo_id: String }
Output: RepoInfo (見 git_open_repo)
Error:  "INVALID_REPO_ID" | "REPO_NOT_OPEN"
Note:   read-only, 不 mutating, 重新從 disk 讀 RepoInfo。
        前端 handleRefresh 呼叫，反映外部 CLI 切 branch 後的 fresh HEAD。
        沒這條路徑時 head_branch 會凍結在 open repo 那一刻，後續 push 會送
        stale branch 字串給 git_push（refspec 用 caller-supplied branch 組）。
```

#### `git_open_recent_repo` (T13a)
```
Input:  { path: String }
Output: RepoOpenResult (同 git_open_repo)
Error:  "NOT_A_REPO" | "PERMISSION_DENIED" | "INVALID_PATH"
Note:   點擊 recent repo 的安全 entry point。Path 必須先在後端 stored
        recent_repos.json 命中才走 open_repo_inner，否則 NotARepo。
        等價於 Rust-side allowlist：stored list 由 picker / 自身 open 成功
        後寫入，webview 無法直接寫，達成 path 隔離（防 prompt-injection
        後 webview 注入任意路徑取得 repo_id 做 stage/commit）。
        成功後 backend 內部 bump last_opened（add_canonical_in_dir）。

        ⚠️ 已知 attack model 缺漏 (T13a Codex review)：allowlist 對同
        個 webview 不是 secret——惡意 renderer 可 recent_repos_get →
        拿到 stored paths → git_open_recent_repo(path) 取得 repo_id →
        對 historical opened repos 做 stage/commit。攻擊 blast radius
        從「current open repo」擴大到「any historically opened repo」，
        但仍限於使用者本機曾 open 過的 repos，不擴大可被攻擊的 repo 集
        合至外部。完整解法需重新設計 IPC capability model（mutating cmd
        加 active-repo gate 而非只看 repo_id possession），列 deferred
        ticket 待 T14+ 或 token 模型重檢時統一處理。
```

#### `git_list_branches`
```
Input:  { repo_id: String }
Output: ListBranchesResult {
          branches: Vec<BranchInfo>,
          detached_head_oid: Option<String>  // Some when HEAD detached
        }
BranchInfo: {
  name: String,
  is_current: bool,
  is_remote: bool,
  upstream: Option<BranchUpstream>
}
BranchUpstream: {
  name: String,              // e.g. "origin/feature"
  tracking_ref_exists: bool  // false = config has upstream but refs/remotes/... pruned
}
Error:  "INVALID_REPO_ID" | "REPO_NOT_OPEN"
Note:   包含 local + tracking remote branch。HEAD detached 時 is_current 全 false，
        detached_head_oid 帶當前 OID。UI 不在清單畫虛擬列：站牌依 git_get_graph 的
        head 寫 "Detached at <hex>"。
        ahead/behind 不在本 IPC 計算（避免 100+ branch O(n) graph traversal 卡 UI），
        改由 git_get_branch_stats lazy 分批請求。
        upstream.tracking_ref_exists=false 表示 fork workflow 下 .git/config 仍記
        upstream 但 refs/remotes/... 被 prune，UI 顯示
        "(pruned)" 不誘導 set-upstream 覆寫。
        T10 v1：remote-tracking branch row 顯示但 read-only（無 checkout / delete），
        建立 local tracking branch 留 T14。
        RepoInfo.branches 維持 lightweight (只 name)。
```

#### `git_get_branch_stats`
```
Input:  { repo_id: String, branch_names: Vec<String> }
Output: HashMap<String, BranchStats> {
          // key = branch name; missing key = name not found in this call
          ahead:  Option<u32>,   // None = shallow / pruned upstream / graph compute failed
          behind: Option<u32>
        }
Error:  "INVALID_REPO_ID" | "REPO_NOT_OPEN"
Note:   lazy 分批：前端先 git_list_branches 渲染 list，再對 visible branches 非同步
        請求 stats（建議分批 ≤20 個 / 次）。某個 branch 算不出 ahead/behind（shallow
        clone object 缺失、upstream pruned）時該 entry 回 None/None 而非整個 IPC fail
        （degraded 策略）。
        read-only；不取 write_lock。
```

#### `git_create_branch`
```
Input:  { repo_id: String, name: String, base_oid: Option<String> }
Output: { name: String }
Error:  "INVALID_REPO_ID" | "INVALID_BRANCH_NAME" | "BRANCH_EXISTS"
        | "BRANCH_NAME_CONFLICT_CASE" | "BASE_NOT_FOUND" | "UNBORN_HEAD"
        | "REPOSITORY_NOT_CLEAN"
Note:   name 驗證走三層：
          1. IPC bounds：length cap (MAX_REFNAME_LEN=250) + NUL reject + 拒
             `refs/` prefix（使用者以為 full ref 但會建出 refs/heads/refs/heads/foo）
          2. libgit2 內建：Branch::name_is_valid() 套 git refname rules
             (拒 spaces / `~^:?*[\` / `..` / `@{` / `.lock` / reserved names
             HEAD/FETCH_HEAD/MERGE_HEAD/ORIG_HEAD)
          3. 跨平台 case scan：macOS / Windows 不分大小寫 filesystem 下
             lowercase(new_name) == lowercase(existing) 但字面不同 → BRANCH_NAME_CONFLICT_CASE
        base_oid=None：
          - HEAD unborn（剛 git init 沒 commit）→ UNBORN_HEAD，UI 引導「First commit required」
          - 否則用當前 HEAD commit
        base_oid=Some(hex)：find_commit(Oid::from_str(...))，不存在 → BASE_NOT_FOUND
        建立不切換 working tree。mutating，取 per-repo write_lock + state guard。
```

#### `git_checkout_branch`
```
Input:  { repo_id: String, name: String, force: bool }
Output: { head_branch: String }
Error:  "INVALID_REPO_ID" | "BRANCH_NOT_FOUND" | "DIRTY_TREE"
        | "REPOSITORY_NOT_CLEAN" | "CHECKOUT_CONFLICT"
Note:   force=false → backend 自己跑 status preflight（不依賴 libgit2 safe checkout
        允許 non-conflicting dirty 的行為，那會與 UI 文案「拒絕 fail closed」不符）。
        只要 git_get_status 回有 staged/unstaged tracked change → DIRTY_TREE。
        切換用 CheckoutBuilder::safe() + allow_conflicts(false)。
        force=true → CheckoutBuilder::force() + remove_untracked(false)（保 untracked
        檔案）+ overwrite_ignored(false)（保 ignored 檔，如 local .env / secrets）。
        仍會覆蓋 tracked dirty changes（破壞性，UI 二次確認
        文案：「will discard tracked changes (ignored files preserved). This cannot
        be undone.」）。
        rebase/merge/cherry-pick 進行中回 REPOSITORY_NOT_CLEAN（state guard）。
        T10 v1 不支援 stash flow（libgit2 沒有原子的 stash + checkout），UI 只
        Safe/Force/Cancel 三選項。
        Linked worktree 共享 refs 但 per-worktree HEAD/index，write_lock key 改用
        repo.commondir()；若 T10 內 scope 太大可降級成
        「不支援 linked worktree，文件 limitation」並列 deferred ticket。
        mutating，取 per-commondir write_lock + state guard。
```

#### `git_delete_branch`
```
Input:  { repo_id: String, name: String, force: bool }
Output: { success: bool }
Error:  "INVALID_REPO_ID" | "BRANCH_NOT_FOUND" | "CANNOT_DELETE_CURRENT"
        | "BRANCH_UNMERGED" | "REPOSITORY_NOT_CLEAN"
Note:   current branch 用 Branch::is_head() 前置判（不靠 libgit2 generic error）
        → CANNOT_DELETE_CURRENT 友善訊息。
        force=false → backend 自己跑 merged policy（不能直接接 libgit2
        Branch::delete()，它只刪 ref 不做 merged check）：
          1. 取 branch tip commit
          2. 若有 upstream config 用 upstream tip；否則用 current HEAD
             （配 pull 的 transactional ordering 與 branch_upstream_name() 紀律）
          3. repo.graph_descendant_of(target_tip, branch_tip) 判 branch 是否已 merge
          4. 未 merge → BRANCH_UNMERGED；merged → Branch::delete()
        force=true → 跳過 merged check 直接 delete。UI 二次確認文案含
        「commits may be recoverable via `git reflog` or `git fsck --lost-found`」
        （不可保證：branch delete 連 branch reflog 一起刪）。
        Linked worktree write_lock key 用 repo.commondir()。
        mutating，取 per-commondir write_lock + state guard。
```

---

### 檔案系統指令 (T13a)

#### `recent_repos_get`
```
Input:  {}
Output: Vec<RecentRepo> { path: String, last_opened: i64 }
Error:  (none — fail closed: 任何 IO / parse 失敗回空 Vec 並 log warning)
Note:   讀 app_local_data_dir/recent_repos.json + stale prune (NotFound only)。
        sync attribute (非 async)：純 std::fs 讀 <1KB JSON，sub-ms I/O 不阻塞
        Tauri runtime thread。
        前端 mirror not source: disk 是 source of truth，refresh() 永遠以 IPC
        回傳為準（不用 zustand persist 雙存儲）。
```

> **未 IPC 暴露**：`recent_repos_add` / `recent_repos_remove` 不公開為 IPC。
> add 由 backend `pick_and_open_repo_inner` / `open_recent_repo_inner` 成功後
> 內部寫入（路徑保證已過 canonicalize，且為 picker / stored-list 來源）；
> remove 邏輯下沉到 `recent_repos_get` 讀時 prune（NotFound 自動 drop）。
> 開放這兩個 IPC 等於提供 webview 任意 path 注入 recent JSON 的接受面，違反
> IPC capability 紀律。

### GitHub 指令

#### `github_start_oauth`
```
Input:  {}
Output: { url: String }  // 開啟瀏覽器的 OAuth URL
Side:   啟動本地 callback server（port 隨機分配）
```

#### `github_oauth_callback`
```
Input:  {}  // 等待 callback 完成（由 Tauri event 通知）
Output: { token: String, user: GitHubUser }
Side:   token 寫入系統 keychain
Error:  "OAUTH_TIMEOUT" | "OAUTH_DENIED"
```

#### `github_get_prs`
```
Input:  { repo_id: String, state: "open" | "closed" | "all" }
Output: Vec<PullRequest> {
          number, title, state,
          author: String,
          review_state: "APPROVED" | "CHANGES_REQUESTED" | "PENDING",
          ci_state: "success" | "failure" | "pending" | null,
          created_at: String
        }
Error:  "INVALID_REPO_ID" | "AUTH_FAILED" | "NOT_A_GITHUB_REPO" | "PR_NOT_FOUND"
        | "RATE_LIMITED" | "NETWORK_ERROR" | "KEYRING_ERROR"
Note:   owner/repo 從 repo_id registry 反查 path，再從 origin remote URL 解析；
        前端不收 owner 字串避免越權查他人 repo。
        origin 不指向 github.com 回 NOT_A_GITHUB_REPO；GitHub 回 404（repo 不存在或沒權限）是 PR_NOT_FOUND。
        AUTH_FAILED：keychain 沒有 token，或 GitHub 回 401。401 只在 keychain 存的仍是這個請求帶的
        那一把時才刪（請求在外面時重新登入，新的 token 留著；比對與刪除在同一把鎖裡）。
        github_get_pr_diff、github_get_auth_status 同一條。前端同理：請求帶著出發時的登入代號
        （authStore.session，登入狀態每換一次加一），AUTH_FAILED 回來時代號沒變才重設登入狀態
        （src/lib/tauri.ts invokeWithAuthGuard）。
        RATE_LIMITED 多送 reset_at（X-RateLimit-Reset 的 unix 秒，GitHub 沒給就是 null），
        右欄寫成「Try again after HH:MM」；message 照舊（序列化當下算的相對時間）。
```

#### `github_get_pr_diff`
```
Input:  { repo_id: String, pr_number: u32 }
Output: DiffResult  // 同 git_get_diff 格式（含 truncated / binary / omitted）；too_large 一律 false
Error:  "INVALID_REPO_ID" | "AUTH_FAILED" | "NOT_A_GITHUB_REPO" | "PR_NOT_FOUND"
        | "PR_DIFF_TOO_LARGE" | "PATCH_PARSE_FAILED" | "RATE_LIMITED" | "NETWORK_ERROR" | "KEYRING_ERROR"
Note:   GitHub API 回傳 unified diff 文字（非結構化 hunks），後端 patch parser
        轉成 FileDiff 陣列以複用 DiffFilesView 元件（T12a 抽出）。
        文字整份收下（下載與解析各有 1MB 上限，超過回 PR_DIFF_TOO_LARGE）後，
        逐檔套用與 git_get_diff 相同的顯示預算與計數；超過 500 個檔時 truncated = true。
        GitHub 對超過 300 個檔、或超過它自己算的 20,000 行（不是 additions + deletions）的 diff
        回 406 too_large，同樣是 PR_DIFF_TOO_LARGE（再試也拿不到：右欄一條說明、不給 Retry）；
        所以 500 檔的截斷在這條路徑走不到（2026-10-12 實測）。其他 406 是 NETWORK_ERROR。
        owner/repo 從 repo_id registry 反查解析，與 github_get_prs 同路徑。
```

---

## 資料模型

### GraphData（記憶體，不持久化）

Graph 資料在每次開啟 repo 或操作後重新從 git2-rs 計算，不存入資料庫。

### RecentRepos（持久化）

```json
// 存放位置：app_local_data_dir/recent_repos.json (T13a 起)
// 注意：local 非 roaming——Windows app_data_dir 走 Roaming AppData，
// domain-joined 機器會把 machine-local repo path sync 到別台變 dead path。
[
  { "path": "/Users/you/projects/kira", "last_opened": 1715731200 }
]
```

- 路徑：canonical path (post `std::fs::canonicalize`，解 symlink)。
- `last_opened`：unix epoch seconds (i64)。
- 最多保留 10 筆，最新 open 在頂端 (LRU)。
- Atomic write：`tempfile::NamedTempFile::new_in(app_local_data_dir)` + `persist`（同 directory rename，無 EXDEV）。
- Stale prune at load：`NotFound` drop；`PermissionDenied / Other` 保留（避免外接碟暫時不可達被當永久刪除）。
- 安全紀律：`recent_repos_add` 不公開為 IPC——僅 backend 在 `pick_and_open_repo_inner` / `open_recent_repo_inner` 成功後內部寫入。webview 不能餵 raw path 繞過 picker 路徑隔離。

### 分支顏色（前端計算，不持久化）

- 路線圖（`src/lib/routeMap.ts`）的顏色跟著分支走。主幹是墨；其他線的偏好色由分支名 hash 決定（同名永遠同偏好），撞到相鄰的線就依序讓位，HEAD 的線最先處理、永遠拿到偏好色。同一個 repo 狀態一定得到同樣的顏色，不存任何指派狀態。完整規則寫在該檔檔頭。

---

## 錯誤處理標準

所有 Tauri 指令的錯誤以 `Result<T, KiraError>` 回傳。

```rust
// Rust 側錯誤格式
pub enum KiraError {
    NotARepo,
    PermissionDenied,
    CommitNotFound(String),
    NetworkError(String),
    AuthFailed,
    // ...
}
```

前端接收格式：

```typescript
// 前端錯誤格式（invoke 拋出）
{
  code: "NOT_A_REPO" | "AUTH_FAILED" | ...,
  message: string,  // 使用者可讀的說明
  reset_at?: number | null  // 只有 RATE_LIMITED 有：重置時刻（unix 秒），不知道是 null
}
```

前端統一在 `src/lib/tauri.ts` 的包裝函式處理錯誤，不在各元件散落 try/catch。

---

## Branch 顏色 Palette

> **狀態**：v8 路線圖（Task 16 Phase 4 起；T9b1 的 5 lane 循環色已隨舊 graph 移除）。

路線色共 6 個：主幹 `--l-trunk`（墨），其他線五色 `--l-rokusho`（緑青）、`--l-gunjo`（群青）、`--l-shinsha`（辰砂）、`--l-murasaki`（紫）、`--l-odo`（黄土）。OKLCH 值寫在 `src/styles/v8.css`（設計基準的逐字副本，light 在 `:root`、dark 在 `:root[data-theme="dark"]`），不在 app 端改。哪條線用哪個色由 `routeMap.ts` 的 `LineColor` 指派（規則見上方「分支顏色」）；元件一律寫 `var(--l-<色>)`，不寫死數值。
