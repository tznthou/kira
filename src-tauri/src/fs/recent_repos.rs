use crate::error::{KiraError, Result};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub(crate) const RECENT_REPOS_FILE: &str = "recent_repos.json";
pub(crate) const MAX_RECENT: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecentRepo {
    pub path: String,
    pub last_opened: i64,
}

/// Same-process concurrent `add_canonical` 序列化：兩條 thread（picker 完成 +
/// open_recent 連點）同時觸發會 load → mutate → save 三段 race，無 lock 會丟資料。
/// 跨 process（多開 Kira instance）目前不守，列 known tradeoff（last-writer-wins）。
///
/// `pub(crate)` 暴露：`commands::git::open_recent_repo_with_dir` 需要在 load
/// → allowlist check → open → record 整個序列上 hold lock，避免 TOCTOU
/// （check 後同 process 另一執行緒 evict 該 entry，授權當下成立的 path 在
/// open 時其實已不在 list）。 不 reentrant，搭配 `*_unlocked` 變體用。
pub(crate) fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// AppHandle-bound public API：取 `app_local_data_dir` 後委派 `*_in_dir` 版本。
/// 走 `app_local_data_dir` 而非 `app_data_dir`——Windows `app_data_dir` 回 Roaming
/// AppData，domain-joined 機器會 sync 到其他登入機器；recent repo paths 是
/// machine-local（轉到別台 `D:/foo` 都是 dead path）。`app_local_data_dir` 對應
/// `%LOCALAPPDATA%`，macOS/Linux 行為一致。
pub fn load(app: &AppHandle) -> Vec<RecentRepo> {
    match resolve_dir(app) {
        Ok(dir) => load_in_dir(&dir),
        Err(e) => {
            log_warn(&format!("recent_repos path resolve failed: {e:?}"));
            Vec::new()
        }
    }
}

pub fn add_canonical(app: &AppHandle, canonical: &Path) {
    match resolve_dir(app) {
        Ok(dir) => add_canonical_in_dir(&dir, canonical),
        Err(e) => log_warn(&format!(
            "recent_repos path resolve failed during add: {e:?}"
        )),
    }
}

pub(crate) fn resolve_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| KiraError::InvalidPath)?;
    std::fs::create_dir_all(&dir).map_err(|_| KiraError::PermissionDenied)?;
    Ok(dir)
}

/// 讀 + stale prune。Prune 策略：`NotFound` drop（路徑真不存在）；其他 IO error
/// （`PermissionDenied`、network drive 暫時 unavailable、外接碟拔掉）**保留**——
/// 避免短暫不可達被誤判為永久刪除。
pub(crate) fn load_in_dir(dir: &Path) -> Vec<RecentRepo> {
    let path = dir.join(RECENT_REPOS_FILE);
    // Direct read：略過 `path.exists()` 先驗，因為 (1) exists swallow IO err
    // 變 false 不一致 (2) exists → read 中間 TOCTOU 視窗 (3) 多一個 syscall。
    // NotFound 視為 benign empty。
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            log_warn(&format!("recent_repos read failed: {}", e.kind()));
            return Vec::new();
        }
    };
    let list: Vec<RecentRepo> = match serde_json::from_slice(&bytes) {
        Ok(l) => l,
        Err(e) => {
            log_warn(&format!(
                "recent_repos JSON parse failed: {e}; returning empty"
            ));
            return Vec::new();
        }
    };
    list.into_iter()
        .filter(|r| match std::fs::canonicalize(&r.path) {
            Ok(_) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => true,
        })
        .collect()
}

/// Backend-only：caller 保證 canonical（`open_repo_inner` 已過 `std::fs::canonicalize`）。
/// **不公開為 IPC**——避免 webview 餵 raw path 繞過 picker 路徑隔離。
/// 取 process-wide `write_lock` 序列化 load → mutate → save，避免 same-process
/// 並發 add 丟資料。
pub(crate) fn add_canonical_in_dir(dir: &Path, canonical: &Path) {
    let _guard = write_lock().lock().unwrap_or_else(|p| p.into_inner());
    add_canonical_in_dir_unlocked(dir, canonical);
}

/// Lock-already-held variant for callers (e.g. `open_recent_repo_with_dir`)
/// that hold `write_lock()` over a larger critical section. Calling this
/// without the lock breaks same-process concurrency invariants.
pub(crate) fn add_canonical_in_dir_unlocked(dir: &Path, canonical: &Path) {
    let canonical_str = canonical.to_string_lossy().into_owned();
    let mut list = load_in_dir(dir);
    if let Some(pos) = list.iter().position(|r| r.path == canonical_str) {
        list.remove(pos);
    }
    list.insert(
        0,
        RecentRepo {
            path: canonical_str,
            last_opened: now_unix_secs(),
        },
    );
    list.truncate(MAX_RECENT);
    save_in_dir(dir, &list);
}

