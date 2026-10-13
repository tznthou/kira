//! T10 branch operations — refname validation + HEAD state helpers + case-insensitive scan.
//!
//! Helpers here are pure (no IPC, no write_lock). The commands that take write_lock
//! and state_guard live in `crate::commands::git::branch` and call into these.

use crate::error::{KiraError, Result};
use git2::{build::CheckoutBuilder, Branch, BranchType, ErrorCode, ReferenceType, Repository};
use serde::Serialize;

/// SPEC.md `git_list_branches` response. `detached_head_oid` is `Some(hex)` when
/// HEAD points at a raw commit (checked out tag / OID) and `None` otherwise —
/// the UI uses it to render a virtual "(Detached at <hex8>)" row when every
/// `BranchInfo.is_current` is false.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ListBranchesResult {
    pub branches: Vec<BranchInfo>,
    pub detached_head_oid: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<BranchUpstream>,
}

/// Distinct from `Option<String>`: `tracking_ref_exists=false` means the upstream
/// is configured in `.git/config` but the `refs/remotes/.../X` ref is missing
/// (typically pruned by `git fetch --prune`). UI shows "(pruned)" so callers do
/// not silently overwrite the config via set_upstream.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct BranchUpstream {
    pub name: String,
    pub tracking_ref_exists: bool,
}

/// SPEC.md `git_get_branch_stats` per-branch entry. `ahead`/`behind` are
/// `Option<u32>` so the IPC can return degraded `None/None` for individual
/// branches (shallow clone object missing, upstream pruned, graph compute
/// failure) without failing the whole call.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct BranchStats {
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
}

/// Refname length cap. libgit2 has no fixed upper bound, so this is a Kira-side
/// guard against pathological long names that bloat status/log lines.
/// Matches `remote::MAX_REF_NAME_LEN` so push and create paths agree.
pub const MAX_REF_NAME_LEN: usize = 256;

/// Reject empty / oversize / NUL-byte / `refs/` prefix and then defer to libgit2
/// `Branch::name_is_valid` (rejects spaces / `~^:?*[\\` / `..` / `@{` / `.lock` /
/// reserved names HEAD/FETCH_HEAD/MERGE_HEAD/ORIG_HEAD).
///
/// Three-layer validation — IPC bounds (this fn's pre-check),
/// libgit2 refname rules (`Branch::name_is_valid`), and per-repo case scan
/// ([`case_insensitive_conflict`], called separately because it needs a repo handle).
pub fn validate_branch_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > MAX_REF_NAME_LEN || name.contains('\0') {
        return Err(KiraError::InvalidBranchName);
    }
    // Reject `refs/` prefix: caller passes branch shorthand. Without this guard,
    // a user typing `refs/heads/foo` ends up creating `refs/heads/refs/heads/foo`.
    if name.starts_with("refs/") {
        return Err(KiraError::InvalidBranchName);
    }
    match Branch::name_is_valid(name) {
        Ok(true) => Ok(()),
        Ok(false) | Err(_) => Err(KiraError::InvalidBranchName),
    }
}

/// True when the repository has no commits yet (`git init` but no commit).
/// `repo.head()` returns `Err(UnbornBranch)` for this state.
pub fn head_is_unborn(repo: &Repository) -> bool {
    matches!(
        repo.head().err().map(|e| e.code()),
        Some(ErrorCode::UnbornBranch)
    )
}

/// True when HEAD is detached (checked out a tag or raw OID, not a branch).
/// Returns Err only for unborn repos — callers should check [`head_is_unborn`] first.
pub fn head_is_detached(repo: &Repository) -> Result<bool> {
    let head = repo.head()?;
    Ok(!head.is_branch())
}

/// On macOS/Windows the filesystem is case-insensitive but the ref store is
/// case-sensitive — creating `Feature/A` when `feature/a` exists triggers a
/// confusing `cannot lock ref` error from libgit2. We pre-scan for the conflict.
///
/// Returns `Ok(Some(existing_name))` when a case-insensitive match exists with
/// a different literal name (true conflict). Returns `Ok(None)` when no conflict.
/// An exact-case match returns `None` here — caller should detect that as
/// `BranchExists` separately.
pub fn case_insensitive_conflict(repo: &Repository, new_name: &str) -> Result<Option<String>> {
    let new_lower = new_name.to_lowercase();
    for entry in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = entry?;
        let Some(existing) = branch.name()? else {
            continue;
        };
        if existing == new_name {
            continue; // exact match — caller's BranchExists path
        }
        if existing.to_lowercase() == new_lower {
            return Ok(Some(existing.to_string()));
        }
    }
    Ok(None)
}

/// SPEC.md `git_list_branches`.
///
/// Read-only — caller does not take `write_lock`. Returns:
/// - All local branches with `is_current` set via libgit2 `Branch::is_head()`
/// - All remote-tracking branches with `is_remote=true` and `upstream=None`
///   (remote rows are read-only in T10 v1 — see the SPEC.md `git_list_branches` note)
/// - `detached_head_oid=Some(hex)` when HEAD is checked out at a raw OID (the
///   sidebar draws no row for it; the sign reads a detached HEAD from the graph)
/// - `upstream.tracking_ref_exists=false` when `.git/config` records an upstream
///   but `refs/remotes/.../X` is missing (typically pruned). UI shows "(pruned)"
///   so set_upstream paths do not overwrite the config
pub fn list_branches(repo: &Repository) -> Result<ListBranchesResult> {
    let detached_head_oid = if head_is_unborn(repo) {
        None
    } else if head_is_detached(repo)? {
        repo.head()?.target().map(|o| o.to_string())
    } else {
        None
    };

    let mut branches = Vec::new();
    for entry in repo.branches(None)? {
        let (branch, btype) = entry?;
        // origin/HEAD 這類符號參照只是指標，不是分支：不能 checkout、不該刪。
        // graph 的 collect_branches 本來就跳過（符號參照沒有 target），這裡對齊。
        if branch.get().kind() == Some(ReferenceType::Symbolic) {
            continue;
        }
        let Some(name) = branch.name()?.map(String::from) else {
            continue;
        };
        let is_remote = matches!(btype, BranchType::Remote);
        // is_head() on a remote-tracking branch always returns false — only
        // local branches can be HEAD. is_current is therefore correct for both.
        let is_current = branch.is_head();
        let upstream = if is_remote {
            None
        } else {
            local_upstream(repo, &name)?
        };
        branches.push(BranchInfo {
            name,
            is_current,
            is_remote,
            upstream,
        });
    }
    Ok(ListBranchesResult {
        branches,
        detached_head_oid,
    })
}

