import { invoke } from "@tauri-apps/api/core";
import { homeDir as pathHomeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAuthStore } from "@/stores/authStore";

// Centralized IPC error interceptor for GitHub-related commands: AUTH_FAILED
// triggers authStore.reset() so the UI reflects logged-out state immediately —
// for the sign-in the request went out under only (authStore.session). One that
// comes back after you signed in again is about a token that is gone, and must
// not sign you out of the new one (Phase 5c).
function invokeWithAuthGuard<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const session = useAuthStore.getState().session;
  return invoke<T>(cmd, args).catch((err: unknown) => {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code: string }).code
        : "";
    if (code === "AUTH_FAILED" && useAuthStore.getState().session === session) {
      useAuthStore.getState().reset();
    }
    throw err;
  });
}

// --- 類型定義 ---

export interface Branch {
  name: string;
  oid: string;
  is_remote: boolean;
}

export interface RepoInfo {
  path: string;
  // null = unborn / detached HEAD / unresolvable shorthand (see docs/SPEC.md)
  head_branch: string | null;
  branches: Branch[];
  remotes: string[];
}

export interface RepoOpenResult {
  repo_id: string;
  info: RepoInfo;
}

export interface Author {
  name: string;
  email: string;
  timestamp: number;
}

export interface CommitNode {
  oid: string;
  full_oid: string;
  message: string;
  author: Author;
  parents: string[];
  refs: string[];
}

export interface BranchRef {
  name: string;
  target: string;
  is_remote: boolean;
  /** local 分支設定的 upstream，只回報 remote-tracking 分支（例 "origin/feat/x"）；
   *  upstream 是本機分支時為 null。 */
  upstream: string | null;
  /** remote-tracking 分支在遠端上的名字（例 "feat/x"），依 fetch refspec 反推 ——
   *  tracking ref 的前綴不一定是 remote 名。找不到 remote 或有歧義時為 null；local 分支為 null。 */
  name_on_remote: string | null;
}

export interface TagRef {
  name: string;
  target: string;
}

/** 與 commits 同一次快照的 HEAD。detached：branch=null、oid 有值；unborn（HEAD 指向還沒有 commit 的
 *  分支）：branch 有值、oid=null；HEAD 讀不到：兩者皆 null。 */
export interface HeadInfo {
  oid: string | null;
  branch: string | null;
}

export interface GraphData {
  commits: CommitNode[];
  branches: BranchRef[];
  tags: TagRef[];
  /** revwalk 在 limit (預設 1000) 處截斷時 backend set true，UI 必須顯示提示 —
   *  否則使用者會把這批當成完整歷史。 */
  truncated: boolean;
  head: HeadInfo;
  /** <remote>/HEAD 指向、而且還存在的分支在遠端上的名字；origin 優先。 */
  default_branch: string | null;
}

export type FileStatusType = "Modified" | "New" | "Deleted";

export interface FileStatus {
  path: string;
  status: FileStatusType;
}

// Mirrors src-tauri ConflictType. Derived from libgit2
// Index stage 1/2/3 entries; the UI uses it to switch between rendering a diff
// (BothModified / BothAdded) and rendering a deleted-marker (DeletedByUs /
// DeletedByThem). RenamedByBoth is reserved by SPEC but T10 v1 falls back to
// BothModified for that pattern.
export type ConflictType =
  | "BothModified"
  | "BothAdded"
  | "DeletedByUs"
  | "DeletedByThem"
  | "RenamedByBoth";

export interface ConflictedFile {
  path: string;
  conflict_type: ConflictType;
}

export interface WorkingTreeStatus {
  staged: FileStatus[];
  unstaged: FileStatus[];
  conflicted: ConflictedFile[];
  unstaged_truncated: boolean;
}

// --- T10 branch types (SPEC.md line 239-355) ---

export interface BranchUpstream {
  name: string;
  // false = .git/config records upstream but refs/remotes/.../X is missing
  // (typically pruned). UI shows "(pruned)" instead of suggesting set_upstream.
  tracking_ref_exists: boolean;
}

export interface BranchInfo {
  name: string;
  is_current: boolean;
  is_remote: boolean;
  upstream: BranchUpstream | null;
}

