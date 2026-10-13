use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::error::{KiraError, Result};
use crate::git::branch;
use git2::{
    build::CheckoutBuilder, BranchType, Cred, CredentialType, ErrorClass, ErrorCode, FetchOptions,
    PushOptions, RemoteCallbacks, Repository, RepositoryState, StatusOptions,
};
use serde::Serialize;
use url::Url;

// MAX_REF_NAME_LEN intentionally mirrors `branch::MAX_REF_NAME_LEN` (256) for
// `validate_remote_name`. The branch-name path delegates to `branch::validate_branch_name`,
// so the cap there is authoritative and not duplicated.
const MAX_REF_NAME_LEN: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteOp {
    Push,
    Pull,
    Clone,
}

/// Per-branch sync state vs. its upstream.
///
/// `has_upstream=false` covers three cases (all returned silently, not as Err):
/// - unborn HEAD（fresh repo with no commits）
/// - detached HEAD（not on any branch）
/// - branch has no configured upstream（never pushed, or upstream cleared）
///
/// `ahead`/`behind` reflect the local cached `refs/remotes/{remote}/{branch}` state —
/// they DO NOT trigger a fetch. Stale until a fetch / pull / T9d watcher invalidates.
///
/// `tracking_ref_exists` (same meaning as `branch::BranchUpstream`'s) tells the
/// degraded state apart from "in sync": both are `0 / 0 / has_upstream=true`, but
/// when it is false the counts are unavailable, not zero — the upstream is
/// configured yet cannot be resolved (remote-tracking ref pruned or missing, or
/// either side has no target). Always false without an upstream.
///
/// `upstream_remote` / `upstream_branch` say where the upstream lives: the
/// branch's `branch.{name}.remote` ("origin", or "." for a local branch) and its
/// name there (`branch.{name}.merge` without `refs/heads/`). The counts describe
/// that branch, which is not necessarily where push / pull go — the frontend
/// pushes to its chosen remote's same-name branch, so in a fork workflow (tracking
/// upstream/main, pushing to origin) 0 / 0 does not mean nothing to push. Read from
/// config, so known even when the tracking ref is pruned; None without an upstream
/// or when a value is missing or not UTF-8.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct AheadBehindInfo {
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
    pub tracking_ref_exists: bool,
    pub upstream_remote: Option<String>,
    pub upstream_branch: Option<String>,
}

/// Where a branch's configured upstream lives: (remote, branch name on it).
type UpstreamLocation = (Option<String>, Option<String>);

impl AheadBehindInfo {
    fn no_upstream() -> Self {
        Self {
            ahead: 0,
            behind: 0,
            has_upstream: false,
            tracking_ref_exists: false,
            upstream_remote: None,
            upstream_branch: None,
        }
    }

    /// Upstream config exists but the remote-tracking ref / OID is unresolvable
    /// (pruned, missing, or branch missing target). Distinct from `no_upstream`
    /// so callers don't trigger set_upstream on a configured branch, and from an
    /// in-sync branch by `tracking_ref_exists`.
    fn upstream_unresolvable((upstream_remote, upstream_branch): UpstreamLocation) -> Self {
        Self {
            ahead: 0,
            behind: 0,
            has_upstream: true,
            tracking_ref_exists: false,
            upstream_remote,
            upstream_branch,
        }
    }
}

/// Returns true iff the branch has `branch.{name}.remote` + `branch.{name}.merge`
/// configured. Distinct from `Branch::upstream()` which can also fail when the
/// remote-tracking ref is pruned/missing — that case must be treated as
/// "configured but unresolvable" rather than "no config".
fn has_upstream_config(repo: &Repository, branch: &str) -> bool {
    let refname = format!("refs/heads/{branch}");
    repo.branch_upstream_name(&refname).is_ok()
}

/// `branch.{name}.remote` and `branch.{name}.merge` (without `refs/heads/`), read
/// from config so they are known even when the remote-tracking ref is pruned.
fn upstream_location(repo: &Repository, branch: &str) -> UpstreamLocation {
    let remote = repo
        .branch_upstream_remote(&format!("refs/heads/{branch}"))
        .ok()
        .and_then(|buf| buf.as_str().map(String::from));
    let merge = repo
        .config()
        .and_then(|config| config.get_string(&format!("branch.{branch}.merge")))
        .ok()
        .map(|merge| {
            merge
                .strip_prefix("refs/heads/")
                .unwrap_or(&merge)
                .to_string()
        });
    (remote, merge)
}

/// Compute `(ahead, behind)` between current branch's HEAD and its configured upstream.
///
/// Read-only; safe to call without `write_lock`. Does not fetch — caller is responsible
/// for ensuring `refs/remotes/{remote}/{branch}` is fresh enough for the use case.
///
/// `has_upstream` reflects whether **upstream config** exists, not whether the
/// remote-tracking ref currently resolves. If config exists but the ref is pruned
/// or missing, returns `has_upstream=true` with `ahead=0, behind=0` (degraded
/// state — pull will re-fetch and a subsequent ahead_behind call will be accurate).
pub fn ahead_behind(repo: &Repository) -> Result<AheadBehindInfo> {
    let Ok(head_ref) = repo.head() else {
        // unborn HEAD — no commits yet, so no branch to compare
        return Ok(AheadBehindInfo::no_upstream());
    };
    let Some(branch_name) = head_ref.shorthand() else {
        // detached HEAD with no resolvable shorthand
        return Ok(AheadBehindInfo::no_upstream());
    };
    if !head_ref.is_branch() {
        // detached HEAD where shorthand resolves to a commit-ish, not a branch
        return Ok(AheadBehindInfo::no_upstream());
    }

    // Distinguish "no upstream config" (truly absent) from "config exists but
    // ref unresolvable" — the latter must NOT be reported as has_upstream=false,
    // otherwise push() with set_upstream=true would silently overwrite the config.
    if !has_upstream_config(repo, branch_name) {
        return Ok(AheadBehindInfo::no_upstream());
    }

    let Ok(local_branch) = repo.find_branch(branch_name, BranchType::Local) else {
        return Ok(AheadBehindInfo::no_upstream());
    };
    let location = upstream_location(repo, branch_name);

    // Config exists. Try to resolve upstream ref; if pruned/missing, return
    // degraded state (has_upstream=true, ahead=0, behind=0) so caller knows
    // tracking is configured even though counts are unavailable.
    let Ok(upstream) = local_branch.upstream() else {
        return Ok(AheadBehindInfo::upstream_unresolvable(location));
    };

    let Some(local_oid) = local_branch.get().target() else {
        return Ok(AheadBehindInfo::upstream_unresolvable(location));
    };
    let Some(upstream_oid) = upstream.get().target() else {
        return Ok(AheadBehindInfo::upstream_unresolvable(location));
    };

    let (ahead, behind) = repo
        .graph_ahead_behind(local_oid, upstream_oid)
        .map_err(|e| classify_git_error(&e, RemoteOp::Push))?;

    let (upstream_remote, upstream_branch) = location;
    Ok(AheadBehindInfo {
        ahead: ahead.min(u32::MAX as usize) as u32,
        behind: behind.min(u32::MAX as usize) as u32,
        has_upstream: true,
        tracking_ref_exists: true,
        upstream_remote,
        upstream_branch,
    })
}

