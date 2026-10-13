use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::{KiraError, Result};
use crate::state::PendingCloneDestLock;

/// SPEC.md `git_clone_start` dest length cap. Matches MAX_REPO_PATH_LEN used
/// throughout the repo for path bounds. Defensive only — OS native picker
/// never returns a path beyond filesystem limits.
const MAX_DEST_PATH_LEN: usize = 4096;

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct PickCloneDestResult {
    /// Canonicalized absolute path of the picked directory. Frontend stores
    /// this verbatim and sends it back to `git_clone_start`; backend
    /// re-canonicalizes and looks up `PendingCloneDestLock` for the gate.
    pub dest: String,
}

/// Canonicalize the picker's path and write it into `PendingCloneDestLock`.
/// Split from `pick_clone_dest_inner` so we can unit-test the
/// canonicalize/register pipeline without driving the OS dialog.
///
/// Returns:
/// - `InvalidPath` if canonicalize fails, path has non-UTF8, exceeds
///   `MAX_DEST_PATH_LEN`, or contains NUL.
/// - `Ok(PickCloneDestResult)` otherwise.
fn register_picked_dest(
    lock: &PendingCloneDestLock,
    raw_path: PathBuf,
) -> Result<PickCloneDestResult> {
    let canonical = std::fs::canonicalize(&raw_path).map_err(|_| KiraError::InvalidPath)?;
    if !canonical.is_absolute() {
        return Err(KiraError::InvalidPath);
    }
    let dest_str = canonical
        .to_str()
        .ok_or(KiraError::InvalidPath)?
        .to_string();
    if dest_str.is_empty() || dest_str.len() > MAX_DEST_PATH_LEN || dest_str.contains('\0') {
        return Err(KiraError::InvalidPath);
    }
    lock.register(canonical);
    Ok(PickCloneDestResult { dest: dest_str })
}

/// Picker 在 Rust 端開（webview 拿不到任意 path），從 OS 拿 folder →
/// canonicalize → 寫 `PendingCloneDestLock`。
/// 用戶取消 dialog 回 `Ok(None)`。dialog 走 Rust 端：
/// `capabilities/default.json` 不暴露 dialog plugin 給 webview，picker 必走
/// 本 IPC，否則 frontend 拿不到任意 path 寫進 lock。
///
/// 用 `pick_folder` 而非 `pick_file`：clone dest 是新建空目錄或 effectively
/// empty existing dir，picker UI 自然是 folder picker。
fn pick_clone_dest_inner(
    app: &AppHandle,
    lock: &PendingCloneDestLock,
) -> Result<Option<PickCloneDestResult>> {
    let Some(file_path) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|_| KiraError::InvalidPath)?;
    register_picked_dest(lock, path).map(Some)
}

/// `#[tauri::command(async)]`：對齊 `git_pick_and_open_repo` 紀律
/// （dialog 的 blocking API 要 async）：`blocking_pick_folder()` 把 dialog
/// 派到 main thread + block 當前 thread，sync command 跑 main thread 會
/// deadlock。`async` 讓 Tauri 用 worker thread 跑 sync body，main thread 自由
/// 處理 dialog event loop。
#[tauri::command(async)]
pub fn pick_clone_dest(
    app: AppHandle,
    lock: tauri::State<'_, PendingCloneDestLock>,
) -> Result<Option<PickCloneDestResult>> {
    pick_clone_dest_inner(&app, &lock)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_register_picked_dest_canonicalizes_and_registers() {
        let lock = PendingCloneDestLock::new();
        let tmp = TempDir::new().unwrap();
        let raw = tmp.path().to_path_buf();

        let result = register_picked_dest(&lock, raw).unwrap();
        assert!(!result.dest.is_empty());

        // canonical 寫進 lock，check 看得到
        let canonical = std::fs::canonicalize(tmp.path()).unwrap();
        assert!(lock.check(&canonical));
    }

    #[test]
    fn test_register_picked_dest_returns_canonical_form() {
        // 含 symlink-resolved / `..` 殘餘的原 path → canonicalize 後 dest
        // 應為解析後 absolute path
        let lock = PendingCloneDestLock::new();
        let tmp = TempDir::new().unwrap();
        let raw = tmp.path().join("subdir/..").join(".");
        std::fs::create_dir_all(&raw).unwrap();

        let result = register_picked_dest(&lock, raw).unwrap();
        let parsed = PathBuf::from(&result.dest);
        assert!(parsed.is_absolute());
        // canonical form 不含 `..`
        assert!(!result.dest.contains("/.."));
    }

    #[test]
    fn test_register_picked_dest_nonexistent_path_returns_invalid_path() {
        let lock = PendingCloneDestLock::new();
        let bogus = PathBuf::from("/tmp/this-path-must-not-exist-kira-t11a-test");
        let result = register_picked_dest(&lock, bogus);
        assert!(matches!(result, Err(KiraError::InvalidPath)));
    }

    #[test]
    fn test_register_picked_dest_writes_to_lock_for_subsequent_check() {
        // 模擬 git_clone_start 流程：pick → check
        let lock = PendingCloneDestLock::new();
        let tmp = TempDir::new().unwrap();

        let result = register_picked_dest(&lock, tmp.path().to_path_buf()).unwrap();

        // git_clone_start 會用 canonical 形態 lookup
        let dest_path = PathBuf::from(&result.dest);
        assert!(lock.check(&dest_path));
    }

    #[test]
    fn test_register_picked_dest_double_pick_refreshes_timestamp() {
        // 同一 dest 重複 pick（user 取消 modal 又重點）→ refresh timestamp，
        // 不 fail，後續 check 仍 true
        let lock = PendingCloneDestLock::new();
        let tmp = TempDir::new().unwrap();
        let raw = tmp.path().to_path_buf();

        let r1 = register_picked_dest(&lock, raw.clone()).unwrap();
        let r2 = register_picked_dest(&lock, raw).unwrap();
        assert_eq!(r1.dest, r2.dest);
        assert!(lock.check(&PathBuf::from(&r1.dest)));
    }
}