export interface ListBranchesResult {
  branches: BranchInfo[];
  // Some(hex) when HEAD is detached (at a raw OID, not a branch). The sidebar
  // draws no row for it; the sign reads a detached HEAD from git_get_graph's head.
  detached_head_oid: string | null;
}

export interface BranchStats {
  // null = no upstream / pruned ref / shallow clone object missing —
  // degraded per-branch, never fails the whole IPC.
  ahead: number | null;
  behind: number | null;
}

// Commit diff schema — 跟 working tree FileStatus 不同集合，故獨立命名
export type DiffFileStatusType = "Added" | "Modified" | "Deleted" | "Renamed";

export interface DiffLine {
  origin: string;
  content: string;
  old_lineno: number | null;
  new_lineno: number | null;
}

export interface DiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  /** 標頭 `@@ … @@` 後面那段（libgit2 往上找的函式名那一行），沒有是空字串；後端已清理、最多 80 字元 */
  context: string;
  lines: DiffLine[];
}

/** 超過顯示預算被收合：File = 這個檔自己超過單檔上限、Total = 前面的檔已經用掉總量。
 *  `lines` / `bytes` 是這個檔自己的大小（hunks 為空） */
export interface DiffOmitted {
  reason: "File" | "Total";
  lines: number;
  bytes: number;
}

export interface DiffFile {
  path: string;
  status: DiffFileStatusType;
  hunks: DiffHunk[];
  binary: boolean;
  too_large: boolean;
  omitted: DiffOmitted | null;
}

export interface DiffResult {
  files: DiffFile[];
  /** Files 超過 MAX_FILES_PER_DIFF (500) 時 backend 截斷並 set true，UI 應顯示提示 */
  truncated: boolean;
}

// --- IPC 封裝 ---

// Picker 在 Rust 端開（webview 拿不到任意 path）；用戶取消回 null。
export function pickAndOpenRepo(): Promise<RepoOpenResult | null> {
  return invoke<RepoOpenResult | null>("git_pick_and_open_repo");
}

// recent_repos.json schema：canonical path + unix seconds timestamp。
// disk source of truth + frontend mirror（不用 zustand persist），避免雙存儲不一致。
export interface RecentRepo {
  path: string;
  last_opened: number;
}

export function getRecentRepos(): Promise<RecentRepo[]> {
  return invoke<RecentRepo[]>("recent_repos_get");
}

// 點擊 recent repo 的安全入口：path 必須先在 backend 持有的 recent_repos.json
// 命中才走 open_repo_inner，否則回 NotARepo。等價於 Rust-side allowlist，避免
// webview 注入任意 path 拿 repo_id 做 stage/commit。
export function openRecentRepo(path: string): Promise<RepoOpenResult> {
  return invoke<RepoOpenResult>("git_open_recent_repo", { path });
}

export function getGraph(
  repoId: string,
  limit?: number
): Promise<GraphData> {
  return invoke<GraphData>("git_get_graph", {
    repo_id: repoId,
    limit: limit ?? null,
  });
}

export function getStatus(repoId: string): Promise<WorkingTreeStatus> {
  return invoke<WorkingTreeStatus>("git_get_status", { repo_id: repoId });
}

export function getDiff(repoId: string, oid: string): Promise<DiffResult> {
  return invoke<DiffResult>("git_get_diff", {
    repo_id: repoId,
    oid,
  });
}

/** getDiff 回 CANCELLED：這個請求排隊時被號碼較新的請求取代（後端的閘，見 SPEC `git_get_diff`） */
export function isSupersededDiff(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "CANCELLED";
}

export function stageFile(
  repoId: string,
  path: string
): Promise<{ success: boolean }> {
  return invoke<{ success: boolean }>("git_stage_file", {
    repo_id: repoId,
    path,
  });
}

export function unstageFile(
  repoId: string,
  path: string
): Promise<{ success: boolean }> {
  return invoke<{ success: boolean }>("git_unstage_file", {
    repo_id: repoId,
    path,
  });
}

export function stageAll(repoId: string): Promise<{ success: boolean }> {
  return invoke<{ success: boolean }>("git_stage_all", {
    repo_id: repoId,
  });
}

export function unstageAll(repoId: string): Promise<{ success: boolean }> {
  return invoke<{ success: boolean }>("git_unstage_all", {
    repo_id: repoId,
  });
}