/// Map git2::Error → KiraError 按階層。
/// 未匹配時走 redacted `Git` variant（既有 Serialize 遮蔽機制負責不洩漏訊息）。
///
/// **Cancel classify 紀律 (T11a)**: clone 的 `CANCELLED` 不靠這
/// 個函式 — git2-rs 0.19 把 `transfer_progress` return false 變成 C callback
/// return -1（非 `GIT_EUSER`），error code 是 generic 不可靠。clone caller 必須
/// 在呼叫本函式 *前* 先檢查 `cancel_observed_in_callback: AtomicBool`，true 時
/// 直接返回 `KiraError::Cancelled`，false 時才走本函式分類。
///
/// **DestExists / InsufficientDiskSpace 為 op-agnostic**：libgit2 對非空 dest
/// 回 `ErrorCode::Exists`，ENOSPC 經 `ErrorClass::Os` 含跨平台 message。Push/Pull
/// 撞到這兩種雖罕見但語義上仍對應「目標已存在」/「磁碟滿」，不專屬 Clone。
pub fn classify_git_error(err: &git2::Error, op: RemoteOp) -> KiraError {
    let code = err.code();
    let class = err.class();

    if matches!(code, ErrorCode::Auth) {
        return KiraError::AuthFailed;
    }

    if matches!(op, RemoteOp::Push) && matches!(code, ErrorCode::NotFastForward) {
        return KiraError::PushRejected;
    }

    if matches!(op, RemoteOp::Pull)
        && matches!(
            code,
            ErrorCode::Conflict
                | ErrorCode::MergeConflict
                | ErrorCode::Uncommitted
                | ErrorCode::IndexDirty
        )
    {
        return KiraError::MergeConflict;
    }

    if matches!(code, ErrorCode::Exists) {
        return KiraError::DestExists;
    }

    if matches!(class, ErrorClass::Os) && is_no_space_message(err.message()) {
        return KiraError::InsufficientDiskSpace;
    }

    if matches!(
        class,
        ErrorClass::Net | ErrorClass::Http | ErrorClass::Ssl | ErrorClass::Ssh
    ) || matches!(code, ErrorCode::Timeout | ErrorCode::Eof)
    {
        return KiraError::NetworkError;
    }

    KiraError::Git(git2::Error::from_str("git operation failed"))
}

/// Cross-platform ENOSPC detection from `git2::Error::message()`.
///
/// libgit2 wraps OS errors with platform-specific text. Match on substrings
/// since git2-rs Error 不暴露 errno：
/// - Linux/macOS: "No space left on device"
/// - Windows: "There is not enough space on the disk"
fn is_no_space_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("no space") || lower.contains("not enough space") || lower.contains("disk full")
}

/// Reject empty / oversize / NUL-byte 並要求 remote 已註冊在 repo。
pub fn validate_remote_name(repo: &Repository, name: &str) -> Result<()> {
    if name.is_empty() || name.len() > MAX_REF_NAME_LEN || name.contains('\0') {
        return Err(KiraError::InvalidRemote);
    }
    repo.find_remote(name)
        .map(|_| ())
        .map_err(|_| KiraError::InvalidRemote)
}

/// 驗 + open + reject SSH（vendored libgit2 沒啟用 ssh）。push/pull 共用入口。
fn open_remote<'a>(repo: &'a Repository, name: &str) -> Result<git2::Remote<'a>> {
    validate_remote_name(repo, name)?;
    let remote = repo
        .find_remote(name)
        .map_err(|_| KiraError::InvalidRemote)?;
    if remote.url().is_some_and(is_ssh_url) {
        return Err(KiraError::NetworkError);
    }
    Ok(remote)
}

/// 進度百分比 calc：current/total → 0..=100 cap，避免 transfer 報出 >100% 的邊界。
fn percent_of(current: usize, total: usize) -> u32 {
    if total == 0 {
        return 0;
    }
    ((current as u64) * 100 / total as u64).min(100) as u32
}

/// Reject empty / oversize / NUL-byte / `refs/` prefix（防 refspec 注入）並通過 libgit2 ref 名稱驗證。
/// Delegates to `branch::validate_branch_name` — single source of truth for refname rules
/// so push/pull refspec assembly stays aligned with branch creation/checkout.
pub fn validate_branch_name(name: &str) -> Result<()> {
    branch::validate_branch_name(name)
}

/// Reject SSH protocol URLs（vendored libgit2 沒啟用 ssh feature；提前回 NetworkError 比讓 libgit2 吐 raw 錯誤好）
fn is_ssh_url(url: &str) -> bool {
    url.starts_with("ssh://") || url.starts_with("git@")
}

/// 共用 credentials callback：
/// - 非 GitHub HTTPS host (allowlist) → reject。防惡意 repo 把 origin URL 改成
///   `https://attacker.example/repo.git`，誘導 git2 把 OAuth token (scope: repo + read:user)
///   送給任意第三方 server——等於 private repo 完整讀寫權外洩
/// - USER_PASS_PLAINTEXT 走 keyring token → `Cred::userpass_plaintext(token, "x-oauth-basic")`
/// - 沒 token (logout 狀態) 或 keyring 失敗 → reject，由上層 classify_git_error 落 AuthFailed
///
/// 教訓 52 解：T5 對 GitHub HTTPS 一律 reject 因為 vendored libgit2 macOS 讀不到 Homebrew
/// credential.helper；T6 拿 OAuth token 後跨 helper，路徑統一。
///
/// T11a (commit 5): `pub(crate)` so the clone engine can wire the same callback
/// into RepoBuilder fetch_options without duplicating the GitHub allowlist /
/// keyring-token resolve logic. Behaviour unchanged.
pub(crate) fn github_token_cred_callback(
    url: &str,
    _username: Option<&str>,
    allowed: CredentialType,
) -> std::result::Result<Cred, git2::Error> {
    if !is_github_https_url(url) {
        return Err(git2::Error::from_str("non-github remote rejected"));
    }
    if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
        match crate::github::auth::load_token() {
            Ok(Some(token)) => Cred::userpass_plaintext(&token, "x-oauth-basic"),
            _ => Err(git2::Error::from_str("not authenticated")),
        }
    } else {
        Err(git2::Error::from_str("authentication method unavailable"))
    }
}

/// Allowlist GitHub HTTPS hosts。只有匹配的 remote URL 才會收到 OAuth token。
/// 用 `url::Url` 解析確保 scheme/host 不被 user info 或畸形字串騙過去
/// （e.g. `https://github.com.attacker.example/...` 真實 host 是 attacker.example，
/// `https://github.com@attacker.example/...` user info 含 github.com 但 host 是 attacker.example）
fn is_github_https_url(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }
    matches!(
        parsed.host_str(),
        Some("github.com") | Some("api.github.com")
    )
}

