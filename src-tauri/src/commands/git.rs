use crate::error::{KiraError, Result};
use crate::fs::watcher::RepoWatcher;
use crate::git::branch::{self, BranchStats, ListBranchesResult};
use crate::git::clone::{clone_repo, ClonePhase};
use crate::git::clone_registry::{CloneHandle, CloneRegistry};
use crate::git::diff::{self, DiffResult, WorkingTreeStatus};
use crate::git::graph::{self, GraphData};
use crate::git::remote;
use crate::git::stage::{self, CommitResult, StageResult};
use crate::state::{ActiveWatcher, DiffGate, PendingCloneDestLock, RepoEntry, RepoRegistry};
use git2::{BranchType, Repository, RepositoryState};
use serde::Serialize;
use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use url::Url;

const PROGRESS_THROTTLE_MS: u64 = 100;
const PROGRESS_EVENT: &str = "git-progress";
const CLONE_PROGRESS_EVENT: &str = "clone:progress";
const CLONE_DONE_EVENT: &str = "clone:done";
const MAX_CLONE_URL_LEN: usize = 2048;

fn open_repo<P: AsRef<Path>>(path: P) -> Result<Repository> {
    Repository::open(path).map_err(|e| {
        use git2::{ErrorClass, ErrorCode};
        match e.code() {
            ErrorCode::NotFound => KiraError::NotARepo,
            _ if e.class() == ErrorClass::Os => KiraError::PermissionDenied,
            _ => KiraError::NotARepo,
        }
    })
}

#[derive(Debug, Serialize)]
pub struct Branch {
    pub name: String,
    pub oid: String,
    pub is_remote: bool,
}

#[derive(Debug, Serialize)]
pub struct RepoInfo {
    pub path: String,
    pub head_branch: Option<String>,
    pub branches: Vec<Branch>,
    pub remotes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RepoOpenResult {
    pub repo_id: String,
    pub info: RepoInfo,
}

fn build_repo_info(repo: &Repository, canonical_path: String) -> Result<RepoInfo> {
    // is_branch() guard: detached HEAD 的 shorthand() 會回 pseudo "HEAD" 字串，當
    // branch 送進 git_push 會組出錯 refspec。對齊 remote::ahead_behind() 的紀律。
    let head_branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(String::from));

    let branches = repo
        .branches(None)?
        .filter_map(|b| b.ok())
        .filter_map(|(branch, btype)| {
            let name = branch.name().ok().flatten()?.to_string();
            let oid = branch
                .get()
                .target()
                .map(|o| o.to_string())
                .unwrap_or_default();
            Some(Branch {
                name,
                oid,
                is_remote: matches!(btype, BranchType::Remote),
            })
        })
        .collect();

    let remotes = repo
        .remotes()?
        .iter()
        .filter_map(|s| s.map(String::from))
        .collect();

    Ok(RepoInfo {
        path: canonical_path,
        head_branch,
        branches,
        remotes,
    })
}

const MAX_REPO_PATH_LEN: usize = 4096;

fn open_repo_inner(registry: &RepoRegistry, path: &str) -> Result<RepoOpenResult> {
    if path.is_empty() || path.len() > MAX_REPO_PATH_LEN || path.contains('\0') {
        return Err(KiraError::InvalidPath);
    }
    let repo = open_repo(path)?;
    let workdir = repo.workdir().ok_or(KiraError::NotARepo)?;
    let canonical_root = std::fs::canonicalize(workdir).map_err(|_| KiraError::NotARepo)?;
    let info = build_repo_info(&repo, canonical_root.to_string_lossy().into_owned())?;
    let repo_id = registry.register(canonical_root);
    Ok(RepoOpenResult { repo_id, info })
}

/// T9d：open 成功後啟動該 repo 的 active watcher，replace 掉前一個 active repo 的 watcher
/// （舊的自動 cleanup）。失敗時 graceful degrade — log 後不啟用、不阻擋 open，前端
/// window-focus 補刷仍可兜底。`workdir` 取自 `RepoOpenResult.info.path`（canonical
/// workdir），watcher 內部再用 git2 解析真實 gitdir。
///
fn start_active_watcher(
    app: &AppHandle,
    active: &ActiveWatcher,
    watcher_gen: u64,
    repo_id: &str,
    workdir: &str,
) {
    match RepoWatcher::start(app.clone(), repo_id.to_string(), Path::new(workdir)) {
        Ok(w) => active.set_if_current(Some(w), watcher_gen),
        Err(e) => {
            let msg = format!("watcher start failed: {e}").replace(['\n', '\r'], " ");
            eprintln!("[kira] {msg}");
            active.set_if_current(None, watcher_gen);
        }
    }
}

/// Picker 在 Rust 端開（webview 拿不到任意 path），從 OS 拿 folder → register。
/// 用戶取消 dialog 回 `Ok(None)`；選了非 git 目錄走 `open_repo_inner` 回 `NotARepo`。
/// 成功 register 後 backend 內部寫 recent_repos（不公開 add IPC，避免 webview
/// 繞過 picker 注入任意 path）。
fn pick_and_open_repo_inner(
    app: &AppHandle,
    registry: &RepoRegistry,
) -> Result<Option<RepoOpenResult>> {
    let Some(file_path) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|_| KiraError::InvalidPath)?;
    let path_str = path.to_str().ok_or(KiraError::InvalidPath)?;
    let result = open_repo_inner(registry, path_str)?;
    crate::fs::recent_repos::add_canonical(app, Path::new(&result.info.path));
    Ok(Some(result))
}

/// 點擊 recent repo 的安全入口：selector (path) 必須先在 stored recent JSON
/// 命中才放行，等價於「Rust backend 內部持有的 allowlist」。
/// 動機：`open_repo_inner` 對 raw path 開放會重開 webview 任意 path attack surface
/// （惡意 webview 注入未經 picker 的路徑取得 repo_id 後做 stage/commit）。stored
/// list 由 picker / 自身 open success 寫入，webview 無法直接寫，達成隔離。
fn open_recent_repo_inner(
    app: &AppHandle,
    registry: &RepoRegistry,
    requested_path: &str,
) -> Result<RepoOpenResult> {
    let dir = crate::fs::recent_repos::resolve_dir(app)?;
    open_recent_repo_with_dir(&dir, registry, requested_path)
}

fn open_recent_repo_with_dir(
    dir: &Path,
    registry: &RepoRegistry,
    requested_path: &str,
) -> Result<RepoOpenResult> {
    if requested_path.is_empty()
        || requested_path.len() > MAX_REPO_PATH_LEN
        || requested_path.contains('\0')
    {
        return Err(KiraError::InvalidPath);
    }
    // Hold write_lock over load → allowlist check → open → record，避免
    // 同 process 另一執行緒在 check 後 evict 該 entry 造成「授權當下成立的
    // path 在 open 時已被擠出 list」TOCTOU 視窗。用 `_unlocked` 變體 record
    // 因為 write_lock 不 reentrant。
    let _guard = crate::fs::recent_repos::write_lock()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let list = crate::fs::recent_repos::load_in_dir(dir);
    if !list.iter().any(|r| r.path == requested_path) {
        return Err(KiraError::NotARepo);
    }
    let result = open_repo_inner(registry, requested_path)?;
    crate::fs::recent_repos::add_canonical_in_dir_unlocked(dir, Path::new(&result.info.path));
    Ok(result)
}