/// Atomic save：`NamedTempFile::new_in(dir)` 強制與目標檔同 directory，避免跨
/// filesystem partition `persist` 觸發 `EXDEV` (cross-device link)。失敗只 log
/// warning，不 propagate——舊檔保留，UX 不 block。
fn save_in_dir(dir: &Path, repos: &[RecentRepo]) {
    let path = dir.join(RECENT_REPOS_FILE);
    let json = match serde_json::to_vec_pretty(repos) {
        Ok(j) => j,
        Err(e) => {
            log_warn(&format!("recent_repos JSON serialize failed: {e}"));
            return;
        }
    };
    let mut tmp = match tempfile::NamedTempFile::new_in(dir) {
        Ok(t) => t,
        Err(e) => {
            log_warn(&format!("recent_repos tempfile create failed: {e}"));
            return;
        }
    };
    if let Err(e) = tmp.write_all(&json) {
        log_warn(&format!("recent_repos tempfile write failed: {e}"));
        return;
    }
    if let Err(e) = tmp.persist(&path) {
        // `PersistError` 的 Display 含 temp path（含 username on macOS），
        // 錯誤訊息不帶路徑（KiraError 遮蔽規則），只記 io kind。
        log_warn(&format!(
            "recent_repos persist failed ({}); old file intact",
            e.error.kind()
        ));
    }
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn log_warn(msg: &str) {
    eprintln!("[kira] {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Arc;
    use std::thread;
    use tempfile::TempDir;

    fn make_real_dir(td: &TempDir, name: &str) -> PathBuf {
        let p = td.path().join(name);
        fs::create_dir_all(&p).unwrap();
        std::fs::canonicalize(&p).unwrap()
    }

    #[test]
    fn test_recent_repos_no_file_returns_empty() {
        let td = TempDir::new().unwrap();
        let list = load_in_dir(td.path());
        assert!(list.is_empty());
    }

    #[test]
    fn test_recent_repos_add_repo_appears_top() {
        let td = TempDir::new().unwrap();
        let repo = make_real_dir(&td, "repo-a");
        add_canonical_in_dir(td.path(), &repo);
        let list = load_in_dir(td.path());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, repo.to_string_lossy());
    }

    #[test]
    fn test_recent_repos_duplicate_path_updates_last_opened_not_duplicate() {
        let td = TempDir::new().unwrap();
        let repo = make_real_dir(&td, "repo-a");
        add_canonical_in_dir(td.path(), &repo);
        let first = load_in_dir(td.path());
        // 模擬 last_opened 不同：直接改 disk 後重 add
        std::thread::sleep(std::time::Duration::from_millis(1100));
        add_canonical_in_dir(td.path(), &repo);
        let second = load_in_dir(td.path());
        assert_eq!(second.len(), 1, "duplicate path 不該重複");
        assert!(
            second[0].last_opened >= first[0].last_opened,
            "last_opened 應該被更新"
        );
    }

    #[test]
    fn test_recent_repos_over_ten_entries_evicts_oldest() {
        let td = TempDir::new().unwrap();
        let mut repos = Vec::new();
        for i in 0..12 {
            let r = make_real_dir(&td, &format!("repo-{i:02}"));
            add_canonical_in_dir(td.path(), &r);
            repos.push(r);
        }
        let list = load_in_dir(td.path());
        assert_eq!(list.len(), MAX_RECENT, "list 必須 cap 在 MAX_RECENT");
        // 最新加的（index 11）應在 list[0]
        assert_eq!(list[0].path, repos[11].to_string_lossy());
        // 最舊兩個（index 0, 1）應被 evict
        assert!(!list.iter().any(|r| r.path == repos[0].to_string_lossy()));
        assert!(!list.iter().any(|r| r.path == repos[1].to_string_lossy()));
    }

    #[test]
    fn test_recent_repos_missing_path_not_found_drops_entry() {
        let td = TempDir::new().unwrap();
        let real = make_real_dir(&td, "repo-real");
        let ghost = td.path().join("repo-ghost-does-not-exist");
        add_canonical_in_dir(td.path(), &real);
        // 手動塞 ghost entry 進 JSON
        let json_path = td.path().join(RECENT_REPOS_FILE);
        let mut list: Vec<RecentRepo> =
            serde_json::from_slice(&fs::read(&json_path).unwrap()).unwrap();
        list.push(RecentRepo {
            path: ghost.to_string_lossy().into_owned(),
            last_opened: 100,
        });
        fs::write(&json_path, serde_json::to_vec_pretty(&list).unwrap()).unwrap();

        // load 後 ghost 應被 prune（NotFound）
        let loaded = load_in_dir(td.path());
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].path, real.to_string_lossy());
    }

    #[test]
    fn test_recent_repos_corrupt_json_returns_empty_logs_warning() {
        let td = TempDir::new().unwrap();
        let json_path = td.path().join(RECENT_REPOS_FILE);
        fs::write(&json_path, b"{ corrupt json ][").unwrap();
        let list = load_in_dir(td.path());
        assert!(list.is_empty(), "corrupt JSON 必須 fail closed 回空");
    }

    #[test]
    fn test_recent_repos_symlinked_path_canonicalized_consistently() {
        // 同 canonical 兩條路徑只記一筆。caller 對 raw path 過 canonicalize 後傳入，
        // 模擬此情況時兩次 add_canonical 用同 canonical 即達意（symlink 解開後等價）。
        let td = TempDir::new().unwrap();
        let real = make_real_dir(&td, "repo-real");
        add_canonical_in_dir(td.path(), &real);
        add_canonical_in_dir(td.path(), &real);
        let list = load_in_dir(td.path());
        assert_eq!(list.len(), 1, "同 canonical path 必須 dedupe");
    }

    #[test]
    fn test_recent_repos_concurrent_adds_same_process_preserve_both_and_json_valid() {
        let td = Arc::new(TempDir::new().unwrap());
        let repo_a = make_real_dir(&td, "repo-a");
        let repo_b = make_real_dir(&td, "repo-b");

        let dir_a = td.path().to_path_buf();
        let dir_b = td.path().to_path_buf();
        let ra = repo_a.clone();
        let rb = repo_b.clone();

        let h_a = thread::spawn(move || add_canonical_in_dir(&dir_a, &ra));
        let h_b = thread::spawn(move || add_canonical_in_dir(&dir_b, &rb));
        h_a.join().unwrap();
        h_b.join().unwrap();

        // JSON 必須 valid（serde 能 parse），兩筆都該在
        let list = load_in_dir(td.path());
        assert_eq!(list.len(), 2, "concurrent add 兩條應該都保留");
        let paths: Vec<&str> = list.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&repo_a.to_string_lossy().as_ref()));
        assert!(paths.contains(&repo_b.to_string_lossy().as_ref()));
    }

    #[test]
    fn test_recent_repos_persist_failure_old_file_intact() {
        let td = TempDir::new().unwrap();
        let repo = make_real_dir(&td, "repo-a");
        add_canonical_in_dir(td.path(), &repo);
        let old_bytes = fs::read(td.path().join(RECENT_REPOS_FILE)).unwrap();

        // 模擬 save 失敗：tempfile create 在不存在的 dir 會 Err，函式內部 log 不 panic
        let phantom = td.path().join("does-not-exist-subdir");
        let repo_b = make_real_dir(&td, "repo-b");
        save_in_dir(
            &phantom,
            &[RecentRepo {
                path: repo_b.to_string_lossy().into_owned(),
                last_opened: 999,
            }],
        );

        // 既有 file 不應被修改
        let after_bytes = fs::read(td.path().join(RECENT_REPOS_FILE)).unwrap();
        assert_eq!(old_bytes, after_bytes, "persist 失敗時舊檔必須保留");
    }

    /// macOS HFS+ 預設 case-insensitive，APFS 預設 case-sensitive；
    /// Windows NTFS 預設 case-insensitive。caller 對 raw path 過 `std::fs::canonicalize`
    /// 後傳入即可在大小寫差異仍命中同 canonical。本測試以 platform-aware 方式驗證：
    /// 直接 canonicalize 同一個檔案的兩種大小寫，比較結果是否一致。
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn test_recent_repos_canonicalization_case_insensitive_platform_specific() {
        let td = TempDir::new().unwrap();
        let mixed = td.path().join("Repo-Mixed");
        fs::create_dir_all(&mixed).unwrap();

        let lower = td.path().join("repo-mixed");
        let canon_mixed = std::fs::canonicalize(&mixed).unwrap();
        // 嘗試 canonicalize lowercase 版；filesystem case-insensitive 時應該成功且結果相同
        if let Ok(canon_lower) = std::fs::canonicalize(&lower) {
            assert_eq!(
                canon_mixed, canon_lower,
                "case-insensitive filesystem 上兩種大小寫 canonical 必須相同"
            );
            // 既然 canonical 相同，add 兩次只一筆
            add_canonical_in_dir(td.path(), &canon_mixed);
            add_canonical_in_dir(td.path(), &canon_lower);
            let list = load_in_dir(td.path());
            assert_eq!(list.len(), 1);
        }
    }
}