export function commit(
  repoId: string,
  message: string
): Promise<{ oid: string }> {
  return invoke<{ oid: string }>("git_commit", {
    repo_id: repoId,
    message,
  });
}

// commit 失敗 → 站牌提示的文案（v8 0b P5 §3）：只有身分缺失有下一步，其他只寫結論（同殼層）。
// 元件層不解碼錯誤碼，集中在這裡（CLAUDE.md「錯誤處理統一在 src/lib/tauri.ts」）
export function commitNotice(err: unknown): { title: string; detail: string } {
  const code = (err as { code?: string } | null)?.code;
  return { title: "Commit failed.", detail: code === "GIT_IDENTITY_MISSING" ? "Set your git name and email." : "" };
}

export interface PushResult {
  success: boolean;
  // null: caller did not request set_upstream
  // true: upstream is now configured (was already, or just set)
  // false: caller requested set_upstream but the attempt failed (push itself succeeded)
  upstream_set: boolean | null;
}

export interface PullResult {
  commits_added: number;
}

export interface GitProgressEvent {
  repo_id: string;
  op: "push" | "pull";
  percent: number | null;
}

// T9d：repo 的 .git/ 被外部（terminal CLI / 其他工具）改動後，backend watcher debounce
// 合併連續變更後 emit 一次。前端依 repo_id filter 當前 active repo（對齊 GitProgressEvent）。
export interface ExternalChangeEvent {
  repo_id: string;
}

// Branch sync state vs. its upstream. has_upstream=false covers unborn HEAD,
// detached HEAD, and never-pushed branches — backend returns the no-upstream
// shape silently in all three cases (not an error).
export interface AheadBehindInfo {
  ahead: number;
  behind: number;
  has_upstream: boolean;
  // false with has_upstream=true = upstream configured but unresolvable (tracking
  // ref pruned / missing): ahead / behind are then unavailable, not 0 — do not
  // read it as in sync. Always false without an upstream.
  tracking_ref_exists: boolean;
  // Where the upstream lives (from .git/config, so known even when pruned): the
  // remote ("origin", or "." for a local branch) and the branch's name there. The
  // counts describe that branch, which is not necessarily where push / pull go
  // (the toolbar acts on its remote's same-name branch) — compare before trusting
  // them: tracking upstream/main and pushing to origin reads 0 / 0 even when
  // origin is behind. null without an upstream.
  upstream_remote: string | null;
  upstream_branch: string | null;
}

export function pushBranch(
  repoId: string,
  remote: string,
  branch: string,
  setUpstream: boolean
): Promise<PushResult> {
  return invokeWithAuthGuard<PushResult>("git_push", {
    repo_id: repoId,
    remote,
    branch,
    set_upstream: setUpstream,
  });
}

export function pullBranch(
  repoId: string,
  remote: string,
  branch: string
): Promise<PullResult> {
  return invokeWithAuthGuard<PullResult>("git_pull", {
    repo_id: repoId,
    remote,
    branch,
  });
}

// push / pull 失敗 → 站牌提示的文案（v8 0b §3）。verb 照按鈕上的字（沒有 upstream 時是 Publish）；
// 元件層不解碼錯誤碼（同 commitNotice）
export function transportErrorNotice(
  verb: "Push" | "Publish" | "Pull",
  err: unknown,
): { title: string; detail: string } {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case "AUTH_FAILED":
      return { title: `${verb} failed.`, detail: "Authentication required." };
    case "NETWORK_ERROR":
      return { title: `${verb} failed.`, detail: "Network error." };
    case "REJECTED":
      return { title: `${verb} rejected.`, detail: "Pull first." };
    case "CONFLICT":
      return { title: "Can't fast-forward.", detail: "Merge manually." };
    case "REPOSITORY_NOT_CLEAN":
      return { title: `${verb} failed.`, detail: "Commit your changes first." };
    case "INVALID_REMOTE":
      return { title: `${verb} failed.`, detail: "Remote not found." };
    case "INVALID_BRANCH_NAME":
      return { title: `${verb} failed.`, detail: "Branch name not allowed." };
    default:
      return { title: `${verb} failed.`, detail: "" };
  }
}