/// Outcome of a push operation. Push success itself is signaled by `Ok(_)` —
/// `upstream_set` reports the auxiliary set-upstream attempt independently so
/// the caller can surface partial success to the user.
///
/// - `None`: caller did not request set_upstream
/// - `Some(true)`: caller requested set_upstream, and upstream is now configured
///   (either was already set, or just set successfully)
/// - `Some(false)`: caller requested set_upstream, attempted to set, but failed
///   (push itself still succeeded)
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct PushOutcome {
    pub upstream_set: Option<bool>,
}

/// T5 push 主邏輯。RemoteCallbacks `'static` lifetime 由 closure 內 capture 全 owned 資料維持。
///
/// `on_progress` 收到 percent (0..=100)；caller 負責 throttle（git/remote 不關心 emit 機制）。
///
/// `set_upstream`：push 成功後若 `true` 且分支沒 upstream **config**，呼叫
/// `Branch::set_upstream`。判定用 `branch.{name}.remote/.merge` config 而非
/// `Branch::upstream()` — 後者在 ref 被 prune 時也會 Err，會誤判 fork workflow
/// (config 存在但 ref 暫時 unresolvable) 為「無 upstream」並覆蓋既有 config。
///
/// set_upstream 失敗不 fail push（push 已生效不能 undo），改透過 `PushOutcome.upstream_set`
/// 結構化回報 caller，由 caller 決定是否提示 user。
pub fn push<F: FnMut(u32)>(
    repo: &Repository,
    remote_name: &str,
    branch: &str,
    set_upstream: bool,
    mut on_progress: F,
) -> Result<PushOutcome> {
    if repo.state() != RepositoryState::Clean {
        return Err(KiraError::RepositoryNotClean);
    }
    validate_branch_name(branch)?;
    let mut remote = open_remote(repo, remote_name)?;

    let rejected = Arc::new(AtomicBool::new(false));
    let mut callbacks = RemoteCallbacks::new();

    callbacks.credentials(github_token_cred_callback);

    let rejected_for_cb = Arc::clone(&rejected);
    callbacks.push_update_reference(move |_refname, status| {
        // 只看 status.is_some()，不解析字串內容（避免路徑/URL 洩漏，見 plan v2 教訓區）
        if status.is_some() {
            rejected_for_cb.store(true, Ordering::Relaxed);
        }
        Ok(())
    });

    callbacks.push_transfer_progress(|current, total, _bytes| {
        if total > 0 {
            on_progress(percent_of(current, total));
        }
    });

    let mut opts = PushOptions::new();
    opts.remote_callbacks(callbacks);

    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let push_result = remote.push(&[refspec.as_str()], Some(&mut opts));

    if rejected.load(Ordering::Relaxed) {
        return Err(KiraError::PushRejected);
    }
    if let Err(e) = push_result {
        return Err(classify_git_error(&e, RemoteOp::Push));
    }

    // git2 0.19 在預設 fetch refspec 下會自動更新 refs/remotes/{remote}/{branch}（教訓 51）

    let upstream_set = if set_upstream {
        // 用 has_upstream_config（看 .git/config 的 branch.{name}.remote/merge）判定，
        // 不用 Branch::upstream() — 後者在 ref pruned/missing 時也 Err，會誤判已配置
        // 的 fork workflow 為「無 upstream」並覆蓋 config。
        if has_upstream_config(repo, branch) {
            // Already configured — leave alone, report success.
            Some(true)
        } else {
            match repo.find_branch(branch, BranchType::Local) {
                Ok(mut local_branch) => {
                    let upstream_name = format!("{remote_name}/{branch}");
                    match local_branch.set_upstream(Some(&upstream_name)) {
                        Ok(()) => Some(true),
                        Err(e) => {
                            eprintln!(
                                "[kira] push succeeded but set_upstream failed: code={:?}",
                                e.code()
                            );
                            Some(false)
                        }
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[kira] push succeeded but find_branch failed for set_upstream: code={:?}",
                        e.code()
                    );
                    Some(false)
                }
            }
        }
    } else {
        None
    };

    Ok(PushOutcome { upstream_set })
}

/// Pull = fetch + fast-forward only。Diverged / normal merge 一律回 MergeConflict（不嘗試 auto-merge）。
///
/// Precondition：working tree 沒有 staged 或 unstaged tracked 變更（untracked 不阻）。
/// Unborn HEAD 場景：本地 repo 沒任何 commit 時，pull 第一次會建 `refs/heads/{branch}` 指向 remote。
pub fn pull<F: FnMut(u32)>(
    repo: &Repository,
    remote_name: &str,
    branch: &str,
    mut on_progress: F,
) -> Result<u32> {
    // 通用 git2::Error → KiraError 轉換；closure 不 capture 任何值故 Copy + Fn，可重複用於每個 .map_err。
    let classify = |e: git2::Error| classify_git_error(&e, RemoteOp::Pull);

    if repo.state() != RepositoryState::Clean {
        return Err(KiraError::RepositoryNotClean);
    }

    let mut status_opts = StatusOptions::new();
    status_opts.include_untracked(false).include_ignored(false);
    let statuses = repo.statuses(Some(&mut status_opts)).map_err(classify)?;
    if !statuses.is_empty() {
        return Err(KiraError::RepositoryNotClean);
    }

    validate_branch_name(branch)?;
    let mut remote = open_remote(repo, remote_name)?;

    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(github_token_cred_callback);
    callbacks.transfer_progress(|stats| {
        let total = stats.total_objects();
        if total > 0 {
            on_progress(percent_of(stats.received_objects(), total));
        }
        true
    });

    let refspec = format!("+refs/heads/{branch}:refs/remotes/{remote_name}/{branch}");
    let mut fetch_opts = FetchOptions::new();
    fetch_opts.remote_callbacks(callbacks);

    remote
        .fetch(
            &[refspec.as_str()],
            Some(&mut fetch_opts),
            Some("kira pull"),
        )
        .map_err(classify)?;

    let remote_ref_name = format!("refs/remotes/{remote_name}/{branch}");
    let remote_ref = repo.find_reference(&remote_ref_name).map_err(classify)?;
    let remote_oid = remote_ref.target().ok_or(KiraError::MergeConflict)?;
    let annotated = repo
        .reference_to_annotated_commit(&remote_ref)
        .map_err(classify)?;

    let local_ref_name = format!("refs/heads/{branch}");

    // Codex finding 1+2：先 checkout_tree(safe) 再 advance ref。
    // - safe mode 會 reject untracked overwrite（避免靜默覆蓋使用者未提交的同名檔案）
    // - 若 checkout 失敗，ref 還沒動，repo 保持 transactional consistency
    let target_commit = repo.find_commit(remote_oid).map_err(classify)?;
    let target_tree = target_commit.tree().map_err(classify)?;
    let mut co = CheckoutBuilder::new();
    co.safe();

    // Unborn HEAD：第一次 pull 拉初始 commit 過來
    if repo.head().is_err() {
        repo.checkout_tree(target_tree.as_object(), Some(&mut co))
            .map_err(classify)?;
        repo.reference(
            &local_ref_name,
            remote_oid,
            false,
            "kira pull: initial fast-forward",
        )
        .map_err(classify)?;
        repo.set_head(&local_ref_name).map_err(classify)?;
        return count_new_commits(repo, remote_oid, None);
    }

    let (analysis, _) = repo.merge_analysis(&[&annotated]).map_err(classify)?;

    if analysis.is_up_to_date() {
        return Ok(0);
    }

    if analysis.is_fast_forward() {
        let old_head = repo.head().ok().and_then(|h| h.target());

        repo.checkout_tree(target_tree.as_object(), Some(&mut co))
            .map_err(classify)?;

        let mut local_ref = repo.find_reference(&local_ref_name).map_err(classify)?;
        local_ref
            .set_target(remote_oid, "kira pull: fast-forward")
            .map_err(classify)?;
        repo.set_head(&local_ref_name).map_err(classify)?;

        // 算 fast-forward 加進來的 commits：walk remote_oid 並 hide old_head 的 ancestors
        return count_new_commits(repo, remote_oid, old_head);
    }

    // Normal merge / 其他 → MergeConflict（fetch 已生效，remote-tracking ref 已更新）
    Err(KiraError::MergeConflict)
}