/// SPEC.md `git_get_branch_stats`.
///
/// Lazy companion to [`list_branches`]: caller passes only the branches that
/// are currently visible (≤20 / batch suggested) and gets per-branch ahead/behind
/// counts. Failure modes are per-branch, never per-call:
/// - Branch name not found in this repo → key omitted from the result map
/// - No upstream config → key present with `ahead=None, behind=None`
/// - Upstream ref pruned or shallow object missing → same `None/None`
///
/// Caller can therefore render a list and progressively populate stats without
/// the IPC ever returning a hard error for individual entries. Read-only.
pub fn get_branch_stats(
    repo: &Repository,
    branch_names: &[String],
) -> Result<std::collections::HashMap<String, BranchStats>> {
    let mut result = std::collections::HashMap::with_capacity(branch_names.len());
    for name in branch_names {
        let Ok(local_branch) = repo.find_branch(name, BranchType::Local) else {
            // SPEC: missing key = name not found in this call
            continue;
        };
        let stats = compute_stats(repo, name, &local_branch);
        result.insert(name.clone(), stats);
    }
    Ok(result)
}

fn compute_stats(repo: &Repository, branch_name: &str, local: &Branch<'_>) -> BranchStats {
    // Any degraded path (no upstream config, pruned ref, missing OID, shallow
    // clone object gone) returns this sentinel rather than failing the whole
    // IPC — SPEC.md `git_get_branch_stats` per-branch degradation policy.
    const DEGRADED: BranchStats = BranchStats {
        ahead: None,
        behind: None,
    };
    let head_ref = format!("refs/heads/{branch_name}");
    let Ok(upstream_buf) = repo.branch_upstream_name(&head_ref) else {
        return DEGRADED;
    };
    let Some(upstream_full) = upstream_buf.as_str() else {
        return DEGRADED;
    };
    let Ok(upstream_ref) = repo.find_reference(upstream_full) else {
        return DEGRADED;
    };
    let (Some(local_oid), Some(upstream_oid)) = (local.get().target(), upstream_ref.target())
    else {
        return DEGRADED;
    };
    match repo.graph_ahead_behind(local_oid, upstream_oid) {
        Ok((ahead, behind)) => BranchStats {
            ahead: Some(ahead.min(u32::MAX as usize) as u32),
            behind: Some(behind.min(u32::MAX as usize) as u32),
        },
        Err(_) => DEGRADED,
    }
}

/// SPEC.md `git_create_branch`.
///
/// Three-layer name validation in order:
/// 1. IPC bounds (`validate_branch_name`: length cap + NUL + `refs/` prefix)
/// 2. libgit2 refname rules (via `validate_branch_name` → `Branch::name_is_valid`)
/// 3. Case-insensitive scan ([`case_insensitive_conflict`]) for macOS/Windows
///
/// Then:
/// - Same-case duplicate → `BranchExists`
/// - `base_oid=None` on unborn HEAD → `UnbornHead` (UI guides "first commit required")
/// - `base_oid=None` otherwise → use current HEAD commit
/// - `base_oid=Some(hex)` invalid hex / commit missing → `BaseNotFound`
///
/// Does not check working tree state — callers (commands::git) must take
/// the per-repo write_lock and assert `RepositoryState::Clean` before calling.
pub fn create_branch(repo: &Repository, name: &str, base_oid: Option<&str>) -> Result<()> {
    validate_branch_name(name)?;

    if case_insensitive_conflict(repo, name)?.is_some() {
        return Err(KiraError::BranchNameConflictCase);
    }

    if repo.find_branch(name, BranchType::Local).is_ok() {
        return Err(KiraError::BranchExists);
    }

    let target = match base_oid {
        Some(hex) => {
            let oid = git2::Oid::from_str(hex).map_err(|_| KiraError::BaseNotFound)?;
            repo.find_commit(oid).map_err(|_| KiraError::BaseNotFound)?
        }
        None => {
            if head_is_unborn(repo) {
                return Err(KiraError::UnbornHead);
            }
            repo.head()?.peel_to_commit()?
        }
    };

    // `force=false` so we never silently overwrite a ref that slipped past the
    // case scan (e.g. race-created between the scan and this call).
    repo.branch(name, &target, false)?;
    Ok(())
}

/// SPEC.md `git_delete_branch`.
///
/// `Branch::is_head()` pre-check → `CannotDeleteCurrent`. Without it, libgit2
/// emits a generic error and the UI cannot give a useful prompt.
///
/// `force=false` runs a merged-policy ancestor check before deletion (git CLI
/// `branch -d` parity): branch tip must be reachable from either its upstream
/// (if configured + tracking ref present) or current HEAD; otherwise
/// `BranchUnmerged`. Mirrors `remote::has_upstream_config` discipline — config
/// presence drives target selection, not `Branch::upstream()` which silently
/// fails on pruned refs.
///
/// `force=true` skips the merged check and deletes the ref unconditionally.
/// Callers (commands::git) handle the destructive-action confirmation UI and
/// take the per-repo write_lock + state_guard before invoking.
pub fn delete_branch(repo: &Repository, name: &str, force: bool) -> Result<()> {
    // IPC bounds first — defense-in-depth alongside create_branch's validator.
    // Without it, a refname with embedded NUL or 256+ chars would reach
    // find_branch and fall through libgit2's path-shaped reject as
    // BranchNotFound, hiding a malformed-input class of bug behind a
    // benign-looking error (Codex security review finding).
    validate_branch_name(name)?;
    let mut branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(|_| KiraError::BranchNotFound)?;

    if branch.is_head() {
        return Err(KiraError::CannotDeleteCurrent);
    }

    if !force {
        let branch_tip = branch.get().target().ok_or(KiraError::BranchNotFound)?;
        let target_tip = resolve_merge_target(repo, name)?;
        // Equality covers the case where branch_tip == target_tip directly;
        // libgit2 graph_descendant_of returns false for identical OIDs.
        let merged = branch_tip == target_tip
            || repo
                .graph_descendant_of(target_tip, branch_tip)
                .unwrap_or(false);
        if !merged {
            return Err(KiraError::BranchUnmerged);
        }
    }

    branch.delete()?;
    Ok(())
}