// Read-only — does not trigger fetch. Numbers reflect cached
// refs/remotes/{remote}/{branch} state (stale until next pull / fetch).
export function getAheadBehind(repoId: string): Promise<AheadBehindInfo> {
  return invoke<AheadBehindInfo>("git_get_ahead_behind", { repo_id: repoId });
}

// Re-read RepoInfo from disk; head_branch otherwise stays frozen at open-repo time.
export function getRepoInfo(repoId: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("git_get_repo_info", { repo_id: repoId });
}

// 站牌把家目錄底下的路徑縮成 `~/…`。查不到（非 Tauri 環境、IPC 失敗）回 null，路徑照完整顯示——
// 退回的樣子看得到，不另外記錯（render 整個 App 的測試走的就是這條）
export function homeDir(): Promise<string | null> {
  return pathHomeDir().catch(() => null);
}

// macOS 視窗全螢幕與否（紅綠燈消失時站牌收回留白）。Tauri 沒有全螢幕事件：開始時查一次，之後每次
// resize 重查 isFullscreen()——tao 離開全螢幕時先清旗標再送 resize，最後一次 resize 讀到的是新值。
// 多個查詢的回應先後未必照順序，只採用最後一次發出的。查不到（非 Tauri 環境、IPC 失敗）一律當
// 不是全螢幕。回傳取消監聽的函式。
export function watchFullscreen(onChange: (full: boolean) => void): () => void {
  let win: ReturnType<typeof getCurrentWindow>;
  try {
    // 沒有 window metadata（非 Tauri 環境）時會同步 throw，不是 reject
    win = getCurrentWindow();
  } catch {
    onChange(false);
    return () => {};
  }
  let disposed = false;
  let latest = 0;
  const check = () => {
    const mine = ++latest;
    const apply = (full: boolean) => {
      if (!disposed && mine === latest) onChange(full);
    };
    win.isFullscreen().then(apply, () => apply(false));
  };
  let unlisten: (() => void) | undefined;
  win
    .onResized(check)
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  check();
  return () => {
    disposed = true;
    unlisten?.();
  };
}

// --- T10 branch IPC ---

export function listBranches(repoId: string): Promise<ListBranchesResult> {
  return invoke<ListBranchesResult>("git_list_branches", { repo_id: repoId });
}

// Lazy companion: caller passes the visible branches (≤20 / batch) and gets
// per-branch ahead/behind. Missing key = name not found in repo. Returns
// Record<string, BranchStats>; map key encoded as JSON object by Tauri.
export function getBranchStats(
  repoId: string,
  branchNames: string[],
): Promise<Record<string, BranchStats>> {
  return invoke<Record<string, BranchStats>>("git_get_branch_stats", {
    repo_id: repoId,
    branch_names: branchNames,
  });
}

export function createBranch(
  repoId: string,
  name: string,
  baseOid: string | null,
): Promise<{ name: string }> {
  return invoke<{ name: string }>("git_create_branch", {
    repo_id: repoId,
    name,
    base_oid: baseOid,
  });
}

export function deleteBranch(
  repoId: string,
  name: string,
  force: boolean,
): Promise<{ success: boolean }> {
  return invoke<{ success: boolean }>("git_delete_branch", {
    repo_id: repoId,
    name,
    force,
  });
}

export function checkoutBranch(
  repoId: string,
  name: string,
  force: boolean,
): Promise<{ head_branch: string }> {
  return invoke<{ head_branch: string }>("git_checkout_branch", {
    repo_id: repoId,
    name,
    force,
  });
}

// --- T11a/T11b clone IPC ---

// `pick_clone_dest` 開 Rust 端 OS folder picker 並把 canonical dest 寫進
// backend PendingCloneDestLock (5 min lifetime, Layer 1 capability)。User
// 取消 picker → resolve null（不是 reject）。
export interface PickCloneDestResult {
  dest: string;
}

export function pickCloneDest(): Promise<PickCloneDestResult | null> {
  return invoke<PickCloneDestResult | null>("pick_clone_dest");
}