fn resolve_and_open(
    registry: &RepoRegistry,
    repo_id: &str,
) -> Result<(Arc<RepoEntry>, Repository)> {
    let entry = registry.resolve(repo_id)?;
    let repo = open_repo(&entry.canonical_root).map_err(|_| KiraError::RepoNotOpen)?;
    Ok((entry, repo))
}

fn get_graph_inner(
    registry: &RepoRegistry,
    repo_id: &str,
    limit: Option<u32>,
) -> Result<GraphData> {
    let (_entry, repo) = resolve_and_open(registry, repo_id)?;
    graph::build_graph(&repo, limit)
}

fn get_diff_inner(registry: &RepoRegistry, repo_id: &str, oid: &str) -> Result<DiffResult> {
    let (_entry, repo) = resolve_and_open(registry, repo_id)?;
    diff::get_diff(&repo, oid)
}

fn get_status_inner(registry: &RepoRegistry, repo_id: &str) -> Result<WorkingTreeStatus> {
    let (_entry, repo) = resolve_and_open(registry, repo_id)?;
    diff::get_status(&repo)
}

fn stage_file_inner(registry: &RepoRegistry, repo_id: &str, path: &str) -> Result<StageResult> {
    let (entry, repo) = resolve_and_open(registry, repo_id)?;
    let _guard = entry.write_lock.lock().unwrap();
    stage::stage_file(&repo, path)?;
    Ok(StageResult { success: true })
}

fn unstage_file_inner(registry: &RepoRegistry, repo_id: &str, path: &str) -> Result<StageResult> {
    let (entry, repo) = resolve_and_open(registry, repo_id)?;
    let _guard = entry.write_lock.lock().unwrap();
    stage::unstage_file(&repo, path)?;
    Ok(StageResult { success: true })
}

fn stage_all_inner(registry: &RepoRegistry, repo_id: &str) -> Result<StageResult> {
    let (entry, repo) = resolve_and_open(registry, repo_id)?;
    let _guard = entry.write_lock.lock().unwrap();
    stage::stage_all(&repo)?;
    Ok(StageResult { success: true })
}

fn unstage_all_inner(registry: &RepoRegistry, repo_id: &str) -> Result<StageResult> {
    let (entry, repo) = resolve_and_open(registry, repo_id)?;
    let _guard = entry.write_lock.lock().unwrap();
    stage::unstage_all(&repo)?;
    Ok(StageResult { success: true })
}

fn commit_inner(registry: &RepoRegistry, repo_id: &str, message: &str) -> Result<CommitResult> {
    let (entry, repo) = resolve_and_open(registry, repo_id)?;
    let _guard = entry.write_lock.lock().unwrap();
    if !stage::check_identity_configured(&repo) {
        return Err(KiraError::GitIdentityMissing);
    }
    let signature = repo.signature()?;
    let oid = stage::commit(&repo, &signature, message)?;
    Ok(CommitResult { oid })
}

