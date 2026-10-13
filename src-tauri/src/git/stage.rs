use crate::error::{KiraError, Result};
use git2::{ErrorCode, ObjectType, Repository, Signature, Status, StatusOptions};
use serde::Serialize;
use std::path::{Component, Path};

const MAX_PATH_LEN: usize = 4096;
const MAX_MESSAGE_LEN: usize = 1 << 20;

#[derive(Debug, Serialize)]
pub struct StageResult {
    pub success: bool,
}

#[derive(Debug, Serialize)]
pub struct CommitResult {
    pub oid: String,
}

pub fn stage_file(repo: &Repository, rel_path: &str) -> Result<()> {
    validate_rel_path(rel_path)?;
    let workdir = repo.workdir().ok_or(KiraError::RepoNotOpen)?;
    let path = Path::new(rel_path);
    let abs = workdir.join(path);
    let mut index = repo.index()?;

    if abs.symlink_metadata().is_ok() {
        index.add_path(path).map_err(|_| KiraError::FileNotFound)?;
    } else if index.get_path(path, 0).is_some() {
        index
            .remove_path(path)
            .map_err(|_| KiraError::FileNotFound)?;
    } else {
        return Err(KiraError::FileNotFound);
    }

    index.write()?;
    Ok(())
}

/// 列舉 status flag 命中的 UTF-8 path。非 UTF-8 path silently skip（與 `stage_file`
/// 只接受 `&str` 的契約一致）。
fn collect_paths_with_status(repo: &Repository, flags: Status) -> Result<Vec<String>> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts))?;
    Ok(statuses
        .iter()
        // Skip conflicted entries — bulk stage/unstage must not silently
        // resolve a conflict by collapsing stages 1/2/3 into a normal staged
        // file (Codex review finding). libgit2 sets both
        // CONFLICTED and WT_MODIFIED on conflict working copies, so a naive
        // intersects(WT_*) match would include them.
        .filter(|e| !e.status().is_conflicted())
        .filter(|e| e.status().intersects(flags))
        .filter_map(|e| e.path().map(String::from))
        .collect())
}

/// Stage 所有 unstaged changes（new / modified / deleted / typechange）。
///
/// 依 worktree 是否存在分流：存在 → `index.add_path`（含 new / modified / typechange）；
/// 不存在 → `index.remove_path`（deleted）。一次 `index.write()` 收尾。
pub fn stage_all(repo: &Repository) -> Result<()> {
    let workdir = repo.workdir().ok_or(KiraError::RepoNotOpen)?.to_path_buf();
    let unstaged_flags =
        Status::WT_NEW | Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_TYPECHANGE;
    let paths = collect_paths_with_status(repo, unstaged_flags)?;
    if paths.is_empty() {
        return Ok(());
    }

    let mut index = repo.index()?;
    for rel in &paths {
        // Fail-close: status-derived paths are also validated. A crafted .git/index
        // could in principle smuggle .. components; rejecting them keeps workdir.join
        // strictly inside the worktree.
        validate_rel_path(rel)?;
        let path = Path::new(rel);
        let abs = workdir.join(path);
        if abs.symlink_metadata().is_ok() {
            index.add_path(path).map_err(|_| KiraError::FileNotFound)?;
        } else {
            index
                .remove_path(path)
                .map_err(|_| KiraError::FileNotFound)?;
        }
    }
    index.write()?;
    Ok(())
}

/// Unstage 所有 staged changes。HEAD 在 → `reset_default` 一次處理;UnbornBranch
/// (首 commit 前) → 逐路徑 `index.remove_path` + 一次 `index.write()`。
///
/// 不偵測 INDEX_RENAMED：`StatusOptions` 沒啟用 rename detection，git mv 在 status
/// iteration 中已被拆成 (INDEX_DELETED old, INDEX_NEW new) 兩條 entry，不會回 RENAMED。
pub fn unstage_all(repo: &Repository) -> Result<()> {
    let staged_flags = Status::INDEX_NEW
        | Status::INDEX_MODIFIED
        | Status::INDEX_DELETED
        | Status::INDEX_TYPECHANGE;
    let paths = collect_paths_with_status(repo, staged_flags)?;
    if paths.is_empty() {
        return Ok(());
    }
    for rel in &paths {
        validate_rel_path(rel)?;
    }

    match repo.head() {
        Err(e) if e.code() == ErrorCode::UnbornBranch => {
            let mut index = repo.index()?;
            for rel in &paths {
                index.remove_path(Path::new(rel))?;
            }
            index.write()?;
        }
        Err(e) => return Err(e.into()),
        Ok(head) => {
            let head_obj = head.peel(ObjectType::Commit)?;
            repo.reset_default(Some(&head_obj), paths.iter().map(|s| s.as_str()))?;
        }
    }
    Ok(())
}