/// 用 revwalk 算 `target` 比 `hide` 多多少 commits（hide=None 等於整條 chain count）。
fn count_new_commits(repo: &Repository, target: git2::Oid, hide: Option<git2::Oid>) -> Result<u32> {
    let classify = |e: git2::Error| classify_git_error(&e, RemoteOp::Pull);
    let mut walk = repo.revwalk().map_err(classify)?;
    walk.push(target).map_err(classify)?;
    if let Some(old) = hide {
        walk.hide(old).map_err(classify)?;
    }
    Ok(walk.count() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn init_repo() -> (TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        (dir, repo)
    }

    fn make_err(code: ErrorCode, class: ErrorClass) -> git2::Error {
        git2::Error::new(code, class, "synthetic test error")
    }

    // ==== Phase 2 fixtures（push/pull integration tests 用）====

    fn init_test_repo_with_config() -> (TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        (dir, repo)
    }

    fn init_bare_remote() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        Repository::init_bare(dir.path()).unwrap();
        dir
    }

    /// 拼 `file://{path}` 只在 Unix 剛好合法（絕對路徑以 `/` 開頭）；Windows 會得到
    /// `file://C:\...`，libgit2 把整串當成路徑而找不到 repo
    fn file_url(path: &std::path::Path) -> String {
        url::Url::from_file_path(path).unwrap().to_string()
    }

    fn add_origin_remote(repo: &Repository, bare_dir: &TempDir) {
        let url = file_url(bare_dir.path());
        repo.remote("origin", &url).unwrap();
    }

    fn commit_in(repo: &Repository, rel_path: &str, content: &str, msg: &str) -> git2::Oid {
        use std::fs;
        use std::path::Path;
        let workdir = repo.workdir().unwrap();
        fs::write(workdir.join(rel_path), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(rel_path)).unwrap();
        let tree_oid = index.write_tree().unwrap();
        // 同步 in-memory index 到 disk，否則後續 checkout_tree 看到 stale disk index 會誤報 conflict
        index.write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("test", "test@example.com").unwrap();
        let parent_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent_commit.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap()
    }

    fn current_branch(repo: &Repository) -> String {
        repo.head().unwrap().shorthand().unwrap().to_string()
    }

    fn clone_into_working(bare_dir: &TempDir) -> (TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let url = file_url(bare_dir.path());
        let repo = Repository::clone(&url, dir.path()).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        (dir, repo)
    }

    #[test]
    fn test_classify_auth_returns_auth_failed_regardless_of_op() {
        let err = make_err(ErrorCode::Auth, ErrorClass::Http);
        assert!(matches!(
            classify_git_error(&err, RemoteOp::Push),
            KiraError::AuthFailed
        ));
        assert!(matches!(
            classify_git_error(&err, RemoteOp::Pull),
            KiraError::AuthFailed
        ));
    }

    #[test]
    fn test_classify_not_fast_forward_in_push_returns_rejected() {
        let err = make_err(ErrorCode::NotFastForward, ErrorClass::Reference);
        assert!(matches!(
            classify_git_error(&err, RemoteOp::Push),
            KiraError::PushRejected
        ));
    }

    #[test]
    fn test_classify_not_fast_forward_in_pull_does_not_return_rejected() {
        // Pull 期間 NotFastForward 不該被誤判為 push reject
        let err = make_err(ErrorCode::NotFastForward, ErrorClass::Reference);
        let result = classify_git_error(&err, RemoteOp::Pull);
        assert!(!matches!(result, KiraError::PushRejected));
    }

    #[test]
    fn test_classify_conflict_codes_in_pull_return_merge_conflict() {
        // git2 0.19 quirk：`Error::new(ErrorCode::MergeConflict, ...)` 構造後 `code()` 回
        // `GenericError`（無法 round-trip）。Conflict / Uncommitted / IndexDirty 正常。
        // production 路徑仍保留 MergeConflict 分流，等真實 libgit2 吐 MergeConflict 時生效；
        // 整合驗證在 Phase 2 真實 pull 衝突場景做。
        for code in [
            ErrorCode::Conflict,
            ErrorCode::Uncommitted,
            ErrorCode::IndexDirty,
        ] {
            let err = make_err(code, ErrorClass::Index);
            assert!(
                matches!(
                    classify_git_error(&err, RemoteOp::Pull),
                    KiraError::MergeConflict
                ),
                "code {code:?} 應分流為 MergeConflict"
            );
        }
    }

    #[test]
    fn test_classify_exists_returns_dest_exists_op_agnostic() {
        // T11a：libgit2 對非空 dest 回 ErrorCode::Exists，需 map 到
        // DestExists 而非 fallback GIT_ERROR。op-agnostic（Push/Pull 撞 Exists
        // 罕見但語義仍對應「目標已存在」，沿用同 variant）。
        let err = make_err(ErrorCode::Exists, ErrorClass::Invalid);
        for op in [RemoteOp::Push, RemoteOp::Pull] {
            assert!(
                matches!(classify_git_error(&err, op), KiraError::DestExists),
                "expected DestExists for op {op:?}"
            );
        }
    }

    #[test]
    fn test_classify_os_class_with_enospc_message_returns_insufficient_disk_space() {
        // T11a：libgit2 寫 packfile 時 ENOSPC 被 ErrorClass::Os 包，
        // 跨平台 message 各異（Linux/macOS "No space left", Windows "not enough space"）
        let cases = [
            "No space left on device",
            "There is not enough space on the disk",
            "Disk full",
            // 大小寫不保證 — libgit2 message 不約定 case 規則
            "no space left",
            "NOT ENOUGH SPACE",
        ];
        for message in cases {
            let err = git2::Error::new(ErrorCode::GenericError, ErrorClass::Os, message);
            assert!(
                matches!(
                    classify_git_error(&err, RemoteOp::Push),
                    KiraError::InsufficientDiskSpace
                ),
                "expected InsufficientDiskSpace for OS message {message:?}"
            );
        }
    }

    #[test]
    fn test_classify_os_class_with_other_message_does_not_return_disk_space() {
        // Os class 但非 ENOSPC message → 不該誤判為 InsufficientDiskSpace
        let err = git2::Error::new(ErrorCode::GenericError, ErrorClass::Os, "permission denied");
        let result = classify_git_error(&err, RemoteOp::Push);
        assert!(
            !matches!(result, KiraError::InsufficientDiskSpace),
            "non-ENOSPC OS error must not map to InsufficientDiskSpace: got {result:?}"
        );
    }

    #[test]
    fn test_classify_net_class_returns_network_error() {
        for class in [
            ErrorClass::Net,
            ErrorClass::Http,
            ErrorClass::Ssl,
            ErrorClass::Ssh,
        ] {
            let err = make_err(ErrorCode::GenericError, class);
            assert!(
                matches!(
                    classify_git_error(&err, RemoteOp::Push),
                    KiraError::NetworkError
                ),
                "class {class:?} 應分流為 NetworkError"
            );
        }
        // Timeout / Eof 不論 class 都算 network
        let timeout = make_err(ErrorCode::Timeout, ErrorClass::Os);
        assert!(matches!(
            classify_git_error(&timeout, RemoteOp::Push),
            KiraError::NetworkError
        ));
        let eof = make_err(ErrorCode::Eof, ErrorClass::Os);
        assert!(matches!(
            classify_git_error(&eof, RemoteOp::Pull),
            KiraError::NetworkError
        ));
    }

    #[test]
    fn test_classify_unknown_falls_back_to_redacted_git() {
        let err = make_err(ErrorCode::GenericError, ErrorClass::Os);
        let kira = classify_git_error(&err, RemoteOp::Push);
        assert!(matches!(kira, KiraError::Git(_)));
    }

    #[test]
    fn test_validate_remote_name_empty_returns_invalid_remote() {
        let (_dir, repo) = init_repo();
        assert!(matches!(
            validate_remote_name(&repo, ""),
            Err(KiraError::InvalidRemote)
        ));
    }

    #[test]
    fn test_validate_remote_name_oversize_returns_invalid_remote() {
        let (_dir, repo) = init_repo();
        let huge = "a".repeat(MAX_REF_NAME_LEN + 1);
        assert!(matches!(
            validate_remote_name(&repo, &huge),
            Err(KiraError::InvalidRemote)
        ));
    }

    #[test]
    fn test_validate_remote_name_unknown_returns_invalid_remote() {
        let (_dir, repo) = init_repo();
        // 沒註冊任何 remote，find_remote 會 fail
        assert!(matches!(
            validate_remote_name(&repo, "origin"),
            Err(KiraError::InvalidRemote)
        ));
    }

    #[test]
    fn test_validate_remote_name_known_returns_ok() {
        let (_dir, repo) = init_repo();
        repo.remote("origin", "file:///tmp/none").unwrap();
        assert!(validate_remote_name(&repo, "origin").is_ok());
    }

    #[test]
    fn test_validate_branch_name_rejects_empty_nul_oversize_refs_prefix_and_invalid_chars() {
        assert!(matches!(
            validate_branch_name(""),
            Err(KiraError::InvalidBranchName)
        ));
        assert!(matches!(
            validate_branch_name("foo\0bar"),
            Err(KiraError::InvalidBranchName)
        ));
        let huge = "a".repeat(MAX_REF_NAME_LEN + 1);
        assert!(matches!(
            validate_branch_name(&huge),
            Err(KiraError::InvalidBranchName)
        ));
        assert!(matches!(
            validate_branch_name("refs/heads/main"),
            Err(KiraError::InvalidBranchName)
        ));
        // 含空白的名字 libgit2 會 reject
        assert!(matches!(
            validate_branch_name("foo bar"),
            Err(KiraError::InvalidBranchName)
        ));
        // `:` 是 refspec 分隔字元；branch name 含 `:` 會被 git2 reject。
        // 顯式測試以鎖死 refspec injection 攻擊面（`branch=main:refs/heads/evil` 假想場景）。
        assert!(matches!(
            validate_branch_name("foo:bar"),
            Err(KiraError::InvalidBranchName)
        ));
    }

    #[test]
    fn test_validate_branch_name_accepts_normal_names() {
        assert!(validate_branch_name("main").is_ok());
        assert!(validate_branch_name("feat/t5-push-pull").is_ok());
        assert!(validate_branch_name("release-1.2.3").is_ok());
    }

    #[test]
    fn test_validate_branch_name_accepts_plus_prefix_intent() {
        // libgit2 `check-ref-format` 允許 `+` 開頭的 branch 名（如 `+main`）。
        // 我們的 refspec 模板是 `refs/heads/{name}:refs/heads/{name}`，`:` 在
        // validate 階段已 reject（refs/heads/ prefix 也已 reject），所以 `+main`
        // 不能擴展成 force-push refspec。Intent test：未來若要把 `+` 加進 blocklist
        // 必須先重檢 refspec 組裝路徑，避免破壞 user 真的有 `+` 開頭 branch 的場景。
        assert!(validate_branch_name("+main").is_ok());
    }

    // ==== Phase 2 push/pull integration tests ====

    #[test]
    fn test_push_to_local_bare_succeeds_and_updates_remote_ref() {
        let (_local_dir, local) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&local, &bare_dir);
        let oid = commit_in(&local, "a.txt", "A", "init");
        let branch = current_branch(&local);

        push(&local, "origin", &branch, false, |_| {}).unwrap();

        // libgit2 預設 fetch refspec 自動更新 remote-tracking ref（教訓 51）
        let remote_ref = local
            .find_reference(&format!("refs/remotes/origin/{branch}"))
            .unwrap();
        assert_eq!(remote_ref.target(), Some(oid));
    }

    #[test]
    fn test_push_non_fast_forward_returns_rejected() {
        // Setup：local1 push A → bare = A；local2 clone bare push B → bare = B；local1 commit C 後 push → reject
        let (_d1, local1) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&local1, &bare_dir);
        let _a = commit_in(&local1, "a.txt", "A", "A");
        let branch = current_branch(&local1);
        push(&local1, "origin", &branch, false, |_| {}).unwrap();

        let (_d2, local2) = clone_into_working(&bare_dir);
        let _b = commit_in(&local2, "b.txt", "B", "B");
        push(&local2, "origin", &branch, false, |_| {}).unwrap();

        let _c = commit_in(&local1, "c.txt", "C", "C");
        let result = push(&local1, "origin", &branch, false, |_| {});
        assert!(
            matches!(result, Err(KiraError::PushRejected)),
            "expected PushRejected, got {result:?}"
        );
    }

    #[test]
    fn test_push_unknown_remote_returns_invalid_remote() {
        let (_d, repo) = init_test_repo_with_config();
        let _ = commit_in(&repo, "a.txt", "A", "A");
        let result = push(&repo, "nonexistent", "main", false, |_| {});
        assert!(matches!(result, Err(KiraError::InvalidRemote)));
    }

    #[test]
    fn test_push_invalid_branch_name_rejected_before_refspec() {
        // 「refs/heads/main」是被禁的（防 refspec 注入）；應在 validate_branch_name 階段就 fail，
        // 不會走到 git2::Remote::push
        let (_d, repo) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&repo, &bare_dir);
        let _ = commit_in(&repo, "a.txt", "A", "A");
        let result = push(&repo, "origin", "refs/heads/main", false, |_| {});
        assert!(matches!(result, Err(KiraError::InvalidBranchName)));
    }

    #[test]
    fn test_push_during_merge_state_returns_repository_not_clean() {
        let (dir, repo) = init_test_repo_with_config();
        let _ = commit_in(&repo, "a.txt", "A", "A");
        // 模擬 merge 進行中：寫 .git/MERGE_HEAD（git2 透過此檔案判斷 RepositoryState）
        std::fs::write(
            dir.path().join(".git/MERGE_HEAD"),
            "0000000000000000000000000000000000000000\n",
        )
        .unwrap();

        let bare_dir = init_bare_remote();
        add_origin_remote(&repo, &bare_dir);
        let branch = current_branch(&repo);
        let result = push(&repo, "origin", &branch, false, |_| {});
        assert!(matches!(result, Err(KiraError::RepositoryNotClean)));
    }

    #[test]
    fn test_pull_up_to_date_returns_zero() {
        let (_d, local) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&local, &bare_dir);
        let _ = commit_in(&local, "a.txt", "A", "A");
        let branch = current_branch(&local);
        push(&local, "origin", &branch, false, |_| {}).unwrap();

        let count = pull(&local, "origin", &branch, |_| {}).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_pull_fast_forward_advances_local_and_returns_count() {
        // local1 push A → bare = A；local2 commit B + C push → bare = C；local1 pull 應 ff 並回 2
        let (_d1, local1) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&local1, &bare_dir);
        let _a = commit_in(&local1, "a.txt", "A", "A");
        let branch = current_branch(&local1);
        push(&local1, "origin", &branch, false, |_| {}).unwrap();

        let (_d2, local2) = clone_into_working(&bare_dir);
        let _b = commit_in(&local2, "b.txt", "B", "B");
        let oid_c = commit_in(&local2, "c.txt", "C", "C");
        push(&local2, "origin", &branch, false, |_| {}).unwrap();

        let count = pull(&local1, "origin", &branch, |_| {}).unwrap();
        assert_eq!(count, 2, "expected 2 commits added (B, C)");
        assert_eq!(local1.head().unwrap().target(), Some(oid_c));
    }

    #[test]
    fn test_pull_unborn_head_initial_fast_forward_succeeds() {
        // bare 已有 main:A（透過 producer push 進去）；fresh repo unborn HEAD pull 應建 refs/heads/main
        let (_dp, producer) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&producer, &bare_dir);
        let oid_a = commit_in(&producer, "a.txt", "A", "A");
        let producer_branch = current_branch(&producer);
        push(&producer, "origin", &producer_branch, false, |_| {}).unwrap();

        let (_dl, local) = init_test_repo_with_config();
        add_origin_remote(&local, &bare_dir);
        // local 仍 unborn
        assert!(local.head().is_err());

        let count = pull(&local, "origin", &producer_branch, |_| {}).unwrap();
        assert_eq!(count, 1);
        assert_eq!(local.head().unwrap().target(), Some(oid_a));
    }

    #[test]
    fn test_pull_diverged_returns_merge_conflict_local_unchanged() {
        let (_d1, local1) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&local1, &bare_dir);
        let _a = commit_in(&local1, "a.txt", "A", "A");
        let branch = current_branch(&local1);
        push(&local1, "origin", &branch, false, |_| {}).unwrap();

        let (_d2, local2) = clone_into_working(&bare_dir);
        let _b = commit_in(&local2, "b.txt", "B", "B");
        push(&local2, "origin", &branch, false, |_| {}).unwrap();

        let oid_c = commit_in(&local1, "c.txt", "C", "C");
        let head_before = local1.head().unwrap().target();

        let result = pull(&local1, "origin", &branch, |_| {});
        assert!(matches!(result, Err(KiraError::MergeConflict)));
        // 本地 HEAD 不變
        assert_eq!(local1.head().unwrap().target(), head_before);
        assert_eq!(local1.head().unwrap().target(), Some(oid_c));
        // remote-tracking ref 仍應已被 fetch 更新到 B（diverged 狀態）
        assert!(local1
            .find_reference(&format!("refs/remotes/origin/{branch}"))
            .is_ok());
    }

    #[test]
    fn test_pull_dirty_tracked_changes_returns_repository_not_clean() {
        let (dir, local) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&local, &bare_dir);
        let _ = commit_in(&local, "a.txt", "A", "A");
        let branch = current_branch(&local);
        push(&local, "origin", &branch, false, |_| {}).unwrap();

        // 改動 tracked 檔但不 stage
        std::fs::write(dir.path().join("a.txt"), "modified content").unwrap();

        let result = pull(&local, "origin", &branch, |_| {});
        assert!(matches!(result, Err(KiraError::RepositoryNotClean)));
    }

    #[test]
    fn test_pull_dirty_untracked_only_succeeds() {
        let (dir, local) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&local, &bare_dir);
        let _ = commit_in(&local, "a.txt", "A", "A");
        let branch = current_branch(&local);
        push(&local, "origin", &branch, false, |_| {}).unwrap();

        // 加 untracked file（未 stage、不在 .gitignore）
        std::fs::write(dir.path().join("untracked.txt"), "hi").unwrap();

        // pull 應該成功（沒新東西，up-to-date）→ untracked 不阻
        let count = pull(&local, "origin", &branch, |_| {}).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_pull_untracked_collision_with_remote_new_file_aborts_without_advancing_ref() {
        // Codex finding 1 regression：local 有 untracked b.txt（未提交本地內容），
        // remote 有同名 b.txt 在新 commit 中。pull 的 fast-forward 應該被 safe() checkout 阻擋，
        // 不能靜默覆蓋本地未提交內容；ref 也不能 advance。
        let (_d1, local1) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&local1, &bare_dir);
        let oid_a = commit_in(&local1, "a.txt", "A", "A");
        let branch = current_branch(&local1);
        push(&local1, "origin", &branch, false, |_| {}).unwrap();

        // local2 commit B 加 b.txt，push 上去
        let (_d2, local2) = clone_into_working(&bare_dir);
        let _ = commit_in(&local2, "b.txt", "from-remote", "B");
        push(&local2, "origin", &branch, false, |_| {}).unwrap();

        // local1 加同名 untracked b.txt（未 stage、未 commit）
        std::fs::write(
            local1.workdir().unwrap().join("b.txt"),
            "local-uncommitted-content",
        )
        .unwrap();

        let result = pull(&local1, "origin", &branch, |_| {});
        // 應拒絕：classify_git_error 對 Checkout class / Conflict code 會回 MergeConflict
        assert!(
            result.is_err(),
            "expected error to protect untracked file, got {result:?}"
        );

        // ref 不應 advance（仍指向 oid_a）
        assert_eq!(
            local1.head().unwrap().target(),
            Some(oid_a),
            "local HEAD must remain at oid_a; ref advance before checkout is a transactional bug"
        );

        // local untracked b.txt 內容沒被覆蓋
        let b_content = std::fs::read_to_string(local1.workdir().unwrap().join("b.txt")).unwrap();
        assert_eq!(b_content, "local-uncommitted-content");
    }

    #[test]
    fn test_is_github_https_url_accepts_canonical_github_https() {
        assert!(is_github_https_url("https://github.com/foo/bar.git"));
        assert!(is_github_https_url("https://github.com/"));
        assert!(is_github_https_url("https://api.github.com/repos/x/y"));
    }

    #[test]
    fn test_is_github_https_url_rejects_non_https_schemes() {
        // SSH / http / git protocol 都不該收到 OAuth token
        assert!(!is_github_https_url("http://github.com/foo/bar.git"));
        assert!(!is_github_https_url("ssh://git@github.com/foo/bar.git"));
        assert!(!is_github_https_url("git://github.com/foo/bar.git"));
        assert!(!is_github_https_url("git@github.com:foo/bar.git"));
    }

    #[test]
    fn test_is_github_https_url_rejects_typosquat_and_subdomain_attacks() {
        // host 不是正確的 github.com / api.github.com — 這些是 cred-leak 攻擊面的核心
        assert!(!is_github_https_url(
            "https://github.com.attacker.example/foo/bar.git"
        ));
        assert!(!is_github_https_url("https://attacker.example/foo/bar.git"));
        assert!(!is_github_https_url(
            "https://raw.githubusercontent.com/foo/bar"
        ));
        assert!(!is_github_https_url("https://gist.github.com/foo/bar"));
        assert!(!is_github_https_url(
            "https://github.example.com/foo/bar.git"
        ));
    }

    #[test]
    fn test_is_github_https_url_rejects_userinfo_host_spoof() {
        // user info 段含 "github.com" 但實際 host 是 attacker.example
        assert!(!is_github_https_url(
            "https://github.com@attacker.example/foo/bar.git"
        ));
    }

    #[test]
    fn test_is_github_https_url_rejects_malformed_or_empty() {
        assert!(!is_github_https_url(""));
        assert!(!is_github_https_url("not a url"));
        assert!(!is_github_https_url("https://"));
    }

    #[test]
    fn test_classify_fallback_serialize_redacts_message() {
        // 跨函式驗證：classify 走 Git fallback 後 serialize 不洩漏 source error 的路徑訊息
        let leaky = git2::Error::new(
            ErrorCode::GenericError,
            ErrorClass::Os,
            "failed at /Users/secret/path/file",
        );
        let kira = classify_git_error(&leaky, RemoteOp::Push);
        assert!(matches!(kira, KiraError::Git(_)));
        let json = serde_json::to_string(&kira).unwrap();
        assert!(!json.contains("/Users/secret"), "leaked path: {json}");
        assert!(!json.contains("failed at"), "leaked source msg: {json}");
        assert!(json.contains(r#""code":"GIT_ERROR""#));
        assert!(json.contains(r#""message":"git operation failed""#));
    }

    // ==== T9c #5 ahead_behind tests ====

    #[test]
    fn test_ahead_behind_unborn_head_returns_no_upstream() {
        // 全新 repo 沒任何 commit → repo.head() Err → 回 has_upstream=false 不 fail
        let (_dir, repo) = init_test_repo_with_config();
        assert!(repo.head().is_err());
        let info = ahead_behind(&repo).unwrap();
        assert_eq!(info, AheadBehindInfo::no_upstream());
    }

    #[test]
    fn test_ahead_behind_no_upstream_returns_no_upstream() {
        // 有 commit 但 branch 沒設 upstream → has_upstream=false
        let (_dir, repo) = init_test_repo_with_config();
        let _ = commit_in(&repo, "a.txt", "A", "A");
        let info = ahead_behind(&repo).unwrap();
        assert_eq!(info, AheadBehindInfo::no_upstream());
    }

    #[test]
    fn test_ahead_behind_in_sync_returns_zero_zero_with_upstream() {
        // local push 後即與 upstream 一致 → ahead=0, behind=0, has_upstream=true
        let (_dir, repo) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&repo, &bare_dir);
        let _ = commit_in(&repo, "a.txt", "A", "A");
        let branch = current_branch(&repo);
        // 用 set_upstream=true 一次設好
        push(&repo, "origin", &branch, true, |_| {}).unwrap();

        let info = ahead_behind(&repo).unwrap();
        assert_eq!(
            info,
            AheadBehindInfo {
                ahead: 0,
                behind: 0,
                has_upstream: true,
                tracking_ref_exists: true,
                upstream_remote: Some("origin".to_string()),
                upstream_branch: Some(branch.clone()),
            }
        );
    }

    #[test]
    fn test_ahead_behind_local_ahead_after_extra_commit() {
        // push 完再 commit → ahead=1, behind=0
        let (_dir, repo) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&repo, &bare_dir);
        let _ = commit_in(&repo, "a.txt", "A", "A");
        let branch = current_branch(&repo);
        push(&repo, "origin", &branch, true, |_| {}).unwrap();

        let _ = commit_in(&repo, "b.txt", "B", "B");
        let info = ahead_behind(&repo).unwrap();
        assert_eq!(info.ahead, 1);
        assert_eq!(info.behind, 0);
        assert!(info.has_upstream);
    }

    #[test]
    fn test_ahead_behind_local_behind_after_remote_advance() {
        // local1 push A → local2 clone push B → local1 fetch (透過 pull up-to-date 觸發)
        // 但 pull 會 ff，所以這裡用 pull diverged 場景：local1 commit C 後 local2 push B
        // → local1 ahead=1, behind=1
        let (_d1, local1) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&local1, &bare_dir);
        let _ = commit_in(&local1, "a.txt", "A", "A");
        let branch = current_branch(&local1);
        push(&local1, "origin", &branch, true, |_| {}).unwrap();

        let (_d2, local2) = clone_into_working(&bare_dir);
        let _ = commit_in(&local2, "b.txt", "B", "B");
        push(&local2, "origin", &branch, false, |_| {}).unwrap();

        let _ = commit_in(&local1, "c.txt", "C", "C");
        // pull 失敗（diverged），但 fetch 已更新 remote-tracking ref
        let _ = pull(&local1, "origin", &branch, |_| {});

        let info = ahead_behind(&local1).unwrap();
        assert_eq!(info.ahead, 1, "local1 has C not in upstream");
        assert_eq!(info.behind, 1, "upstream has B not in local1");
        assert!(info.has_upstream);
    }

    // ==== T9c #5 push set_upstream tests ====

    #[test]
    fn test_push_with_set_upstream_true_configures_upstream_on_first_push() {
        // 第一次 push set_upstream=true → branch.upstream() 應該回 Ok
        let (_dir, repo) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&repo, &bare_dir);
        let _ = commit_in(&repo, "a.txt", "A", "A");
        let branch_name = current_branch(&repo);

        // 確認 push 前沒 upstream
        let before = repo
            .find_branch(&branch_name, BranchType::Local)
            .unwrap()
            .upstream();
        assert!(before.is_err(), "expected no upstream before push");

        push(&repo, "origin", &branch_name, true, |_| {}).unwrap();

        // 確認 push 後有 upstream，且指向 origin/{branch}
        let upstream = repo
            .find_branch(&branch_name, BranchType::Local)
            .unwrap()
            .upstream()
            .expect("upstream should be set after push with set_upstream=true");
        let upstream_name = upstream.name().unwrap().unwrap().to_string();
        assert_eq!(upstream_name, format!("origin/{branch_name}"));
    }

    #[test]
    fn test_push_with_set_upstream_false_does_not_configure_upstream() {
        // set_upstream=false → branch.upstream() 仍 Err
        let (_dir, repo) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&repo, &bare_dir);
        let _ = commit_in(&repo, "a.txt", "A", "A");
        let branch_name = current_branch(&repo);

        push(&repo, "origin", &branch_name, false, |_| {}).unwrap();

        let upstream = repo
            .find_branch(&branch_name, BranchType::Local)
            .unwrap()
            .upstream();
        assert!(
            upstream.is_err(),
            "set_upstream=false should not configure upstream"
        );
    }

    #[test]
    fn test_ahead_behind_config_exists_but_ref_pruned_returns_degraded_state() {
        // Codex finding 1 regression：fork workflow 下 user 可能 prune 過 remote-tracking
        // ref（git fetch --prune）但保留 branch.{x}.remote/.merge config。此時 has_upstream
        // 必須回 true（避免 push set_upstream=true 覆蓋 config），ahead/behind 0 (degraded)。
        let (_dir, repo) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&repo, &bare_dir);
        let _ = commit_in(&repo, "a.txt", "A", "A");
        let branch = current_branch(&repo);
        push(&repo, "origin", &branch, true, |_| {}).unwrap();

        // Confirm config + ref both exist post-push
        assert!(has_upstream_config(&repo, &branch));
        let ref_name = format!("refs/remotes/origin/{branch}");
        repo.find_reference(&ref_name)
            .unwrap()
            .delete()
            .expect("delete remote-tracking ref to simulate prune");

        // Config still present, ref gone
        assert!(has_upstream_config(&repo, &branch));
        assert!(repo.find_reference(&ref_name).is_err());

        let info = ahead_behind(&repo).unwrap();
        assert_eq!(
            info,
            AheadBehindInfo {
                ahead: 0,
                behind: 0,
                has_upstream: true,
                tracking_ref_exists: false,
                // config 還在，upstream 在哪照樣讀得到
                upstream_remote: Some("origin".to_string()),
                upstream_branch: Some(branch.clone()),
            },
            "config-exists-but-ref-pruned must NOT degrade to has_upstream=false, \
             and must not read as in sync (0 / 0 with the ref present)"
        );
    }

    #[test]
    fn test_ahead_behind_reports_an_upstream_on_another_remote() {
        // Fork workflow：分支追蹤 upstream/<branch>，前端的 push / pull 卻對 origin 的同名分支。
        // upstream 與本機同步、origin 落後 1 筆 → 計數是 0 / 0，描述的不是 push 要去的地方；
        // 回報 upstream 在哪，前端才知道不能拿它判斷「沒東西可推」
        let (_dir, repo) = init_test_repo_with_config();
        let origin_dir = init_bare_remote();
        let upstream_dir = init_bare_remote();
        add_origin_remote(&repo, &origin_dir);
        let upstream_url = file_url(upstream_dir.path());
        repo.remote("upstream", &upstream_url).unwrap();
        let _ = commit_in(&repo, "a.txt", "A", "A");
        let branch = current_branch(&repo);
        push(&repo, "origin", &branch, false, |_| {}).unwrap();
        push(&repo, "upstream", &branch, true, |_| {}).unwrap();
        let _ = commit_in(&repo, "b.txt", "B", "B");
        push(&repo, "upstream", &branch, false, |_| {}).unwrap();

        let info = ahead_behind(&repo).unwrap();
        assert_eq!(
            info,
            AheadBehindInfo {
                ahead: 0,
                behind: 0,
                has_upstream: true,
                tracking_ref_exists: true,
                upstream_remote: Some("upstream".to_string()),
                upstream_branch: Some(branch.clone()),
            },
            "the counts describe upstream/{branch}, and the info must say so"
        );
    }

    #[test]
    fn test_push_outcome_set_upstream_false_returns_none() {
        // set_upstream=false → outcome.upstream_set=None (caller didn't request)
        let (_dir, repo) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&repo, &bare_dir);
        let _ = commit_in(&repo, "a.txt", "A", "A");
        let branch = current_branch(&repo);

        let outcome = push(&repo, "origin", &branch, false, |_| {}).unwrap();
        assert_eq!(outcome.upstream_set, None);
    }

    #[test]
    fn test_push_outcome_set_upstream_true_first_push_returns_some_true() {
        // set_upstream=true on a fresh branch → upstream_set=Some(true)
        let (_dir, repo) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&repo, &bare_dir);
        let _ = commit_in(&repo, "a.txt", "A", "A");
        let branch = current_branch(&repo);

        let outcome = push(&repo, "origin", &branch, true, |_| {}).unwrap();
        assert_eq!(outcome.upstream_set, Some(true));
    }

    #[test]
    fn test_push_outcome_set_upstream_true_existing_config_returns_some_true() {
        // set_upstream=true when config already exists → Some(true) (no overwrite,
        // but caller's request is satisfied since upstream is configured)
        let (_dir, repo) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&repo, &bare_dir);
        let _ = commit_in(&repo, "a.txt", "A", "A");
        let branch = current_branch(&repo);
        push(&repo, "origin", &branch, true, |_| {}).unwrap();

        let _ = commit_in(&repo, "b.txt", "B", "B");
        let outcome = push(&repo, "origin", &branch, true, |_| {}).unwrap();
        assert_eq!(outcome.upstream_set, Some(true));
    }

    #[test]
    fn test_push_with_set_upstream_true_does_not_overwrite_existing_upstream() {
        // 第二次 push set_upstream=true 不該覆蓋既有 upstream（避免 user 手動改過後被踢回 default）
        let (_dir, repo) = init_test_repo_with_config();
        let bare_dir = init_bare_remote();
        add_origin_remote(&repo, &bare_dir);
        let _ = commit_in(&repo, "a.txt", "A", "A");
        let branch_name = current_branch(&repo);

        // 第一次 push 設好 upstream
        push(&repo, "origin", &branch_name, true, |_| {}).unwrap();
        let upstream_before = repo
            .find_branch(&branch_name, BranchType::Local)
            .unwrap()
            .upstream()
            .unwrap()
            .name()
            .unwrap()
            .unwrap()
            .to_string();

        // 第二次 push 仍帶 set_upstream=true（模擬前端不知道 upstream 已存在）
        let _ = commit_in(&repo, "b.txt", "B", "B");
        push(&repo, "origin", &branch_name, true, |_| {}).unwrap();

        let upstream_after = repo
            .find_branch(&branch_name, BranchType::Local)
            .unwrap()
            .upstream()
            .unwrap()
            .name()
            .unwrap()
            .unwrap()
            .to_string();

        assert_eq!(
            upstream_before, upstream_after,
            "upstream must not be overwritten on subsequent pushes"
        );
    }
}