// `git_clone_start` 同步驗 url/dest/preflight + 註冊 CloneRegistry 後 spawn
// background clone task，立刻回 clone_id。後續透過 `clone:progress` /
// `clone:done` events 推送進度與終結狀態。
//
// Sync rejects (Promise 直接 reject)：
//   INVALID_URL / INVALID_PATH / DEST_EXISTS / CLONE_IN_PROGRESS
//   / INSUFFICIENT_DISK_SPACE — 這些不會發 clone:done，UI 必須 try/catch
//   invoke 把錯誤路徑接住（Codex/Gemini SOP finding #2，雙重 error 路徑）。
//
// Async settle (透過 clone:done event)：
//   AUTH_FAILED / NETWORK_ERROR / CANCELLED / CLONE_FAILED + 任何來自 clone
//   engine 的 KiraError → CloneDoneErr。
export interface CloneStartResult {
  clone_id: string;
}

export function cloneStart(
  url: string,
  dest: string,
): Promise<CloneStartResult> {
  return invoke<CloneStartResult>("git_clone_start", { url, dest });
}

// `git_clone_cancel` 設 cancel_requested。實際中止由 RemoteCallbacks /
// CheckoutBuilder::notify 觀察 cancel flag 才生效；DNS/TLS 階段 callback
// 尚未掛上，最壞情況等到第一個 progress phase 才 abort。
//
// `cancelled` 欄位：true = 本次 cancel 是「第一個」設 flag 的 caller，false
// = 已被先前 cancel 設過（idempotent）。INVALID_CLONE_ID 代表 clone 已 settle
// (registry 已移除)，frontend 應 swallow 此錯誤並等 done event（must 已收到
// 或即將收到，對齊 SPEC.md `git_clone_cancel` Note）。
export interface CloneCancelResult {
  cancelled: boolean;
}

export function cloneCancel(cloneId: string): Promise<CloneCancelResult> {
  return invoke<CloneCancelResult>("git_clone_cancel", { clone_id: cloneId });
}

// clone:progress event payload。對齊 commands/git.rs CloneProgressEvent。
// `ClonePhase` enum 用 Rust variant name 直接序列化（Serialize derive，無
// rename_all）→ PascalCase 字串。
export type ClonePhase = "Receiving" | "Resolving" | "CheckingOut";

export interface CloneProgressPayload {
  clone_id: string;
  phase: ClonePhase;
  current: number;
  total: number;
  // 累計 received bytes，只在 Receiving phase 有效，其他 phase 為 0
  bytes: number;
}

// clone:done event payload。Backend 用 #[serde(tag="kind", content="data",
// rename_all="PascalCase")] adjacent tagging + #[serde(flatten)] 把 result
// attach 到 outer event，所以 final JSON shape 是：
//   { clone_id, kind: "Ok",  data: { path, repo_id } }
//   { clone_id, kind: "Err", data: { code, message, hint } }
// SPEC.md line 178-183 已對齊。
export type CloneDoneOkData = { path: string; repo_id: string };

export type CloneDoneErrCode =
  | "INVALID_URL"
  | "INVALID_PATH"
  | "DEST_EXISTS"
  | "AUTH_FAILED"
  | "NETWORK_ERROR"
  | "INSUFFICIENT_DISK_SPACE"
  | "CANCELLED"
  | "CLONE_FAILED"
  | "CLONE_IN_PROGRESS";

export interface CloneDoneErrData {
  code: CloneDoneErrCode;
  message: string;
  // backend Option<&'static str> → serde 序列化 None=null（不省略），所以 UI
  // 對 hint 需 null check 而非 undefined check。
  hint: string | null;
}

export type CloneDonePayload =
  | { clone_id: string; kind: "Ok"; data: CloneDoneOkData }
  | { clone_id: string; kind: "Err"; data: CloneDoneErrData };

// Tauri event channel names — backend emits via app.emit(<name>, payload).
export const CLONE_PROGRESS_EVENT = "clone:progress";
export const CLONE_DONE_EVENT = "clone:done";

export interface CloneErrorUI {
  code: string;
  message: string;
  hint: string | null;
}