pub fn unstage_file(repo: &Repository, rel_path: &str) -> Result<()> {
    validate_rel_path(rel_path)?;
    let path = Path::new(rel_path);

    let status = repo
        .status_file(path)
        .map_err(|_| KiraError::FileNotStaged)?;
    let staged_flags = Status::INDEX_NEW
        | Status::INDEX_MODIFIED
        | Status::INDEX_DELETED
        | Status::INDEX_RENAMED
        | Status::INDEX_TYPECHANGE;
    if !status.intersects(staged_flags) {
        return Err(KiraError::FileNotStaged);
    }

    match repo.head() {
        Err(e) if e.code() == ErrorCode::UnbornBranch => {
            let mut index = repo.index()?;
            index.remove_path(path)?;
            index.write()?;
        }
        Err(e) => return Err(e.into()),
        Ok(head) => {
            let head_obj = head.peel(ObjectType::Commit)?;
            repo.reset_default(Some(&head_obj), [rel_path])?;
        }
    }
    Ok(())
}

/// 讀 `user.name` 和 `user.email` (任一缺失或空字串視為未設定)。
///
/// `repo.config()` 預設 merge local + global + system 三層，與 git CLI 行為一致。
/// caller 應在 `repo.signature()` 之前呼叫；signature 在缺 identity 時會回 generic
/// `ErrorClass::Config` 錯誤，無法分流出設定引導。
pub fn check_identity_configured(repo: &Repository) -> bool {
    let Ok(cfg) = repo.config() else {
        return false;
    };
    let name_ok = cfg
        .get_string("user.name")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let email_ok = cfg
        .get_string("user.email")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    name_ok && email_ok
}

pub fn commit(repo: &Repository, signature: &Signature<'_>, message: &str) -> Result<String> {
    if message.len() > MAX_MESSAGE_LEN {
        return Err(KiraError::MessageTooLong);
    }
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(KiraError::EmptyMessage);
    }
    if repo.state() != git2::RepositoryState::Clean {
        return Err(KiraError::RepositoryNotClean);
    }

    let mut index = repo.index()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;

    let parents: Vec<git2::Commit<'_>> = match repo.head() {
        Err(e) if e.code() == ErrorCode::UnbornBranch => Vec::new(),
        Err(e) => return Err(e.into()),
        Ok(head) => {
            let head_commit = head.peel_to_commit()?;
            if head_commit.tree_id() == tree_id {
                return Err(KiraError::NothingToCommit);
            }
            vec![head_commit]
        }
    };

    if parents.is_empty() && tree.is_empty() {
        return Err(KiraError::NothingToCommit);
    }

    let parent_refs: Vec<&git2::Commit<'_>> = parents.iter().collect();
    let oid = repo.commit(
        Some("HEAD"),
        signature,
        signature,
        trimmed,
        &tree,
        &parent_refs,
    )?;
    Ok(oid.to_string())
}