/// Pick the commit that "is the branch merged into?" check compares against:
/// upstream tip when config exists and the tracking ref is resolvable, else
/// current HEAD. Returns Err only when neither is available (e.g. unborn HEAD
/// with no upstream — caller pre-empts that by rejecting unborn before this).
fn resolve_merge_target(repo: &Repository, branch_name: &str) -> Result<git2::Oid> {
    let head_ref = format!("refs/heads/{branch_name}");
    if let Ok(buf) = repo.branch_upstream_name(&head_ref) {
        if let Some(upstream_full) = buf.as_str() {
            if let Ok(upstream_ref) = repo.find_reference(upstream_full) {
                if let Some(oid) = upstream_ref.target() {
                    return Ok(oid);
                }
            }
        }
    }
    // Fall back to HEAD. Unborn HEAD here would be exotic (we have at least
    // one local branch to delete) — surface as BranchNotFound to keep
    // contract narrow.
    repo.head()
        .ok()
        .and_then(|h| h.target())
        .ok_or(KiraError::BranchNotFound)
}

/// SPEC.md `git_checkout_branch`.
///
/// `force=false` runs a backend status preflight — any staged or unstaged
/// *tracked* change → `DirtyTree`. Untracked (WT_NEW) files do not trigger the
/// rejection; libgit2 safe checkout already preserves them. This makes the
/// UI text "Switch refuses if there are uncommitted changes" actually true,
/// instead of relying on libgit2's safe-checkout which silently keeps
/// non-conflicting tracked changes.
///
/// `force=true` opts into destructive overwrite:
/// - `force()` overwrites tracked dirty changes
/// - `remove_untracked(false)` preserves untracked files (caller's local edits)
/// - `overwrite_ignored(false)` preserves ignored files like `.env` / secrets
///
/// Operation order mirrors pull's transactional ordering:
/// `checkout_tree` first, then `set_head`. Failing in the opposite order
/// leaves HEAD pointing at the new branch while the working tree still
/// reflects the old one.
///
/// **Deferred**: Linked worktrees share the ref store but maintain per-worktree
/// HEAD/index. The proper fix is keying `write_lock` on `repo.commondir()` rather
/// than the workdir canonical path. T10 v1 ships without linked-worktree support;
/// using Kira against a linked worktree is documented as unsupported.
pub fn checkout_branch(repo: &Repository, name: &str, force: bool) -> Result<String> {
    // IPC bounds first: `set_head(&format!("refs/heads/{name}"))` below would
    // otherwise accept any string that survives find_branch, missing the
    // NUL / 256-char / `refs/` prefix guards applied at create_branch
    // (Codex security review finding).
    validate_branch_name(name)?;
    let branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(|_| KiraError::BranchNotFound)?;

    let target_oid = branch.get().target().ok_or(KiraError::BranchNotFound)?;
    let target_commit = repo.find_commit(target_oid)?;
    let target_tree = target_commit.tree()?;

    if !force {
        // Safety check uses its own StatusOptions without untracked files —
        // get_status() is display-capped (MAX_UNSTAGED_FILES) and must not be
        // used for safety decisions.
        let mut dirty_opts = git2::StatusOptions::new();
        dirty_opts.include_untracked(false);
        let dirty_statuses = repo.statuses(Some(&mut dirty_opts))?;
        let has_dirty = dirty_statuses.iter().any(|e| !e.status().is_conflicted());
        if has_dirty {
            return Err(KiraError::DirtyTree);
        }
    } else {
        // Force preflight: `remove_untracked(false)` keeps unrelated untracked
        // files, but libgit2 will still overwrite untracked working-copy files
        // that collide with paths recorded in the target tree. Refuse this
        // upfront so the dialog's "ignored files preserved" copy stays honest
        // (Codex review finding). Surfaces as CHECKOUT_CONFLICT
        // so the UI can prompt the user to move / commit the file first.
        // Probe workdir so a bare/closed repo fails closed before the scan.
        repo.workdir().ok_or(KiraError::RepoNotOpen)?;
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        let statuses = repo.statuses(Some(&mut opts))?;
        for entry in statuses.iter() {
            if !entry.status().intersects(git2::Status::WT_NEW) {
                continue;
            }
            let Some(rel) = entry.path() else { continue };
            // Walk into the tree to see if the target records this path.
            if target_tree.get_path(std::path::Path::new(rel)).is_ok() {
                return Err(KiraError::CheckoutConflict);
            }
        }
    }

    let mut builder = CheckoutBuilder::new();
    if force {
        // - remove_untracked(false): keep working tree files that exist locally
        //   but not in source — defaults to false, set explicitly for clarity.
        // - overwrite_ignored(false): do NOT copy tree files over local ignored
        //   paths. libgit2 defaults to true, which silently clobbers local
        //   `.env` / secrets when the target tree happens to track that path.
        // Untracked target-path collisions are blocked by the preflight above.
        builder
            .force()
            .remove_untracked(false)
            .overwrite_ignored(false);
    } else {
        builder.safe().allow_conflicts(false);
    }

    repo.checkout_tree(target_tree.as_object(), Some(&mut builder))
        .map_err(|e| match e.code() {
            ErrorCode::Conflict => KiraError::CheckoutConflict,
            _ => KiraError::from(e),
        })?;

    repo.set_head(&format!("refs/heads/{name}"))?;
    Ok(name.to_string())
}