// Map IPC error (sync or async) to UI-friendly { code, message, hint } shape.
// Sync errors come from invoke().catch — KiraError serialize 只有 code/message
// 兩欄；我們在前端補對應 hint 文案，盡量跟 backend clone_done_err_from 對齊
// 同類錯誤的 hint，避免 user 在 sync vs async 路徑看到不同提示。
//
// 5min lock 過期專屬：INVALID_PATH 在 sync reject 階段最常見的觸發是 dest
// 從 PendingCloneDestLock expire（5 min lifetime），UI 該引導 re-pick 而非
// 怪罪 user。對應 plan v3 「5min lock 過期 UX」段。
export function mapCloneError(err: unknown): CloneErrorUI {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "CLONE_FAILED";
  const backendMessage =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message: unknown }).message)
      : "";

  switch (code) {
    case "INVALID_URL":
      return {
        code,
        message: "Invalid clone URL.",
        hint: "URL must be HTTPS without embedded credentials, query string, or fragment.",
      };
    case "INVALID_PATH":
      return {
        code,
        message: "Destination reservation expired.",
        hint: "Please pick the destination folder again (reservations last 5 min).",
      };
    case "DEST_EXISTS":
      return {
        code,
        message: "Destination is not empty.",
        hint: "Pick an empty directory or remove existing contents.",
      };
    case "CLONE_IN_PROGRESS":
      return {
        code,
        message: "Another clone is already in progress for this destination.",
        hint: "Wait for the existing clone to finish or cancel it before retrying.",
      };
    case "INSUFFICIENT_DISK_SPACE":
      return {
        code,
        message: "Insufficient disk space.",
        hint: "Free up disk space and try again.",
      };
    case "AUTH_FAILED":
      return {
        code,
        message: "Authentication required.",
        hint: "Private repos are GitHub-only in this version; sign in via GitHub OAuth.",
      };
    case "NETWORK_ERROR":
      return {
        code,
        message: "Network operation failed.",
        hint: "Check connectivity / firewall; the destination was cleaned up automatically.",
      };
    case "CANCELLED":
      return { code, message: "Clone cancelled.", hint: null };
    case "INVALID_CLONE_ID":
      // settled clone_id — caller should swallow this and wait for clone:done.
      return {
        code,
        message: "Clone already settled.",
        hint: null,
      };
    default:
      return {
        code: code || "CLONE_FAILED",
        message: backendMessage || "Clone failed.",
        hint: null,
      };
  }
}

// --- GitHub OAuth Device Flow ---

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

// 6 種 PollOutcome 對應後端 PollOutcome enum (#[serde(tag = "kind", rename_all = "snake_case")])
// Success 不帶 token：token 全程留在 Rust 端（store_token 後即丟棄），永不跨 IPC 邊界
// 防 renderer / DevTools / future XSS / 前端 logging 拿到 repo-scope OAuth token
export type PollOutcome =
  | { kind: "success" }
  | { kind: "authorization_pending" }
  | { kind: "slow_down"; new_interval: number }
  | { kind: "expired_token" }
  | { kind: "access_denied" }
  | { kind: "unexpected" };

export interface AuthStatus {
  authenticated: boolean;
  username: string | null;
}

export function githubStartDeviceFlow(): Promise<DeviceCodeResponse> {
  return invoke<DeviceCodeResponse>("github_start_device_flow");
}

export function githubPollToken(deviceCode: string): Promise<PollOutcome> {
  return invoke<PollOutcome>("github_poll_token", { device_code: deviceCode });
}

export function githubLogout(): Promise<void> {
  return invoke<void>("github_logout");
}

export function githubGetAuthStatus(): Promise<AuthStatus> {
  return invoke<AuthStatus>("github_get_auth_status");
}

export interface PullRequestInfo {
  number: number;
  title: string;
  state: string;
  author: string;
  created_at: string;
  updated_at: string;
  head_sha: string;
  html_url: string;
  draft: boolean;
  review_state: string | null;
  check_status: string | null;
}

export function githubGetPRs(
  repoId: string,
  state: "open" | "closed" | "all",
): Promise<PullRequestInfo[]> {
  return invokeWithAuthGuard<PullRequestInfo[]>("github_get_prs", {
    repo_id: repoId,
    state,
  });
}

export function githubGetPRDiff(
  repoId: string,
  prNumber: number,
): Promise<DiffResult> {
  return invokeWithAuthGuard<DiffResult>("github_get_pr_diff", {
    repo_id: repoId,
    pr_number: prNumber,
  });
}

// Webview <a target="_blank"> doesn't open the system browser in Tauri webview;
// route external URLs through plugin-opener. Capability `opener:allow-open-url`
// is scoped to the exact device-flow URL — calls outside that scope reject.
export function openExternalUrl(url: string): Promise<void> {
  return openUrl(url);
}