#[derive(Debug, Serialize)]
pub struct PushResult {
    pub success: bool,
    /// `None`: caller did not request set_upstream;
    /// `Some(true)`: requested and upstream is now configured;
    /// `Some(false)`: requested but the set_upstream attempt failed (push itself succeeded).
    pub upstream_set: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct PullResult {
    pub commits_added: u32,
}

#[derive(Clone, Serialize)]
struct GitProgressEvent {
    repo_id: String,
    op: &'static str,
    percent: Option<u32>,
}

/// 100ms throttle 100% 必發；前端用 stable channel `git-progress` + payload.repo_id filter
fn make_throttled_emitter(app: AppHandle, repo_id: String, op: &'static str) -> impl FnMut(u32) {
    let last = Cell::new(Instant::now() - Duration::from_millis(PROGRESS_THROTTLE_MS * 2));
    move |percent| {
        let now = Instant::now();
        if now.duration_since(last.get()) >= Duration::from_millis(PROGRESS_THROTTLE_MS)
            || percent == 100
        {
            last.set(now);
            let _ = app.emit(
                PROGRESS_EVENT,
                GitProgressEvent {
                    repo_id: repo_id.clone(),
                    op,
                    percent: Some(percent),
                },
            );
        }
    }
}

fn push_inner(
    app: &AppHandle,
    registry: &RepoRegistry,
    repo_id: &str,
    remote_name: &str,
    branch: &str,
    set_upstream: bool,
) -> Result<PushResult> {
    let (entry, repo) = resolve_and_open(registry, repo_id)?;
    let _guard = entry.write_lock.lock().unwrap();
    let emitter = make_throttled_emitter(app.clone(), repo_id.to_string(), "push");
    let outcome = remote::push(&repo, remote_name, branch, set_upstream, emitter)?;
    Ok(PushResult {
        success: true,
        upstream_set: outcome.upstream_set,
    })
}

fn ahead_behind_inner(registry: &RepoRegistry, repo_id: &str) -> Result<remote::AheadBehindInfo> {
    let (_entry, repo) = resolve_and_open(registry, repo_id)?;
    remote::ahead_behind(&repo)
}

// 重讀 disk RepoInfo —— 外部 CLI 切 branch 後 open-repo 快照的 head_branch 會 stale。
fn list_branches_inner(registry: &RepoRegistry, repo_id: &str) -> Result<ListBranchesResult> {
    let (_entry, repo) = resolve_and_open(registry, repo_id)?;
    branch::list_branches(&repo)
}

fn get_branch_stats_inner(
    registry: &RepoRegistry,
    repo_id: &str,
    branch_names: &[String],
) -> Result<std::collections::HashMap<String, BranchStats>> {
    let (_entry, repo) = resolve_and_open(registry, repo_id)?;
    branch::get_branch_stats(&repo, branch_names)
}

#[derive(Debug, Serialize)]
pub struct CreateBranchResult {
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct DeleteBranchResult {
    pub success: bool,
}

#[derive(Debug, Serialize)]
pub struct CheckoutBranchResult {
    pub head_branch: String,
}

fn create_branch_inner(
    registry: &RepoRegistry,
    repo_id: &str,
    name: &str,
    base_oid: Option<&str>,
) -> Result<CreateBranchResult> {
    let (entry, repo) = resolve_and_open(registry, repo_id)?;
    let _guard = entry.write_lock.lock().unwrap();
    // mutating cmd state guard: refuse to
    // write refs while merge/rebase/cherry-pick is in flight.
    if repo.state() != RepositoryState::Clean {
        return Err(KiraError::RepositoryNotClean);
    }
    branch::create_branch(&repo, name, base_oid)?;
    Ok(CreateBranchResult {
        name: name.to_string(),
    })
}

fn delete_branch_inner(
    registry: &RepoRegistry,
    repo_id: &str,
    name: &str,
    force: bool,
) -> Result<DeleteBranchResult> {
    let (entry, repo) = resolve_and_open(registry, repo_id)?;
    let _guard = entry.write_lock.lock().unwrap();
    if repo.state() != RepositoryState::Clean {
        return Err(KiraError::RepositoryNotClean);
    }
    branch::delete_branch(&repo, name, force)?;
    Ok(DeleteBranchResult { success: true })
}

fn checkout_branch_inner(
    registry: &RepoRegistry,
    repo_id: &str,
    name: &str,
    force: bool,
) -> Result<CheckoutBranchResult> {
    let (entry, repo) = resolve_and_open(registry, repo_id)?;
    let _guard = entry.write_lock.lock().unwrap();
    if repo.state() != RepositoryState::Clean {
        return Err(KiraError::RepositoryNotClean);
    }
    let head_branch = branch::checkout_branch(&repo, name, force)?;
    Ok(CheckoutBranchResult { head_branch })
}

fn get_repo_info_inner(registry: &RepoRegistry, repo_id: &str) -> Result<RepoInfo> {
    let (entry, repo) = resolve_and_open(registry, repo_id)?;
    build_repo_info(&repo, entry.canonical_root.to_string_lossy().into_owned())
}

fn pull_inner(
    app: &AppHandle,
    registry: &RepoRegistry,
    repo_id: &str,
    remote_name: &str,
    branch: &str,
) -> Result<PullResult> {
    let (entry, repo) = resolve_and_open(registry, repo_id)?;
    let _guard = entry.write_lock.lock().unwrap();
    let emitter = make_throttled_emitter(app.clone(), repo_id.to_string(), "pull");
    let commits_added = remote::pull(&repo, remote_name, branch, emitter)?;
    Ok(PullResult { commits_added })
}

/// 唯一的 repo 開啟入口：picker 在 Rust 端，webview 拿不到任意 path 接受面。
/// 動機：prompt-injection 後的 webview 不能 invoke `git_pick_and_open_repo({path: "/任意"})`
/// 來綁定 token 後做 stage/commit。token 引入（T6 OAuth）前 Critical 必收緊。
///
/// `#[tauri::command(async)]`：Tauri 預設把 sync command 跑在 main thread，
/// `blocking_pick_folder()` 內部把 dialog 派到 main thread 並 block 當前 thread 等
/// callback —— main thread block 等自己 → deadlock。`(async)` 讓 Tauri 用
/// `async_runtime::spawn` 把整個 sync fn 推到 worker thread，main thread 自由處理
/// dialog event loop。
#[tauri::command(async)]
pub fn git_pick_and_open_repo(
    app: AppHandle,
    state: tauri::State<RepoRegistry>,
    active: tauri::State<ActiveWatcher>,
) -> Result<Option<RepoOpenResult>> {
    let watcher_gen = active.bump_generation();
    let result = pick_and_open_repo_inner(&app, &state)?;
    if let Some(r) = &result {
        start_active_watcher(&app, &active, watcher_gen, &r.repo_id, &r.info.path);
    }
    Ok(result)
}

/// Recent-repo 點擊入口。Path 必須在 backend 持有的 recent_repos.json 命中
/// 才走 `open_repo_inner`，否則 `NotARepo`（避免任意 path attack surface）。
/// 非 dialog blocking，純 std::fs 讀小 JSON + git2 open，sync 即可（無 main thread
/// deadlock 風險）。
#[tauri::command(rename_all = "snake_case")]
pub fn git_open_recent_repo(
    app: AppHandle,
    state: tauri::State<RepoRegistry>,
    active: tauri::State<ActiveWatcher>,
    path: String,
) -> Result<RepoOpenResult> {
    let watcher_gen = active.bump_generation();
    let result = open_recent_repo_inner(&app, &state, &path)?;
    start_active_watcher(
        &app,
        &active,
        watcher_gen,
        &result.repo_id,
        &result.info.path,
    );
    Ok(result)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_get_graph(
    state: tauri::State<RepoRegistry>,
    repo_id: String,
    limit: Option<u32>,
) -> Result<GraphData> {
    get_graph_inner(&state, &repo_id, limit)
}

/// `async` + `spawn_blocking`（在 `DiffGate` 裡）：算 diff 不再佔住主執行緒——開 repo 會立刻載
/// HEAD 的 diff，大 commit 會讓整個視窗卡住。閘保證同時只算一個、排隊中過期的跳過。
/// `rename_all` 不能拿掉：前端送 `repo_id`，少了它每次都對不上，而 build、cargo test
/// （測的是 `get_diff_inner`）、vitest（mock）都抓不到
#[tauri::command(rename_all = "snake_case", async)]
pub async fn git_get_diff(
    app: AppHandle,
    gate: tauri::State<'_, DiffGate>,
    repo_id: String,
    oid: String,
) -> Result<DiffResult> {
    gate.run_latest(move || get_diff_inner(&app.state::<RepoRegistry>(), &repo_id, &oid))
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_get_status(
    state: tauri::State<RepoRegistry>,
    repo_id: String,
) -> Result<WorkingTreeStatus> {
    get_status_inner(&state, &repo_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_stage_file(
    state: tauri::State<RepoRegistry>,
    repo_id: String,
    path: String,
) -> Result<StageResult> {
    stage_file_inner(&state, &repo_id, &path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_unstage_file(
    state: tauri::State<RepoRegistry>,
    repo_id: String,
    path: String,
) -> Result<StageResult> {
    unstage_file_inner(&state, &repo_id, &path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_stage_all(state: tauri::State<RepoRegistry>, repo_id: String) -> Result<StageResult> {
    stage_all_inner(&state, &repo_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_unstage_all(state: tauri::State<RepoRegistry>, repo_id: String) -> Result<StageResult> {
    unstage_all_inner(&state, &repo_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_commit(
    state: tauri::State<RepoRegistry>,
    repo_id: String,
    message: String,
) -> Result<CommitResult> {
    commit_inner(&state, &repo_id, &message)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_push(
    app: AppHandle,
    state: tauri::State<RepoRegistry>,
    repo_id: String,
    remote: String,
    branch: String,
    set_upstream: bool,
) -> Result<PushResult> {
    push_inner(&app, &state, &repo_id, &remote, &branch, set_upstream)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_pull(
    app: AppHandle,
    state: tauri::State<RepoRegistry>,
    repo_id: String,
    remote: String,
    branch: String,
) -> Result<PullResult> {
    pull_inner(&app, &state, &repo_id, &remote, &branch)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_get_ahead_behind(
    state: tauri::State<RepoRegistry>,
    repo_id: String,
) -> Result<remote::AheadBehindInfo> {
    ahead_behind_inner(&state, &repo_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_get_repo_info(state: tauri::State<RepoRegistry>, repo_id: String) -> Result<RepoInfo> {
    get_repo_info_inner(&state, &repo_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_list_branches(
    state: tauri::State<RepoRegistry>,
    repo_id: String,
) -> Result<ListBranchesResult> {
    list_branches_inner(&state, &repo_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_get_branch_stats(
    state: tauri::State<RepoRegistry>,
    repo_id: String,
    branch_names: Vec<String>,
) -> Result<std::collections::HashMap<String, BranchStats>> {
    get_branch_stats_inner(&state, &repo_id, &branch_names)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_create_branch(
    state: tauri::State<RepoRegistry>,
    repo_id: String,
    name: String,
    base_oid: Option<String>,
) -> Result<CreateBranchResult> {
    create_branch_inner(&state, &repo_id, &name, base_oid.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_delete_branch(
    state: tauri::State<RepoRegistry>,
    repo_id: String,
    name: String,
    force: bool,
) -> Result<DeleteBranchResult> {
    delete_branch_inner(&state, &repo_id, &name, force)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_checkout_branch(
    state: tauri::State<RepoRegistry>,
    repo_id: String,
    name: String,
    force: bool,
) -> Result<CheckoutBranchResult> {
    checkout_branch_inner(&state, &repo_id, &name, force)
}

// ===== T11a: git_clone_start / git_clone_cancel =====

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CloneStartResult {
    pub clone_id: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CloneCancelResult {
    pub cancelled: bool,
}

#[derive(Clone, Serialize)]
struct CloneProgressEvent {
    clone_id: String,
    phase: ClonePhase,
    current: u32,
    total: u32,
    bytes: u64,
}

#[derive(Clone, Serialize)]
struct CloneDoneEvent {
    clone_id: String,
    #[serde(flatten)]
    result: CloneDoneResult,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "PascalCase")]
enum CloneDoneResult {
    Ok(CloneDoneOk),
    Err(CloneDoneErr),
}

#[derive(Clone, Serialize)]
struct CloneDoneOk {
    path: String,
    repo_id: String,
}

#[derive(Clone, Serialize)]
struct CloneDoneErr {
    code: &'static str,
    message: String,
    hint: Option<&'static str>,
}

/// SPEC.md git_clone_start URL validation:
/// - length ≤ MAX_CLONE_URL_LEN (2048)
/// - no NUL
/// - `url::Url::parse` succeeds
/// - scheme == "https" (HTTPS only; SSH/git/file IPC-rejected)
/// - userinfo (username / password) empty (prevent token landing in
///   `dest/.git/config` `[remote "origin"].url`)
/// - no query / fragment (Codex review finding: `https://github.com/foo/bar?
///   access_token=ghp_xxx` and `https://github.com/foo/bar#token=...` both
///   pass the userinfo guard, then libgit2 persists the full URL into
///   `.git/config`; reject both to keep the no-URL-credentials contract)
fn validate_clone_url(url: &str) -> Result<String> {
    if url.is_empty() || url.len() > MAX_CLONE_URL_LEN || url.contains('\0') {
        return Err(KiraError::InvalidUrl);
    }
    let parsed = Url::parse(url).map_err(|_| KiraError::InvalidUrl)?;
    if parsed.scheme() != "https" {
        return Err(KiraError::InvalidUrl);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(KiraError::InvalidUrl);
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(KiraError::InvalidUrl);
    }
    Ok(parsed.to_string())
}

/// SPEC.md git_clone_start dest validation:
/// - length ≤ MAX_REPO_PATH_LEN (4096)
/// - no NUL
/// - no `~` (T11a v1 doesn't expand; picker hands absolute paths)
/// - absolute path
/// - canonicalize succeeds (picker guarantees the dir exists — OS folder
///   picker only returns existing paths, including dirs created via the
///   "New Folder" button which OS-mkdir before returning)
/// - canonical path registered in `PendingCloneDestLock` (Layer 1 capability)
///
/// Returns the canonical PathBuf so the engine receives a stable identity.
///
/// Review finding H1: removed prior `canonicalize().unwrap_or(raw)` fallback —
/// `register_picked_dest` always returns `InvalidPath` when canonicalize
/// fails (clone_dest.rs:35), so the lock never contains a non-canonical
/// raw path; the fallback was misleading dead code that could never match.
/// Failing fast here aligns picker and validator semantics.
fn validate_clone_dest(dest_str: &str, lock: &PendingCloneDestLock) -> Result<PathBuf> {
    if dest_str.is_empty()
        || dest_str.len() > MAX_REPO_PATH_LEN
        || dest_str.contains('\0')
        || dest_str.contains('~')
    {
        return Err(KiraError::InvalidPath);
    }
    let raw = PathBuf::from(dest_str);
    if !raw.is_absolute() {
        return Err(KiraError::InvalidPath);
    }
    let canonical = std::fs::canonicalize(&raw).map_err(|_| KiraError::InvalidPath)?;
    if !lock.check(&canonical) {
        return Err(KiraError::InvalidPath);
    }
    Ok(canonical)
}

/// Throttled clone progress emitter. Phase-aware: each phase has its own
/// 100ms gate, and phase transitions force an emit (so UI never freezes on
/// stale percentage when the engine switches Receiving → Resolving →
/// CheckingOut).
fn make_throttled_clone_emitter(
    app: AppHandle,
    clone_id: String,
) -> impl FnMut(ClonePhase, u32, u32, u64) + Send + 'static {
    // Index 0/1/2 ↔ Receiving/Resolving/CheckingOut (see `phase_idx`). Initial
    // timestamps are intentionally stale so the first emit for any phase
    // bypasses the throttle.
    let stale = Instant::now() - Duration::from_millis(PROGRESS_THROTTLE_MS * 2);
    let last_emit_per_phase: Cell<[Instant; 3]> = Cell::new([stale; 3]);
    let last_phase: Cell<Option<ClonePhase>> = Cell::new(None);

    fn phase_idx(phase: ClonePhase) -> usize {
        match phase {
            ClonePhase::Receiving => 0,
            ClonePhase::Resolving => 1,
            ClonePhase::CheckingOut => 2,
        }
    }

    move |phase: ClonePhase, current: u32, total: u32, bytes: u64| {
        let now = Instant::now();
        let phase_changed = last_phase.get() != Some(phase);
        let idx = phase_idx(phase);
        let mut emits = last_emit_per_phase.get();
        let should_emit = phase_changed
            || now.duration_since(emits[idx]) >= Duration::from_millis(PROGRESS_THROTTLE_MS)
            || (total > 0 && current == total);
        if !should_emit {
            return;
        }
        emits[idx] = now;
        last_emit_per_phase.set(emits);
        last_phase.set(Some(phase));
        let _ = app.emit(
            CLONE_PROGRESS_EVENT,
            CloneProgressEvent {
                clone_id: clone_id.clone(),
                phase,
                current,
                total,
                bytes,
            },
        );
    }
}

/// Map a clone-engine-produced `KiraError` to the serialized payload that
/// rides `clone:done.Err`. Hints are static strings ("private repos are
/// GitHub-only" etc.) — no path / URL / git2 raw message leakage.
fn clone_done_err_from(err: &KiraError) -> CloneDoneErr {
    let (message, hint): (String, Option<&'static str>) = match err {
        KiraError::InvalidUrl => (
            "invalid clone URL".to_string(),
            Some("URL must be HTTPS without embedded credentials, query string, or fragment."),
        ),
        KiraError::InvalidPath => (
            "invalid destination path".to_string(),
            Some("Destination must be an absolute path registered via the picker (within 5 min)."),
        ),
        KiraError::DestExists => (
            "destination is not empty".to_string(),
            Some("Pick an empty directory or remove existing contents."),
        ),
        KiraError::AuthFailed => (
            "authentication required".to_string(),
            Some("Private repos are GitHub-only in this version; sign in via GitHub OAuth."),
        ),
        KiraError::NetworkError => (
            "network operation failed".to_string(),
            Some("Check connectivity / firewall; libgit2 cleanup attempted on dest, rare residual on AV or external file handles."),
        ),
        KiraError::InsufficientDiskSpace => (
            "insufficient disk space".to_string(),
            Some("Free up disk space and try again."),
        ),
        KiraError::Cancelled => ("operation cancelled".to_string(), None),
        KiraError::CloneInProgress => (
            "another clone is in progress for this destination".to_string(),
            Some("Wait for the existing clone to finish or cancel it before retrying."),
        ),
        _ => ("clone failed".to_string(), None),
    };
    CloneDoneErr {
        code: err.code(),
        message,
        hint,
    }
}

/// RAII guard ensuring `CloneRegistry::remove` + `release_dest` run even if
/// `run_clone_background` panics mid-clone (review finding M2: prior code had
/// the settle calls at the function tail, so a panic — Mutex poison from a
/// downstream `.unwrap()`, etc. — left the dest permanently reserved in
/// `active_dests` and the frontend stuck in an in-progress state with no
/// recovery path).
///
/// Tokio spawn_blocking unwinds panics by default, so Drop runs before the
/// `JoinHandle` resolves. The two ops are idempotent so a normal-path
/// double-settle (cancel races success) is harmless.
struct CloneSettleGuard {
    app: AppHandle,
    clone_id: String,
    dest: PathBuf,
}

impl Drop for CloneSettleGuard {
    fn drop(&mut self) {
        let clone_registry = self.app.state::<CloneRegistry>();
        clone_registry.remove(&self.clone_id);
        clone_registry.release_dest(&self.dest);
    }
}

/// Run the clone on a worker thread and emit `clone:done` when settled.
/// `CloneSettleGuard` (RAII) handles handle removal + dest release on both
/// the success and panic paths.
fn run_clone_background(
    app: AppHandle,
    clone_id: String,
    url: String,
    dest_path: PathBuf,
    handle: Arc<CloneHandle>,
    watcher_gen: u64,
) {
    let _settle = CloneSettleGuard {
        app: app.clone(),
        clone_id: clone_id.clone(),
        dest: dest_path.clone(),
    };

    let emitter = make_throttled_clone_emitter(app.clone(), clone_id.clone());
    let engine_result = clone_repo(&url, &dest_path, Arc::clone(&handle), emitter);

    let done = match engine_result {
        Ok(()) => match open_cloned_repo(&app, &dest_path) {
            Ok(open_result) => {
                start_active_watcher(
                    &app,
                    &app.state::<ActiveWatcher>(),
                    watcher_gen,
                    &open_result.repo_id,
                    &open_result.info.path,
                );
                CloneDoneResult::Ok(CloneDoneOk {
                    path: open_result.info.path.clone(),
                    repo_id: open_result.repo_id,
                })
            }
            Err(e) => CloneDoneResult::Err(clone_done_err_from(&e)),
        },
        Err(e) => CloneDoneResult::Err(clone_done_err_from(&e)),
    };

    let _ = app.emit(
        CLONE_DONE_EVENT,
        CloneDoneEvent {
            clone_id: clone_id.clone(),
            result: done,
        },
    );
    // _settle Drop runs here (and also on any panic above).
}

/// Open the cloned working dir via existing `open_repo_inner` (picks up
/// canonical_root, registers RepoRegistry entry, builds RepoInfo) and adds it
/// to recent_repos. Frontend gets `repo_id` in `clone:done.Ok`.
fn open_cloned_repo(app: &AppHandle, dest_path: &Path) -> Result<RepoOpenResult> {
    let registry = app.state::<RepoRegistry>();
    let dest_str = dest_path.to_str().ok_or(KiraError::InvalidPath)?;
    let result = open_repo_inner(&registry, dest_str)?;
    crate::fs::recent_repos::add_canonical(app, Path::new(&result.info.path));
    Ok(result)
}

/// `#[tauri::command(async)]`: spawn_blocking pattern. Async fn body validates
/// inputs synchronously **including the platform-noise-aware empty check and
/// the per-dest in-flight reservation** (Codex review findings), then
/// detaches the clone task via `tauri::async_runtime::spawn_blocking` so the
/// IPC returns `clone_id` immediately. The background task emits
/// `clone:progress` while running and `clone:done` when settled.
///
/// Synchronous gates (run before spawning, so failure modes are returned
/// directly to the IPC caller — frontend never races a fast `clone:done` Err
/// against the `git_clone_start` promise resolve):
/// - URL shape + dest capability lock (validate_*)
/// - `dest_is_effectively_empty`: rejects non-empty / non-noise dest with
///   `DEST_EXISTS` synchronously instead of letting libgit2 do it after the
///   task spawns.
/// - `try_reserve_dest`: rejects duplicate concurrent clones on the same
///   dest with `CLONE_IN_PROGRESS`. Released in `run_clone_background` settle
///   path so retry-on-same-dest still works after fail/cancel.
#[tauri::command(rename_all = "snake_case", async)]
pub async fn git_clone_start(
    app: AppHandle,
    clone_registry: tauri::State<'_, CloneRegistry>,
    pending_lock: tauri::State<'_, PendingCloneDestLock>,
    url: String,
    dest: String,
) -> Result<CloneStartResult> {
    let canonical_url = validate_clone_url(&url)?;
    let dest_path = validate_clone_dest(&dest, &pending_lock)?;

    // Synchronous preflight: platform-noise-aware emptiness. clone_repo also
    // runs this check (defense-in-depth) but failing here returns DestExists
    // directly to the IPC caller rather than racing the clone:done emit.
    if !crate::git::clone::dest_is_effectively_empty(&dest_path)? {
        return Err(KiraError::DestExists);
    }
    crate::git::clone::rm_platform_noise(&dest_path);

    // Reserve dest atomically. Concurrent git_clone_start on the same dest
    // (double-click, retry bug, compromised renderer) returns CloneInProgress
    // here rather than letting two clones race RepoBuilder::clone's
    // auto-cleanup.
    if !clone_registry.try_reserve_dest(dest_path.clone()) {
        return Err(KiraError::CloneInProgress);
    }

    let handle = Arc::new(CloneHandle::new());
    let clone_id = clone_registry.register(Arc::clone(&handle));

    let watcher_gen = app.state::<ActiveWatcher>().bump_generation();
    let task_clone_id = clone_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_clone_background(
            app,
            task_clone_id,
            canonical_url,
            dest_path,
            handle,
            watcher_gen,
        );
    });

    Ok(CloneStartResult { clone_id })
}

/// Set `cancel_requested` on the handle. Idempotent: returning `cancelled:false`
/// for unknown clone_id is **not** what SPEC says — unknown returns
/// `INVALID_CLONE_ID` error. Settled clone_id (already removed from registry)
/// also returns `INVALID_CLONE_ID`; the frontend should ignore that and wait
/// for the `clone:done` event it must have already received or is about to.
#[tauri::command(rename_all = "snake_case")]
pub fn git_clone_cancel(
    clone_registry: tauri::State<CloneRegistry>,
    clone_id: String,
) -> Result<CloneCancelResult> {
    let handle = clone_registry.lookup(&clone_id)?;
    let was_already = handle
        .cancel_requested
        .swap(true, std::sync::atomic::Ordering::Relaxed);
    Ok(CloneCancelResult {
        cancelled: !was_already,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn init_test_repo() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        dir
    }

    fn open_and_register(registry: &RepoRegistry, dir: &TempDir) -> String {
        let path = dir.path().to_str().unwrap().to_string();
        open_repo_inner(registry, &path).unwrap().repo_id
    }

    #[test]
    fn test_git_open_repo_invalid_path_returns_not_a_repo() {
        let registry = RepoRegistry::new();
        let result = open_repo_inner(&registry, "/nonexistent/path/to/repo");
        assert!(matches!(result, Err(KiraError::NotARepo)));
    }

    #[test]
    fn test_git_open_repo_empty_path_returns_invalid_path() {
        let registry = RepoRegistry::new();
        let result = open_repo_inner(&registry, "");
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_git_open_repo_path_with_null_byte_returns_invalid_path() {
        let registry = RepoRegistry::new();
        let result = open_repo_inner(&registry, "/tmp/repo\0/etc/passwd");
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_git_open_repo_oversize_path_returns_invalid_path() {
        let registry = RepoRegistry::new();
        let huge = "/".to_string() + &"a".repeat(MAX_REPO_PATH_LEN);
        let result = open_repo_inner(&registry, &huge);
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_git_open_repo_valid_path_returns_repo_info() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let path = dir.path().to_str().unwrap().to_string();
        let result = open_repo_inner(&registry, &path).unwrap();
        assert!(!result.repo_id.is_empty());
        assert!(
            result.info.head_branch.is_none(),
            "empty repo should have unborn HEAD"
        );
        assert!(result.info.branches.is_empty());
        assert!(result.info.remotes.is_empty());
        // canonical path 應該是 user 給的 path 的 canonical 版本
        let expected = std::fs::canonicalize(dir.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(result.info.path, expected);
    }

    #[test]
    fn test_git_open_repo_bare_repo_returns_not_a_repo() {
        let registry = RepoRegistry::new();
        let dir = tempfile::tempdir().unwrap();
        Repository::init_bare(dir.path()).unwrap();
        let path = dir.path().to_str().unwrap().to_string();
        let result = open_repo_inner(&registry, &path);
        assert!(matches!(result, Err(KiraError::NotARepo)));
    }

    #[test]
    #[cfg(unix)]
    fn test_git_open_repo_via_symlink_returns_same_id_as_real_path() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let real = dir.path().to_str().unwrap().to_string();

        // 在 dir 旁建一個 symlink 指向 dir
        let parent = dir.path().parent().unwrap();
        let link = parent.join(format!(
            "kira-symlink-{}",
            dir.path().file_name().unwrap().to_str().unwrap()
        ));
        std::os::unix::fs::symlink(dir.path(), &link).unwrap();
        let link_path = link.to_str().unwrap().to_string();

        let id_real = open_repo_inner(&registry, &real).unwrap().repo_id;
        let id_link = open_repo_inner(&registry, &link_path).unwrap().repo_id;
        assert_eq!(id_real, id_link, "symlink path 應註冊回同一 repo_id");

        let _ = fs::remove_file(&link);
    }

    #[test]
    fn test_git_get_graph_unknown_repo_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let result = get_graph_inner(&registry, "no-such-id", None);
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_git_get_graph_empty_repo_returns_empty() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        let graph = get_graph_inner(&registry, &repo_id, None).unwrap();
        assert!(graph.commits.is_empty());
    }

    // Regression (dev smoke): 外部 CLI 切 branch 後 IPC 必須吐 fresh
    // head_branch，否則 PushPullBar 會用 stale branch 送進 git_push。
    #[test]
    fn test_get_repo_info_inner_reflects_disk_head_branch_switch() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);

        // 建 initial commit (空 repo 的 HEAD 是 unborn, 沒 branch shorthand)
        {
            let repo = Repository::open(dir.path()).unwrap();
            let sig = git2::Signature::now("test", "test@example.com").unwrap();
            let tree_id = repo.index().unwrap().write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }

        let info_before = get_repo_info_inner(&registry, &repo_id).unwrap();
        let initial_branch = info_before.head_branch.clone();
        assert!(initial_branch.is_some(), "commit 後 HEAD 應有 shorthand");

        // 模擬 CLI 外部切 branch: 建新 branch + set_head
        {
            let repo = Repository::open(dir.path()).unwrap();
            let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("feat-X", &head_commit, false).unwrap();
            repo.set_head("refs/heads/feat-X").unwrap();
        }

        let info_after = get_repo_info_inner(&registry, &repo_id).unwrap();
        assert_eq!(
            info_after.head_branch.as_deref(),
            Some("feat-X"),
            "切 branch 後 get_repo_info_inner 必須反映 disk HEAD"
        );
        assert_ne!(info_after.head_branch, initial_branch);
        // path / remotes 不變
        assert_eq!(info_before.path, info_after.path);
        assert_eq!(info_before.remotes, info_after.remotes);
    }

    // detached HEAD 的 shorthand() 會回 pseudo "HEAD"，沒 is_branch() guard 會讓
    // PushPullBar 不 fail closed、組出錯 refspec。
    #[test]
    fn test_get_repo_info_inner_detached_head_returns_none_branch() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);

        // 建 commit 後 detach HEAD 到該 commit OID
        let oid = {
            let repo = Repository::open(dir.path()).unwrap();
            let sig = git2::Signature::now("test", "test@example.com").unwrap();
            let tree_id = repo.index().unwrap().write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let oid = repo
                .commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
            repo.set_head_detached(oid).unwrap();
            oid
        };

        let info = get_repo_info_inner(&registry, &repo_id).unwrap();
        assert!(
            info.head_branch.is_none(),
            "detached HEAD 應回 None, 實際: {:?}",
            info.head_branch
        );
        // OID 沒漏 — 只是不能當 branch shorthand 用
        let head_target = Repository::open(dir.path())
            .unwrap()
            .head()
            .unwrap()
            .target();
        assert_eq!(head_target, Some(oid));
    }

    #[test]
    fn test_get_repo_info_inner_unknown_repo_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let result = get_repo_info_inner(&registry, "no-such-id");
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_git_get_diff_unknown_repo_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let result = get_diff_inner(&registry, "no-such-id", "deadbeef");
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_git_get_diff_invalid_oid_returns_commit_not_found() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        let result = get_diff_inner(&registry, &repo_id, "deadbeef");
        assert!(matches!(result, Err(KiraError::CommitNotFound(_))));
    }

    #[test]
    fn test_git_get_status_unknown_repo_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let result = get_status_inner(&registry, "no-such-id");
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_git_get_status_empty_repo_returns_empty() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        let status = get_status_inner(&registry, &repo_id).unwrap();
        assert!(status.staged.is_empty());
        assert!(status.unstaged.is_empty());
    }

    #[test]
    fn test_git_stage_file_unknown_repo_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let result = stage_file_inner(&registry, "no-such-id", "a.txt");
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_git_stage_file_valid_repo_returns_success() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        fs::write(dir.path().join("a.txt"), "hello\n").unwrap();

        let result = stage_file_inner(&registry, &repo_id, "a.txt").unwrap();
        assert!(result.success);
    }

    #[test]
    fn test_git_unstage_file_unknown_repo_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let result = unstage_file_inner(&registry, "no-such-id", "a.txt");
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_git_commit_unknown_repo_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let result = commit_inner(&registry, "no-such-id", "msg");
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_git_commit_valid_repo_returns_oid() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        fs::write(dir.path().join("a.txt"), "hello\n").unwrap();
        stage_file_inner(&registry, &repo_id, "a.txt").unwrap();

        let result = commit_inner(&registry, &repo_id, "first commit").unwrap();
        assert_eq!(result.oid.len(), 40);
    }

    #[test]
    fn test_git_commit_empty_message_returns_empty_message() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        let result = commit_inner(&registry, &repo_id, "");
        assert!(matches!(result, Err(KiraError::EmptyMessage)));
    }

    #[test]
    fn test_git_stage_all_unknown_repo_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let result = stage_all_inner(&registry, "no-such-id");
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_git_stage_all_valid_repo_stages_unstaged_changes() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        fs::write(dir.path().join("a.txt"), "hello\n").unwrap();
        fs::write(dir.path().join("b.txt"), "world\n").unwrap();

        let result = stage_all_inner(&registry, &repo_id).unwrap();
        assert!(result.success);

        let status = get_status_inner(&registry, &repo_id).unwrap();
        assert_eq!(status.staged.len(), 2);
        assert!(status.unstaged.is_empty());
    }

    #[test]
    fn test_git_unstage_all_unknown_repo_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let result = unstage_all_inner(&registry, "no-such-id");
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_git_unstage_all_valid_repo_unstages_staged_changes() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        fs::write(dir.path().join("a.txt"), "hello\n").unwrap();
        stage_file_inner(&registry, &repo_id, "a.txt").unwrap();

        let result = unstage_all_inner(&registry, &repo_id).unwrap();
        assert!(result.success);

        let status = get_status_inner(&registry, &repo_id).unwrap();
        assert!(status.staged.is_empty());
        assert_eq!(status.unstaged.len(), 1);
    }

    /// Critical security regression test：path 不在 stored recent JSON 命中
    /// 必須 reject，否則 webview 可注入任意 path 取得 repo_id 做 stage/commit。
    /// Codex 審查抓到的盲點。
    #[test]
    fn test_open_recent_repo_rejects_selector_not_in_stored_list() {
        let storage = TempDir::new().unwrap();
        let registry = RepoRegistry::new();
        let repo_dir = init_test_repo();
        let path = repo_dir.path().to_str().unwrap();

        // stored list 是空的 → 即使是合法 repo path 也必須 reject
        let result = open_recent_repo_with_dir(storage.path(), &registry, path);
        assert!(
            matches!(result, Err(KiraError::NotARepo)),
            "未在 stored list 的 path 必須 reject 為 NotARepo，實際 {result:?}"
        );
    }

    #[test]
    fn test_open_recent_repo_accepts_selector_in_stored_list() {
        let storage = TempDir::new().unwrap();
        let registry = RepoRegistry::new();
        let repo_dir = init_test_repo();
        let canonical = std::fs::canonicalize(repo_dir.path()).unwrap();
        let canonical_str = canonical.to_string_lossy().into_owned();

        // 先把 canonical path 寫進 stored list（模擬 picker 成功後 backend 寫入）
        crate::fs::recent_repos::add_canonical_in_dir(storage.path(), &canonical);

        let result = open_recent_repo_with_dir(storage.path(), &registry, &canonical_str).unwrap();
        assert!(!result.repo_id.is_empty());
        assert_eq!(result.info.path, canonical_str);
    }

    #[test]
    fn test_open_recent_repo_rejects_empty_path() {
        let storage = TempDir::new().unwrap();
        let registry = RepoRegistry::new();
        let result = open_recent_repo_with_dir(storage.path(), &registry, "");
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_open_recent_repo_rejects_null_byte() {
        let storage = TempDir::new().unwrap();
        let registry = RepoRegistry::new();
        let result = open_recent_repo_with_dir(storage.path(), &registry, "/tmp/repo\0/etc/passwd");
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_open_recent_repo_rejects_oversize_path() {
        let storage = TempDir::new().unwrap();
        let registry = RepoRegistry::new();
        let huge = "/".to_string() + &"a".repeat(MAX_REPO_PATH_LEN);
        let result = open_recent_repo_with_dir(storage.path(), &registry, &huge);
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    // ==== T10 git_create_branch IPC tests ====

    #[test]
    fn test_git_create_branch_unknown_repo_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let result = create_branch_inner(&registry, "no-such-id", "feature", None);
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_git_create_branch_unborn_returns_unborn_head() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        let result = create_branch_inner(&registry, &repo_id, "feature", None);
        assert!(matches!(result, Err(KiraError::UnbornHead)));
    }

    #[test]
    fn test_git_create_branch_success_returns_name() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        stage_file_inner(&registry, &repo_id, "a.txt").unwrap();
        commit_inner(&registry, &repo_id, "init").unwrap();

        let result = create_branch_inner(&registry, &repo_id, "feature", None).unwrap();
        assert_eq!(result.name, "feature");
    }

    #[test]
    fn test_git_create_branch_mid_merge_returns_repository_not_clean() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        stage_file_inner(&registry, &repo_id, "a.txt").unwrap();
        commit_inner(&registry, &repo_id, "init").unwrap();

        // Simulate merge in progress by writing MERGE_HEAD — libgit2 derives
        // RepositoryState from sentinel files in .git/.
        let dummy_oid = "0000000000000000000000000000000000000000";
        fs::write(dir.path().join(".git/MERGE_HEAD"), format!("{dummy_oid}\n")).unwrap();

        let result = create_branch_inner(&registry, &repo_id, "feature", None);
        assert!(matches!(result, Err(KiraError::RepositoryNotClean)));
    }

    // ==== T10 git_delete_branch IPC tests ====

    #[test]
    fn test_git_delete_branch_unknown_repo_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let result = delete_branch_inner(&registry, "no-such-id", "feature", false);
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_git_delete_branch_not_found_returns_branch_not_found() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        stage_file_inner(&registry, &repo_id, "a.txt").unwrap();
        commit_inner(&registry, &repo_id, "init").unwrap();
        let result = delete_branch_inner(&registry, &repo_id, "ghost", false);
        assert!(matches!(result, Err(KiraError::BranchNotFound)));
    }

    #[test]
    fn test_git_delete_branch_success_when_merged() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        stage_file_inner(&registry, &repo_id, "a.txt").unwrap();
        commit_inner(&registry, &repo_id, "init").unwrap();
        // create a branch pointing at HEAD (auto-merged)
        create_branch_inner(&registry, &repo_id, "done", None).unwrap();

        let result = delete_branch_inner(&registry, &repo_id, "done", false).unwrap();
        assert!(result.success);
    }

    #[test]
    fn test_git_delete_branch_mid_merge_returns_repository_not_clean() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        stage_file_inner(&registry, &repo_id, "a.txt").unwrap();
        commit_inner(&registry, &repo_id, "init").unwrap();
        create_branch_inner(&registry, &repo_id, "done", None).unwrap();

        let dummy_oid = "0000000000000000000000000000000000000000";
        fs::write(dir.path().join(".git/MERGE_HEAD"), format!("{dummy_oid}\n")).unwrap();

        let result = delete_branch_inner(&registry, &repo_id, "done", false);
        assert!(matches!(result, Err(KiraError::RepositoryNotClean)));
    }

    // ==== T10 git_checkout_branch IPC tests ====

    #[test]
    fn test_git_checkout_branch_unknown_repo_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let result = checkout_branch_inner(&registry, "no-such-id", "feature", false);
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_git_checkout_branch_not_found_returns_branch_not_found() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        stage_file_inner(&registry, &repo_id, "a.txt").unwrap();
        commit_inner(&registry, &repo_id, "init").unwrap();

        let result = checkout_branch_inner(&registry, &repo_id, "ghost", false);
        assert!(matches!(result, Err(KiraError::BranchNotFound)));
    }

    #[test]
    fn test_git_checkout_branch_success_returns_head_branch() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        stage_file_inner(&registry, &repo_id, "a.txt").unwrap();
        commit_inner(&registry, &repo_id, "init").unwrap();
        create_branch_inner(&registry, &repo_id, "feature", None).unwrap();

        let result = checkout_branch_inner(&registry, &repo_id, "feature", false).unwrap();
        assert_eq!(result.head_branch, "feature");
    }

    #[test]
    fn test_git_checkout_branch_dirty_tree_returns_dirty_tree() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        stage_file_inner(&registry, &repo_id, "a.txt").unwrap();
        commit_inner(&registry, &repo_id, "init").unwrap();
        create_branch_inner(&registry, &repo_id, "feature", None).unwrap();

        // Make a tracked unstaged change
        fs::write(dir.path().join("a.txt"), "dirty\n").unwrap();

        let result = checkout_branch_inner(&registry, &repo_id, "feature", false);
        assert!(matches!(result, Err(KiraError::DirtyTree)));
    }

    #[test]
    fn test_git_checkout_branch_mid_merge_returns_repository_not_clean() {
        let registry = RepoRegistry::new();
        let dir = init_test_repo();
        let repo_id = open_and_register(&registry, &dir);
        fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        stage_file_inner(&registry, &repo_id, "a.txt").unwrap();
        commit_inner(&registry, &repo_id, "init").unwrap();
        create_branch_inner(&registry, &repo_id, "feature", None).unwrap();

        let dummy_oid = "0000000000000000000000000000000000000000";
        fs::write(dir.path().join(".git/MERGE_HEAD"), format!("{dummy_oid}\n")).unwrap();

        let result = checkout_branch_inner(&registry, &repo_id, "feature", false);
        assert!(matches!(result, Err(KiraError::RepositoryNotClean)));
    }

    // ===== T11a IPC layer unit tests (commit 8) =====

    #[test]
    fn test_validate_clone_url_valid_github_https_passes() {
        let result = validate_clone_url("https://github.com/octocat/Hello-World.git").unwrap();
        // url::Url canonicalization preserves lowercase host
        assert!(result.starts_with("https://github.com/"));
    }

    #[test]
    fn test_validate_clone_url_non_https_scheme_returns_invalid_url() {
        // SSH / git / file schemes all rejected at IPC bound (T11a v1 HTTPS only)
        for url in [
            "ssh://git@github.com/octocat/Hello-World.git",
            "git://github.com/octocat/Hello-World.git",
            "file:///tmp/local-bare",
            "http://github.com/octocat/Hello-World.git",
        ] {
            let result = validate_clone_url(url);
            assert!(
                matches!(result, Err(KiraError::InvalidUrl)),
                "expected InvalidUrl for {url}, got {result:?}"
            );
        }
    }

    #[test]
    fn test_validate_clone_url_with_userinfo_returns_invalid_url() {
        // T11a: token-in-URL forms must reject before libgit2 writes them
        // into dest/.git/config [remote "origin"].url
        for url in [
            "https://token@github.com/octocat/Hello-World.git",
            "https://user:pass@github.com/octocat/Hello-World.git",
            "https://ghp_xxxxxxxxxx@github.com/foo/bar.git",
        ] {
            let result = validate_clone_url(url);
            assert!(
                matches!(result, Err(KiraError::InvalidUrl)),
                "expected InvalidUrl for {url}, got {result:?}"
            );
        }
    }

    #[test]
    fn test_validate_clone_url_with_query_or_fragment_returns_invalid_url() {
        // Codex review finding: userinfo guard alone doesn't catch
        // `?access_token=` or `#token=` — libgit2 persists full URL into
        // .git/config so both must be rejected.
        for url in [
            "https://github.com/foo/bar.git?access_token=ghp_xxxxxxx",
            "https://github.com/foo/bar.git?token=abc&key=def",
            "https://github.com/foo/bar.git#token=ghp_xxxxxxx",
            "https://github.com/foo/bar.git#fragment",
            "https://github.com/foo/bar.git?x=1#y=2",
        ] {
            let result = validate_clone_url(url);
            assert!(
                matches!(result, Err(KiraError::InvalidUrl)),
                "expected InvalidUrl for {url}, got {result:?}"
            );
        }
    }

    #[test]
    fn test_validate_clone_url_empty_or_nul_or_oversize_returns_invalid_url() {
        assert!(matches!(validate_clone_url(""), Err(KiraError::InvalidUrl)));
        assert!(matches!(
            validate_clone_url("https://github.com/foo\0bar"),
            Err(KiraError::InvalidUrl)
        ));
        let huge = format!("https://github.com/{}", "a".repeat(MAX_CLONE_URL_LEN));
        assert!(matches!(
            validate_clone_url(&huge),
            Err(KiraError::InvalidUrl)
        ));
    }

    #[test]
    fn test_validate_clone_dest_unregistered_returns_invalid_path() {
        let lock = PendingCloneDestLock::new();
        let tmp = TempDir::new().unwrap();
        // Send what the picker hands the frontend, the canonical path. On the
        // Windows runner the raw temp path contains `~` (an 8.3 short name), and
        // the `~` rule would reject it before the lock is ever consulted.
        let canonical = std::fs::canonicalize(tmp.path()).unwrap();
        let result = validate_clone_dest(canonical.to_str().unwrap(), &lock);
        assert!(
            matches!(result, Err(KiraError::InvalidPath)),
            "got {result:?}"
        );
    }

    #[test]
    fn test_validate_clone_dest_registered_canonical_passes() {
        let lock = PendingCloneDestLock::new();
        let tmp = TempDir::new().unwrap();
        let canonical = std::fs::canonicalize(tmp.path()).unwrap();
        lock.register(canonical.clone());
        // The canonical path, as in the unregistered test above.
        let result = validate_clone_dest(canonical.to_str().unwrap(), &lock).unwrap();
        assert_eq!(result, canonical);
    }

    #[test]
    fn test_validate_clone_dest_relative_path_returns_invalid_path() {
        let lock = PendingCloneDestLock::new();
        let result = validate_clone_dest("relative/path", &lock);
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_validate_clone_dest_tilde_returns_invalid_path() {
        // T11a: ~ expansion not handled by IPC; picker hands absolute paths.
        let lock = PendingCloneDestLock::new();
        let result = validate_clone_dest("~/Documents/repo", &lock);
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_validate_clone_dest_nul_byte_returns_invalid_path() {
        let lock = PendingCloneDestLock::new();
        let result = validate_clone_dest("/tmp/repo\0/etc/passwd", &lock);
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_clone_done_err_redacts_path_and_url_in_message() {
        // CloneDoneErr never leaks paths or URLs — message + hint are static
        // strings or generic descriptions.
        let cases: &[KiraError] = &[
            KiraError::InvalidPath,
            KiraError::DestExists,
            KiraError::AuthFailed,
            KiraError::NetworkError,
            KiraError::InsufficientDiskSpace,
            KiraError::Cancelled,
        ];
        for err in cases {
            let done = clone_done_err_from(err);
            assert!(
                !done.message.contains('/'),
                "leaked path-like char in message: {} (variant: {err:?})",
                done.message
            );
            assert!(
                !done.message.contains("http"),
                "leaked URL in message: {} (variant: {err:?})",
                done.message
            );
            if let Some(h) = done.hint {
                assert!(
                    !h.contains("/tmp")
                        && !h.contains("/Users")
                        && !h.starts_with("http://")
                        && !h.starts_with("https://"),
                    "leaked path/URL in hint: {h} (variant: {err:?})"
                );
            }
        }
    }

    #[test]
    fn test_clone_done_err_code_matches_kira_error_code() {
        // CloneDoneErr.code must match the variant's KiraError::code() since
        // frontend dispatch table is keyed by SPEC.md ErrorVariant strings.
        let cases: &[KiraError] = &[
            KiraError::DestExists,
            KiraError::InsufficientDiskSpace,
            KiraError::Cancelled,
            KiraError::AuthFailed,
            KiraError::NetworkError,
            KiraError::CloneInProgress,
        ];
        for err in cases {
            let done = clone_done_err_from(err);
            assert_eq!(done.code, err.code(), "code mismatch for {err:?}");
        }
    }

    #[test]
    fn test_clone_done_err_clone_in_progress_has_hint() {
        // Codex review finding: CloneInProgress is a recovery-actionable error so
        // the hint must guide the user (wait or cancel existing clone).
        let done = clone_done_err_from(&KiraError::CloneInProgress);
        assert_eq!(done.code, "CLONE_IN_PROGRESS");
        assert!(done.hint.is_some(), "CloneInProgress must carry a hint");
        let hint = done.hint.unwrap();
        assert!(
            hint.contains("cancel") || hint.contains("finish") || hint.contains("Wait"),
            "hint should mention wait/cancel/finish: got {hint}"
        );
    }
}