fn validate_rel_path(rel_path: &str) -> Result<()> {
    if rel_path.is_empty() || rel_path.len() > MAX_PATH_LEN {
        return Err(KiraError::InvalidPath);
    }
    if rel_path.contains('\0') {
        return Err(KiraError::InvalidPath);
    }
    let normalised = rel_path.replace('\\', "/");
    let path = Path::new(&normalised);
    if path.is_absolute() {
        return Err(KiraError::InvalidPath);
    }
    for comp in path.components() {
        match comp {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(KiraError::InvalidPath);
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use std::fs;
    use tempfile::TempDir;

    fn init_repo() -> (TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        (dir, repo)
    }

    fn write_file(root: &Path, name: &str, content: &str) {
        let p = root.join(name);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    fn test_sig() -> Signature<'static> {
        Signature::now("test", "test@example.com").unwrap()
    }

    fn commit_initial(repo: &Repository, sig: &Signature<'_>) -> git2::Oid {
        let mut index = repo.index().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), sig, sig, "init", &tree, &[])
            .unwrap()
    }

    #[test]
    fn test_stage_file_new_untracked_adds_to_index() {
        let (dir, repo) = init_repo();
        write_file(dir.path(), "a.txt", "hello\n");

        stage_file(&repo, "a.txt").unwrap();

        let index = repo.index().unwrap();
        assert!(index.get_path(Path::new("a.txt"), 0).is_some());
    }

    #[test]
    fn test_stage_file_modified_tracked_updates_index() {
        let (dir, repo) = init_repo();
        let sig = test_sig();
        write_file(dir.path(), "a.txt", "v1\n");
        stage_file(&repo, "a.txt").unwrap();
        commit_initial(&repo, &sig);
        write_file(dir.path(), "a.txt", "v2\n");

        stage_file(&repo, "a.txt").unwrap();

        let status = repo.status_file(Path::new("a.txt")).unwrap();
        assert!(status.intersects(Status::INDEX_MODIFIED));
    }

    #[test]
    fn test_stage_file_deleted_worktree_removes_from_index() {
        let (dir, repo) = init_repo();
        let sig = test_sig();
        write_file(dir.path(), "a.txt", "v1\n");
        stage_file(&repo, "a.txt").unwrap();
        commit_initial(&repo, &sig);
        fs::remove_file(dir.path().join("a.txt")).unwrap();

        stage_file(&repo, "a.txt").unwrap();

        let status = repo.status_file(Path::new("a.txt")).unwrap();
        assert!(status.intersects(Status::INDEX_DELETED));
    }

    #[test]
    fn test_stage_file_nonexistent_returns_file_not_found() {
        let (_dir, repo) = init_repo();
        let result = stage_file(&repo, "nope.txt");
        assert!(matches!(result, Err(KiraError::FileNotFound)));
    }

    #[test]
    fn test_stage_file_absolute_path_rejected() {
        let (_dir, repo) = init_repo();
        let result = stage_file(&repo, "/etc/passwd");
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_stage_file_parent_dir_traversal_rejected() {
        let (_dir, repo) = init_repo();
        let result = stage_file(&repo, "../escape.txt");
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_stage_file_null_byte_rejected() {
        let (_dir, repo) = init_repo();
        let result = stage_file(&repo, "a\0b.txt");
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_stage_file_empty_path_rejected() {
        let (_dir, repo) = init_repo();
        let result = stage_file(&repo, "");
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_stage_file_too_long_path_rejected() {
        let (_dir, repo) = init_repo();
        let long = "a".repeat(MAX_PATH_LEN + 1);
        let result = stage_file(&repo, &long);
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_unstage_file_staged_new_removes_from_index() {
        let (dir, repo) = init_repo();
        write_file(dir.path(), "a.txt", "hello\n");
        stage_file(&repo, "a.txt").unwrap();

        unstage_file(&repo, "a.txt").unwrap();

        let status = repo.status_file(Path::new("a.txt")).unwrap();
        assert!(status.intersects(Status::WT_NEW));
        assert!(!status.intersects(Status::INDEX_NEW));
    }

    #[test]
    fn test_unstage_file_staged_modified_restores_head_version() {
        let (dir, repo) = init_repo();
        let sig = test_sig();
        write_file(dir.path(), "a.txt", "v1\n");
        stage_file(&repo, "a.txt").unwrap();
        commit_initial(&repo, &sig);
        write_file(dir.path(), "a.txt", "v2\n");
        stage_file(&repo, "a.txt").unwrap();

        unstage_file(&repo, "a.txt").unwrap();

        let status = repo.status_file(Path::new("a.txt")).unwrap();
        assert!(status.intersects(Status::WT_MODIFIED));
        assert!(!status.intersects(Status::INDEX_MODIFIED));
    }

    #[test]
    fn test_unstage_file_clean_file_returns_file_not_staged() {
        let (dir, repo) = init_repo();
        let sig = test_sig();
        write_file(dir.path(), "a.txt", "v1\n");
        stage_file(&repo, "a.txt").unwrap();
        commit_initial(&repo, &sig);

        let result = unstage_file(&repo, "a.txt");
        assert!(matches!(result, Err(KiraError::FileNotStaged)));
    }

    #[test]
    fn test_unstage_file_nonexistent_returns_file_not_staged() {
        let (_dir, repo) = init_repo();
        let result = unstage_file(&repo, "nope.txt");
        assert!(matches!(result, Err(KiraError::FileNotStaged)));
    }

    #[test]
    fn test_unstage_file_invalid_path_rejected() {
        let (_dir, repo) = init_repo();
        let result = unstage_file(&repo, "../escape.txt");
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_commit_initial_returns_oid_and_updates_head() {
        let (dir, repo) = init_repo();
        let sig = test_sig();
        write_file(dir.path(), "a.txt", "hello\n");
        stage_file(&repo, "a.txt").unwrap();

        let oid = commit(&repo, &sig, "first commit").unwrap();
        assert_eq!(oid.len(), 40);

        let head_oid = repo.head().unwrap().target().unwrap().to_string();
        assert_eq!(head_oid, oid);
    }

    #[test]
    fn test_commit_subsequent_links_to_parent() {
        let (dir, repo) = init_repo();
        let sig = test_sig();
        write_file(dir.path(), "a.txt", "v1\n");
        stage_file(&repo, "a.txt").unwrap();
        let first = commit(&repo, &sig, "first").unwrap();
        write_file(dir.path(), "a.txt", "v2\n");
        stage_file(&repo, "a.txt").unwrap();

        let second = commit(&repo, &sig, "second").unwrap();

        assert_ne!(first, second);
        let second_commit = repo
            .find_commit(git2::Oid::from_str(&second).unwrap())
            .unwrap();
        assert_eq!(second_commit.parent_count(), 1);
        assert_eq!(second_commit.parent_id(0).unwrap().to_string(), first);
    }

    #[test]
    fn test_commit_trims_message_whitespace() {
        let (dir, repo) = init_repo();
        let sig = test_sig();
        write_file(dir.path(), "a.txt", "x\n");
        stage_file(&repo, "a.txt").unwrap();

        let oid = commit(&repo, &sig, "  hello  \n").unwrap();
        let c = repo
            .find_commit(git2::Oid::from_str(&oid).unwrap())
            .unwrap();
        assert_eq!(c.message().unwrap(), "hello");
    }

    #[test]
    fn test_commit_empty_message_returns_empty_message() {
        let (_dir, repo) = init_repo();
        let sig = test_sig();
        let result = commit(&repo, &sig, "");
        assert!(matches!(result, Err(KiraError::EmptyMessage)));
    }

    #[test]
    fn test_commit_whitespace_only_message_returns_empty_message() {
        let (_dir, repo) = init_repo();
        let sig = test_sig();
        let result = commit(&repo, &sig, "   \n\t  ");
        assert!(matches!(result, Err(KiraError::EmptyMessage)));
    }

    #[test]
    fn test_commit_too_long_message_returns_message_too_long() {
        let (dir, repo) = init_repo();
        let sig = test_sig();
        write_file(dir.path(), "a.txt", "x\n");
        stage_file(&repo, "a.txt").unwrap();
        let huge = "a".repeat(MAX_MESSAGE_LEN + 1);
        let result = commit(&repo, &sig, &huge);
        assert!(matches!(result, Err(KiraError::MessageTooLong)));
    }

    #[test]
    fn test_commit_unborn_head_empty_index_returns_nothing_to_commit() {
        let (_dir, repo) = init_repo();
        let sig = test_sig();
        let result = commit(&repo, &sig, "should fail");
        assert!(matches!(result, Err(KiraError::NothingToCommit)));
    }

    #[test]
    fn test_commit_no_changes_after_first_commit_returns_nothing_to_commit() {
        let (dir, repo) = init_repo();
        let sig = test_sig();
        write_file(dir.path(), "a.txt", "x\n");
        stage_file(&repo, "a.txt").unwrap();
        commit(&repo, &sig, "init").unwrap();

        let result = commit(&repo, &sig, "should fail");
        assert!(matches!(result, Err(KiraError::NothingToCommit)));
    }

    #[test]
    fn test_commit_during_merge_state_returns_repository_not_clean() {
        let (dir, repo) = init_repo();
        let sig = test_sig();
        write_file(dir.path(), "a.txt", "v1\n");
        stage_file(&repo, "a.txt").unwrap();
        commit(&repo, &sig, "init").unwrap();

        let head_oid = repo.head().unwrap().target().unwrap().to_string();
        fs::write(dir.path().join(".git/MERGE_HEAD"), format!("{head_oid}\n")).unwrap();

        write_file(dir.path(), "a.txt", "v2\n");
        stage_file(&repo, "a.txt").unwrap();

        let result = commit(&repo, &sig, "should fail");
        assert!(matches!(result, Err(KiraError::RepositoryNotClean)));
    }

    #[test]
    fn test_check_identity_configured_with_both_set_returns_true() {
        let (_dir, repo) = init_repo();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Test User").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        assert!(check_identity_configured(&repo));
    }

    #[test]
    fn test_check_identity_configured_with_empty_local_overrides_global_returns_false() {
        // local 設空字串會覆蓋 global config（git2 預設 merge 行為），
        // 模擬 user 主動清空 local identity 的情境。
        // 不測試「local 完全沒設」場景：實際結果取決於 host global gitconfig，
        // 無法在 CI / 不同開發機器間一致 reproduce。
        let (_dir, repo) = init_repo();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "").unwrap();
        cfg.set_str("user.email", "").unwrap();
        assert!(!check_identity_configured(&repo));
    }

    #[test]
    fn test_stage_all_mixed_new_modified_deleted_all_staged() {
        let (dir, repo) = init_repo();
        let sig = test_sig();
        // baseline commit with two tracked files
        write_file(dir.path(), "kept.txt", "v1\n");
        write_file(dir.path(), "removed.txt", "v1\n");
        stage_file(&repo, "kept.txt").unwrap();
        stage_file(&repo, "removed.txt").unwrap();
        commit_initial(&repo, &sig);

        // mutate working tree: new file + modified + deleted
        write_file(dir.path(), "added.txt", "new\n");
        write_file(dir.path(), "kept.txt", "v2\n");
        fs::remove_file(dir.path().join("removed.txt")).unwrap();

        stage_all(&repo).unwrap();

        let added = repo.status_file(Path::new("added.txt")).unwrap();
        let kept = repo.status_file(Path::new("kept.txt")).unwrap();
        let removed = repo.status_file(Path::new("removed.txt")).unwrap();
        assert!(added.intersects(Status::INDEX_NEW));
        assert!(kept.intersects(Status::INDEX_MODIFIED));
        assert!(removed.intersects(Status::INDEX_DELETED));
    }

    #[test]
    fn test_stage_all_empty_unstaged_is_noop() {
        let (_dir, repo) = init_repo();
        // unborn HEAD + empty worktree → no unstaged
        let result = stage_all(&repo);
        assert!(result.is_ok());
    }

    #[test]
    fn test_unstage_all_with_head_resets_to_head_version() {
        let (dir, repo) = init_repo();
        let sig = test_sig();
        write_file(dir.path(), "a.txt", "v1\n");
        write_file(dir.path(), "b.txt", "v1\n");
        stage_file(&repo, "a.txt").unwrap();
        stage_file(&repo, "b.txt").unwrap();
        commit_initial(&repo, &sig);

        write_file(dir.path(), "a.txt", "v2\n");
        write_file(dir.path(), "b.txt", "v2\n");
        stage_file(&repo, "a.txt").unwrap();
        stage_file(&repo, "b.txt").unwrap();

        unstage_all(&repo).unwrap();

        let a = repo.status_file(Path::new("a.txt")).unwrap();
        let b = repo.status_file(Path::new("b.txt")).unwrap();
        assert!(a.intersects(Status::WT_MODIFIED));
        assert!(!a.intersects(Status::INDEX_MODIFIED));
        assert!(b.intersects(Status::WT_MODIFIED));
        assert!(!b.intersects(Status::INDEX_MODIFIED));
    }

    #[test]
    fn test_unstage_all_unborn_branch_removes_from_index() {
        let (dir, repo) = init_repo();
        write_file(dir.path(), "a.txt", "hello\n");
        write_file(dir.path(), "b.txt", "world\n");
        stage_file(&repo, "a.txt").unwrap();
        stage_file(&repo, "b.txt").unwrap();

        unstage_all(&repo).unwrap();

        let a = repo.status_file(Path::new("a.txt")).unwrap();
        let b = repo.status_file(Path::new("b.txt")).unwrap();
        assert!(a.intersects(Status::WT_NEW));
        assert!(!a.intersects(Status::INDEX_NEW));
        assert!(b.intersects(Status::WT_NEW));
        assert!(!b.intersects(Status::INDEX_NEW));
    }

    #[test]
    fn test_unstage_all_empty_staged_is_noop() {
        let (_dir, repo) = init_repo();
        let result = unstage_all(&repo);
        assert!(result.is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn test_stage_file_broken_symlink_stages_as_symlink_blob() {
        use std::os::unix::fs::symlink;
        let (dir, repo) = init_repo();
        symlink("/nonexistent/target", dir.path().join("link.txt")).unwrap();

        stage_file(&repo, "link.txt").unwrap();

        let index = repo.index().unwrap();
        assert!(
            index.get_path(Path::new("link.txt"), 0).is_some(),
            "broken symlink should be stageable; symlink_metadata sees the entry"
        );
    }
}