/// Resolve a local branch's upstream config + tracking ref existence. Returns
/// `None` when no upstream is configured. `Some(_).tracking_ref_exists=false`
/// when config exists but `refs/remotes/.../X` is missing (pruned / fork drift).
///
/// Mirrors `remote::has_upstream_config` strategy: prefer
/// `branch_upstream_name(refs/heads/X)` (config-only) over `Branch::upstream()`
/// which silently fails when the remote-tracking ref is pruned, indistinguishable
/// from "no upstream config".
fn local_upstream(repo: &Repository, branch_name: &str) -> Result<Option<BranchUpstream>> {
    let head_ref = format!("refs/heads/{branch_name}");
    let Ok(upstream_buf) = repo.branch_upstream_name(&head_ref) else {
        return Ok(None);
    };
    let Some(upstream_full) = upstream_buf.as_str() else {
        return Ok(None);
    };
    // `upstream_full` is like "refs/remotes/origin/feature", or "refs/heads/main" when the
    // upstream is a local branch (`branch.<name>.remote = .`). Strip either prefix for the
    // human-readable shorthand ("origin/feature" / "main"); the sidebar's pruned title shows it.
    let shorthand = upstream_full
        .strip_prefix("refs/remotes/")
        .or_else(|| upstream_full.strip_prefix("refs/heads/"))
        .unwrap_or(upstream_full)
        .to_string();
    let tracking_ref_exists = repo.find_reference(upstream_full).is_ok();
    Ok(Some(BranchUpstream {
        name: shorthand,
        tracking_ref_exists,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use tempfile::TempDir;

    fn init_repo() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        (dir, repo)
    }

    fn commit_empty(repo: &Repository, msg: &str) -> git2::Oid {
        let sig = Signature::now("t", "t@example.com").unwrap();
        let mut index = repo.index().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let parents: Vec<git2::Commit> = match repo.head() {
            Ok(h) => vec![h.peel_to_commit().unwrap()],
            Err(_) => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs)
            .unwrap()
    }

    #[test]
    fn validate_rejects_empty_nul_oversize_and_refs_prefix() {
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
    }

    #[test]
    fn validate_rejects_libgit2_invalid_chars() {
        // libgit2 rules: spaces, ~^:?*[\, .., @{, .lock, reserved names
        for bad in [
            "foo bar", "foo:bar", "foo~bar", "foo^bar", "foo..bar", "foo.lock", "HEAD",
        ] {
            assert!(
                matches!(validate_branch_name(bad), Err(KiraError::InvalidBranchName)),
                "expected reject for {bad:?}"
            );
        }
    }

    #[test]
    fn validate_accepts_normal_names() {
        assert!(validate_branch_name("main").is_ok());
        assert!(validate_branch_name("feat/t10-branches").is_ok());
        assert!(validate_branch_name("release-1.2.3").is_ok());
    }

    #[test]
    fn head_is_unborn_true_on_fresh_init() {
        let (_dir, repo) = init_repo();
        assert!(head_is_unborn(&repo));
    }

    #[test]
    fn head_is_unborn_false_after_first_commit() {
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        assert!(!head_is_unborn(&repo));
    }

    #[test]
    fn head_is_detached_false_on_branch() {
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        assert!(!head_is_detached(&repo).unwrap());
    }

    #[test]
    fn head_is_detached_true_when_pointing_at_oid() {
        let (_dir, repo) = init_repo();
        let oid = commit_empty(&repo, "init");
        repo.set_head_detached(oid).unwrap();
        assert!(head_is_detached(&repo).unwrap());
    }

    #[test]
    fn case_conflict_finds_lowercase_collision() {
        let (_dir, repo) = init_repo();
        let oid = commit_empty(&repo, "init");
        let commit = repo.find_commit(oid).unwrap();
        repo.branch("feature/a", &commit, false).unwrap();

        let conflict = case_insensitive_conflict(&repo, "Feature/A").unwrap();
        assert_eq!(conflict.as_deref(), Some("feature/a"));
    }

    #[test]
    fn case_conflict_skips_exact_match() {
        let (_dir, repo) = init_repo();
        let oid = commit_empty(&repo, "init");
        let commit = repo.find_commit(oid).unwrap();
        repo.branch("feature/a", &commit, false).unwrap();

        // Exact same case → caller's BranchExists path, not a case conflict.
        let conflict = case_insensitive_conflict(&repo, "feature/a").unwrap();
        assert!(conflict.is_none());
    }

    #[test]
    fn case_conflict_none_when_unique() {
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        let conflict = case_insensitive_conflict(&repo, "totally-new").unwrap();
        assert!(conflict.is_none());
    }

    #[test]
    fn list_branches_unborn_returns_empty() {
        let (_dir, repo) = init_repo();
        let result = list_branches(&repo).unwrap();
        assert!(result.branches.is_empty());
        assert_eq!(result.detached_head_oid, None);
    }

    #[test]
    fn list_branches_single_local_marks_current_and_no_upstream() {
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        // Default branch name varies by libgit2 init.defaultBranch (master/main).
        // Use the actual HEAD shorthand instead of hardcoding.
        let head_name = repo.head().unwrap().shorthand().unwrap().to_string();

        let result = list_branches(&repo).unwrap();
        assert_eq!(result.branches.len(), 1);
        let info = &result.branches[0];
        assert_eq!(info.name, head_name);
        assert!(info.is_current);
        assert!(!info.is_remote);
        assert_eq!(info.upstream, None);
        assert_eq!(result.detached_head_oid, None);
    }

    #[test]
    fn list_branches_detached_head_populates_oid_and_no_current() {
        let (_dir, repo) = init_repo();
        let oid = commit_empty(&repo, "init");
        repo.set_head_detached(oid).unwrap();

        let result = list_branches(&repo).unwrap();
        // Branches still listed, but none should be current
        assert!(result.branches.iter().all(|b| !b.is_current));
        assert_eq!(
            result.detached_head_oid.as_deref(),
            Some(oid.to_string().as_str())
        );
    }

    #[test]
    fn list_branches_includes_remote_with_is_remote_true_and_no_upstream() {
        let (_dir, repo) = init_repo();
        let oid = commit_empty(&repo, "init");
        // Manually create a remote-tracking ref to simulate `git fetch` result
        repo.reference(
            "refs/remotes/origin/feature",
            oid,
            true,
            "test: synth remote ref",
        )
        .unwrap();

        let result = list_branches(&repo).unwrap();
        let remote = result
            .branches
            .iter()
            .find(|b| b.is_remote)
            .expect("expected an origin/feature remote-tracking entry");
        // libgit2 returns remote branch name as "origin/feature"
        assert_eq!(remote.name, "origin/feature");
        assert!(remote.is_remote);
        assert!(!remote.is_current);
        assert!(
            remote.upstream.is_none(),
            "remote rows do not carry upstream"
        );
    }

    #[test]
    fn list_branches_skips_symbolic_remote_head() {
        let (_dir, repo) = init_repo();
        let oid = commit_empty(&repo, "init");
        repo.reference(
            "refs/remotes/origin/main",
            oid,
            true,
            "test: synth remote ref",
        )
        .unwrap();
        // `git clone` / `git remote set-head` leave origin/HEAD as a symbolic ref to
        // origin/main: a pointer, not a branch — it cannot be checked out or deleted
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            true,
            "test: synth origin/HEAD",
        )
        .unwrap();

        let result = list_branches(&repo).unwrap();
        let remotes: Vec<&str> = result
            .branches
            .iter()
            .filter(|b| b.is_remote)
            .map(|b| b.name.as_str())
            .collect();
        assert_eq!(remotes, vec!["origin/main"]);
    }

    #[test]
    fn list_branches_local_with_upstream_marks_tracking_ref_exists_true() {
        let (_dir, repo) = init_repo();
        let oid = commit_empty(&repo, "init");
        let commit = repo.find_commit(oid).unwrap();
        repo.branch("feature", &commit, false).unwrap();
        // `set_upstream` requires the "origin" remote to be registered. URL is
        // never dialed in tests — it just satisfies libgit2's config lookup.
        repo.remote("origin", "file:///tmp/kira-test-not-dialed")
            .unwrap();
        repo.reference(
            "refs/remotes/origin/feature",
            oid,
            true,
            "test: synth remote ref",
        )
        .unwrap();
        let mut local = repo.find_branch("feature", BranchType::Local).unwrap();
        local.set_upstream(Some("origin/feature")).unwrap();

        let result = list_branches(&repo).unwrap();
        let local_info = result
            .branches
            .iter()
            .find(|b| b.name == "feature" && !b.is_remote)
            .unwrap();
        let upstream = local_info.upstream.as_ref().expect("upstream configured");
        assert_eq!(upstream.name, "origin/feature");
        assert!(upstream.tracking_ref_exists);
    }

    #[test]
    fn list_branches_local_upstream_is_named_without_refs_heads() {
        let (_dir, repo) = init_repo();
        let oid = commit_empty(&repo, "init");
        let commit = repo.find_commit(oid).unwrap();
        repo.branch("feature", &commit, false).unwrap();
        let base = repo.head().unwrap().shorthand().unwrap().to_string();
        // Upstream = a local branch: git writes branch.feature.remote = "." and
        // branch.feature.merge = refs/heads/<base>, so the upstream ref is refs/heads/<base>
        let mut local = repo.find_branch("feature", BranchType::Local).unwrap();
        local.set_upstream(Some(&base)).unwrap();

        let result = list_branches(&repo).unwrap();
        let info = result
            .branches
            .iter()
            .find(|b| b.name == "feature" && !b.is_remote)
            .unwrap();
        let upstream = info.upstream.as_ref().expect("upstream configured");
        assert_eq!(upstream.name, base);
        assert!(upstream.tracking_ref_exists);
    }

    #[test]
    fn get_branch_stats_omits_unknown_branch_name() {
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        let stats = get_branch_stats(&repo, &["does-not-exist".to_string()]).unwrap();
        assert!(stats.is_empty());
    }

    #[test]
    fn get_branch_stats_no_upstream_returns_none_none() {
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        let head_name = repo.head().unwrap().shorthand().unwrap().to_string();
        let stats = get_branch_stats(&repo, std::slice::from_ref(&head_name)).unwrap();
        let s = stats.get(&head_name).expect("entry present");
        assert_eq!(s.ahead, None);
        assert_eq!(s.behind, None);
    }

    #[test]
    fn get_branch_stats_zero_zero_when_upstream_at_same_oid() {
        let (_dir, repo) = init_repo();
        let oid = commit_empty(&repo, "init");
        let commit = repo.find_commit(oid).unwrap();
        repo.branch("feature", &commit, false).unwrap();
        repo.remote("origin", "file:///tmp/kira-test-not-dialed")
            .unwrap();
        repo.reference(
            "refs/remotes/origin/feature",
            oid,
            true,
            "test: synth remote ref",
        )
        .unwrap();
        let mut local = repo.find_branch("feature", BranchType::Local).unwrap();
        local.set_upstream(Some("origin/feature")).unwrap();

        let stats = get_branch_stats(&repo, &["feature".to_string()]).unwrap();
        let s = stats.get("feature").expect("entry present");
        assert_eq!(s.ahead, Some(0));
        assert_eq!(s.behind, Some(0));
    }

    #[test]
    fn get_branch_stats_ahead_after_local_commit() {
        let (_dir, repo) = init_repo();
        let oid_a = commit_empty(&repo, "init");
        let commit_a = repo.find_commit(oid_a).unwrap();
        repo.branch("feature", &commit_a, false).unwrap();
        repo.remote("origin", "file:///tmp/kira-test-not-dialed")
            .unwrap();
        repo.reference(
            "refs/remotes/origin/feature",
            oid_a,
            true,
            "test: synth remote ref",
        )
        .unwrap();
        let mut local = repo.find_branch("feature", BranchType::Local).unwrap();
        local.set_upstream(Some("origin/feature")).unwrap();
        // Advance local by one commit
        repo.set_head("refs/heads/feature").unwrap();
        let _ = commit_empty(&repo, "local advance");

        let stats = get_branch_stats(&repo, &["feature".to_string()]).unwrap();
        let s = stats.get("feature").expect("entry present");
        assert_eq!(s.ahead, Some(1));
        assert_eq!(s.behind, Some(0));
    }

    #[test]
    fn get_branch_stats_pruned_upstream_returns_none_none() {
        let (_dir, repo) = init_repo();
        let oid = commit_empty(&repo, "init");
        let commit = repo.find_commit(oid).unwrap();
        repo.branch("feature", &commit, false).unwrap();
        repo.remote("origin", "file:///tmp/kira-test-not-dialed")
            .unwrap();
        repo.reference(
            "refs/remotes/origin/feature",
            oid,
            true,
            "test: synth remote ref",
        )
        .unwrap();
        let mut local = repo.find_branch("feature", BranchType::Local).unwrap();
        local.set_upstream(Some("origin/feature")).unwrap();
        // Prune the tracking ref → degraded ahead/behind, not whole-call failure
        repo.find_reference("refs/remotes/origin/feature")
            .unwrap()
            .delete()
            .unwrap();

        let stats = get_branch_stats(&repo, &["feature".to_string()]).unwrap();
        let s = stats.get("feature").expect("entry present");
        assert_eq!(s.ahead, None);
        assert_eq!(s.behind, None);
    }

    #[test]
    fn create_branch_unborn_returns_unborn_head() {
        let (_dir, repo) = init_repo();
        let err = create_branch(&repo, "feature", None).unwrap_err();
        assert!(matches!(err, KiraError::UnbornHead));
    }

    #[test]
    fn create_branch_invalid_name_returns_invalid_branch_name() {
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        let err = create_branch(&repo, "bad name", None).unwrap_err();
        assert!(matches!(err, KiraError::InvalidBranchName));
    }

    #[test]
    fn create_branch_duplicate_returns_branch_exists() {
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        create_branch(&repo, "feature", None).unwrap();
        let err = create_branch(&repo, "feature", None).unwrap_err();
        assert!(matches!(err, KiraError::BranchExists));
    }

    #[test]
    fn create_branch_case_conflict_returns_dedicated_error() {
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        create_branch(&repo, "feature/a", None).unwrap();
        let err = create_branch(&repo, "Feature/A", None).unwrap_err();
        assert!(matches!(err, KiraError::BranchNameConflictCase));
    }

    #[test]
    fn create_branch_base_oid_invalid_hex_returns_base_not_found() {
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        let err = create_branch(&repo, "feature", Some("not-a-hex")).unwrap_err();
        assert!(matches!(err, KiraError::BaseNotFound));
    }

    #[test]
    fn create_branch_base_oid_unknown_commit_returns_base_not_found() {
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        let err = create_branch(
            &repo,
            "feature",
            Some("0000000000000000000000000000000000000001"),
        )
        .unwrap_err();
        assert!(matches!(err, KiraError::BaseNotFound));
    }

    #[test]
    fn create_branch_default_base_points_at_head() {
        let (_dir, repo) = init_repo();
        let head_oid = commit_empty(&repo, "init");
        create_branch(&repo, "feature", None).unwrap();
        let branch = repo.find_branch("feature", BranchType::Local).unwrap();
        assert_eq!(branch.get().target(), Some(head_oid));
    }

    #[test]
    fn create_branch_explicit_base_points_at_given_oid() {
        let (_dir, repo) = init_repo();
        let a = commit_empty(&repo, "first");
        let _b = commit_empty(&repo, "second");
        create_branch(&repo, "fork-at-a", Some(&a.to_string())).unwrap();
        let branch = repo.find_branch("fork-at-a", BranchType::Local).unwrap();
        assert_eq!(branch.get().target(), Some(a));
    }

    #[test]
    fn delete_branch_invalid_name_returns_invalid_branch_name() {
        // Codex security review finding: IPC bounds must reject malformed refname
        // before find_branch.
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        let err = delete_branch(&repo, "bad name", false).unwrap_err();
        assert!(matches!(err, KiraError::InvalidBranchName));
        let err = delete_branch(&repo, "refs/heads/feature", false).unwrap_err();
        assert!(matches!(err, KiraError::InvalidBranchName));
    }

    #[test]
    fn delete_branch_not_found_returns_branch_not_found() {
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        let err = delete_branch(&repo, "does-not-exist", false).unwrap_err();
        assert!(matches!(err, KiraError::BranchNotFound));
    }

    #[test]
    fn delete_branch_current_returns_cannot_delete_current() {
        let (_dir, repo) = init_repo();
        commit_empty(&repo, "init");
        let head_name = repo.head().unwrap().shorthand().unwrap().to_string();
        let err = delete_branch(&repo, &head_name, false).unwrap_err();
        assert!(matches!(err, KiraError::CannotDeleteCurrent));
    }

    #[test]
    fn delete_branch_unmerged_returns_branch_unmerged() {
        // feature branches off main, advances one commit; main does not include
        // that commit → not merged → reject unless force.
        let (_dir, repo) = init_repo();
        let head_oid = commit_empty(&repo, "init");
        let head_commit = repo.find_commit(head_oid).unwrap();
        repo.branch("feature", &head_commit, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        let _feature_advance = commit_empty(&repo, "feature advance");

        // Switch back to default branch
        let default_branch = repo
            .branches(Some(BranchType::Local))
            .unwrap()
            .filter_map(|b| b.ok())
            .find_map(|(b, _)| match b.name().ok().flatten() {
                Some("feature") => None,
                Some(n) => Some(n.to_string()),
                None => None,
            })
            .unwrap();
        repo.set_head(&format!("refs/heads/{default_branch}"))
            .unwrap();

        let err = delete_branch(&repo, "feature", false).unwrap_err();
        assert!(matches!(err, KiraError::BranchUnmerged));
    }

    #[test]
    fn delete_branch_merged_succeeds_without_force() {
        // feature points at the same commit as HEAD → merged → safe to delete.
        let (_dir, repo) = init_repo();
        let head_oid = commit_empty(&repo, "init");
        let head_commit = repo.find_commit(head_oid).unwrap();
        repo.branch("done", &head_commit, false).unwrap();

        delete_branch(&repo, "done", false).unwrap();
        assert!(repo.find_branch("done", BranchType::Local).is_err());
    }

    #[test]
    fn delete_branch_force_skips_merged_check() {
        let (_dir, repo) = init_repo();
        let head_oid = commit_empty(&repo, "init");
        let head_commit = repo.find_commit(head_oid).unwrap();
        repo.branch("feature", &head_commit, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        let _ = commit_empty(&repo, "feature advance");

        let default_branch = repo
            .branches(Some(BranchType::Local))
            .unwrap()
            .filter_map(|b| b.ok())
            .find_map(|(b, _)| match b.name().ok().flatten() {
                Some("feature") => None,
                Some(n) => Some(n.to_string()),
                None => None,
            })
            .unwrap();
        repo.set_head(&format!("refs/heads/{default_branch}"))
            .unwrap();

        // Without force the previous test proves we'd hit BranchUnmerged.
        delete_branch(&repo, "feature", true).unwrap();
        assert!(repo.find_branch("feature", BranchType::Local).is_err());
    }

    /// Helper: commit a file with given content into the current branch.
    /// Returns the new commit OID.
    fn commit_file(
        repo: &Repository,
        dir: &TempDir,
        rel: &str,
        content: &str,
        msg: &str,
    ) -> git2::Oid {
        std::fs::write(dir.path().join(rel), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new(rel)).unwrap();
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        let parents: Vec<git2::Commit> = repo
            .head()
            .ok()
            .and_then(|h| h.target())
            .and_then(|o| repo.find_commit(o).ok())
            .into_iter()
            .collect();
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs)
            .unwrap()
    }

    #[test]
    fn checkout_branch_invalid_name_returns_invalid_branch_name() {
        // Codex security review finding: IPC bounds must reject malformed refname
        // before find_branch and set_head refspec assembly.
        let (dir, repo) = init_repo();
        commit_file(&repo, &dir, "a.txt", "x\n", "init");
        let err = checkout_branch(&repo, "bad name", false).unwrap_err();
        assert!(matches!(err, KiraError::InvalidBranchName));
        let err = checkout_branch(&repo, "refs/heads/feature", false).unwrap_err();
        assert!(matches!(err, KiraError::InvalidBranchName));
    }

    #[test]
    fn checkout_branch_not_found_returns_branch_not_found() {
        let (dir, repo) = init_repo();
        commit_file(&repo, &dir, "a.txt", "x\n", "init");
        let err = checkout_branch(&repo, "ghost", false).unwrap_err();
        assert!(matches!(err, KiraError::BranchNotFound));
    }

    #[test]
    fn checkout_branch_clean_tree_switches_head() {
        let (dir, repo) = init_repo();
        let init_oid = commit_file(&repo, &dir, "a.txt", "x\n", "init");
        let init_commit = repo.find_commit(init_oid).unwrap();
        repo.branch("feature", &init_commit, false).unwrap();

        let head_name = checkout_branch(&repo, "feature", false).unwrap();
        assert_eq!(head_name, "feature");
        assert_eq!(repo.head().unwrap().shorthand(), Some("feature"));
    }

    #[test]
    fn checkout_branch_with_staged_change_returns_dirty_tree() {
        let (dir, repo) = init_repo();
        let init_oid = commit_file(&repo, &dir, "a.txt", "x\n", "init");
        let init_commit = repo.find_commit(init_oid).unwrap();
        repo.branch("feature", &init_commit, false).unwrap();

        // stage a change without committing
        std::fs::write(dir.path().join("a.txt"), "modified\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.write().unwrap();

        let err = checkout_branch(&repo, "feature", false).unwrap_err();
        assert!(matches!(err, KiraError::DirtyTree));
    }

    #[test]
    fn checkout_branch_with_unstaged_modification_returns_dirty_tree() {
        let (dir, repo) = init_repo();
        let init_oid = commit_file(&repo, &dir, "a.txt", "x\n", "init");
        let init_commit = repo.find_commit(init_oid).unwrap();
        repo.branch("feature", &init_commit, false).unwrap();

        // unstaged tracked modification
        std::fs::write(dir.path().join("a.txt"), "modified\n").unwrap();

        let err = checkout_branch(&repo, "feature", false).unwrap_err();
        assert!(matches!(err, KiraError::DirtyTree));
    }

    #[test]
    fn checkout_branch_untracked_files_do_not_count_as_dirty() {
        let (dir, repo) = init_repo();
        let init_oid = commit_file(&repo, &dir, "a.txt", "x\n", "init");
        let init_commit = repo.find_commit(init_oid).unwrap();
        repo.branch("feature", &init_commit, false).unwrap();

        // untracked file — libgit2 safe checkout preserves these
        std::fs::write(dir.path().join("scratch.txt"), "junk\n").unwrap();

        checkout_branch(&repo, "feature", false).unwrap();
        assert_eq!(repo.head().unwrap().shorthand(), Some("feature"));
        // scratch.txt still present
        assert!(dir.path().join("scratch.txt").exists());
    }

    #[test]
    fn checkout_branch_force_overwrites_tracked_dirty_change() {
        let (dir, repo) = init_repo();
        let init_oid = commit_file(&repo, &dir, "a.txt", "x\n", "init");
        let init_commit = repo.find_commit(init_oid).unwrap();
        // Create a second branch with different content
        repo.branch("feature", &init_commit, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        commit_file(&repo, &dir, "a.txt", "feature content\n", "feature");

        // Switch back to default and dirty the tree
        let default_branch = repo
            .branches(Some(BranchType::Local))
            .unwrap()
            .filter_map(|b| b.ok())
            .find_map(|(b, _)| match b.name().ok().flatten() {
                Some("feature") => None,
                Some(n) => Some(n.to_string()),
                None => None,
            })
            .unwrap();
        repo.set_head(&format!("refs/heads/{default_branch}"))
            .unwrap();
        repo.checkout_head(Some(CheckoutBuilder::new().force()))
            .unwrap();
        std::fs::write(dir.path().join("a.txt"), "local edit\n").unwrap();

        checkout_branch(&repo, "feature", true).unwrap();
        // Force should have overwritten local edit with feature's content.
        // Checkout applies the host's line-ending config (e.g. core.autocrlf), and
        // the Windows CI runner writes CRLF, so compare without CR.
        let on_disk = std::fs::read_to_string(dir.path().join("a.txt"))
            .unwrap()
            .replace("\r\n", "\n");
        assert_eq!(on_disk, "feature content\n");
    }

    #[test]
    fn checkout_branch_force_rejects_untracked_collision_with_target_path() {
        // Codex review finding: an untracked working-copy file at a path the
        // target tree tracks would be overwritten by libgit2 force checkout.
        // Preflight must surface this as CHECKOUT_CONFLICT.
        let (dir, repo) = init_repo();
        let init_oid = commit_file(&repo, &dir, "anchor.txt", "anchor\n", "init");
        let init_commit = repo.find_commit(init_oid).unwrap();
        repo.branch("feature", &init_commit, false).unwrap();
        // feature: add a tracked file at "secret.txt"
        repo.set_head("refs/heads/feature").unwrap();
        commit_file(&repo, &dir, "secret.txt", "branch-owned\n", "feature");

        // Switch back to default branch
        let default_branch = repo
            .branches(Some(BranchType::Local))
            .unwrap()
            .filter_map(|b| b.ok())
            .find_map(|(b, _)| match b.name().ok().flatten() {
                Some("feature") => None,
                Some(n) => Some(n.to_string()),
                None => None,
            })
            .unwrap();
        repo.set_head(&format!("refs/heads/{default_branch}"))
            .unwrap();
        repo.checkout_head(Some(CheckoutBuilder::new().force()))
            .unwrap();
        // Disk no longer has secret.txt (it was only on feature) — re-create
        // it as untracked on default branch.
        std::fs::write(dir.path().join("secret.txt"), "MY LOCAL SECRET\n").unwrap();

        // Force checkout to feature would overwrite secret.txt — preflight rejects.
        let err = checkout_branch(&repo, "feature", true).unwrap_err();
        assert!(matches!(err, KiraError::CheckoutConflict));
        // Local content preserved
        let on_disk = std::fs::read_to_string(dir.path().join("secret.txt")).unwrap();
        assert_eq!(on_disk, "MY LOCAL SECRET\n");
    }

    #[test]
    fn checkout_branch_force_preserves_untracked_files() {
        let (dir, repo) = init_repo();
        let init_oid = commit_file(&repo, &dir, "a.txt", "x\n", "init");
        let init_commit = repo.find_commit(init_oid).unwrap();
        repo.branch("feature", &init_commit, false).unwrap();

        std::fs::write(dir.path().join("personal.txt"), "mine\n").unwrap();

        checkout_branch(&repo, "feature", true).unwrap();
        assert!(
            dir.path().join("personal.txt").exists(),
            "force checkout must not remove untracked files"
        );
    }

    #[test]
    fn delete_branch_uses_upstream_when_configured() {
        // upstream tracks feature; branch tip == upstream tip → merged.
        let (_dir, repo) = init_repo();
        let oid = commit_empty(&repo, "init");
        let commit = repo.find_commit(oid).unwrap();
        repo.branch("feature", &commit, false).unwrap();
        repo.remote("origin", "file:///tmp/kira-test-not-dialed")
            .unwrap();
        repo.reference(
            "refs/remotes/origin/feature",
            oid,
            true,
            "test: synth remote ref",
        )
        .unwrap();
        let mut local = repo.find_branch("feature", BranchType::Local).unwrap();
        local.set_upstream(Some("origin/feature")).unwrap();
        drop(local);

        delete_branch(&repo, "feature", false).unwrap();
        assert!(repo.find_branch("feature", BranchType::Local).is_err());
    }

    #[test]
    fn list_branches_pruned_upstream_marks_tracking_ref_exists_false() {
        let (_dir, repo) = init_repo();
        let oid = commit_empty(&repo, "init");
        let commit = repo.find_commit(oid).unwrap();
        repo.branch("feature", &commit, false).unwrap();
        repo.remote("origin", "file:///tmp/kira-test-not-dialed")
            .unwrap();
        repo.reference(
            "refs/remotes/origin/feature",
            oid,
            true,
            "test: synth remote ref",
        )
        .unwrap();
        let mut local = repo.find_branch("feature", BranchType::Local).unwrap();
        local.set_upstream(Some("origin/feature")).unwrap();
        // Now prune the remote-tracking ref — config still records upstream
        // but the ref is gone (fork workflow / `git fetch --prune` scenario).
        repo.find_reference("refs/remotes/origin/feature")
            .unwrap()
            .delete()
            .unwrap();

        let result = list_branches(&repo).unwrap();
        let local_info = result
            .branches
            .iter()
            .find(|b| b.name == "feature" && !b.is_remote)
            .unwrap();
        let upstream = local_info
            .upstream
            .as_ref()
            .expect("config still records upstream");
        assert_eq!(upstream.name, "origin/feature");
        assert!(
            !upstream.tracking_ref_exists,
            "pruned ref should report tracking_ref_exists=false"
        );
    }
}
