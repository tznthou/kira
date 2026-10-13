use crate::error::{KiraError, Result};
use crate::fs::watcher::RepoWatcher;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const REPO_ID_LEN: usize = 21;

/// T11a Layer 1 capability gate: dest path must be registered
/// by `pick_clone_dest` (Rust-side dialog) before `git_clone_start` accepts it.
/// Lifetime 5 min — long enough for user to confirm in modal, short enough to
/// prevent stale renderer-controlled paths surviving across sessions.
pub const PENDING_CLONE_DEST_TTL: Duration = Duration::from_secs(300);

fn is_valid_repo_id(id: &str) -> bool {
    id.len() == REPO_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub struct RepoEntry {
    pub canonical_root: PathBuf,
    pub write_lock: Mutex<()>,
}

#[derive(Default)]
struct RegistryInner {
    by_id: HashMap<String, Arc<RepoEntry>>,
    by_path: HashMap<PathBuf, String>,
}

#[derive(Default)]
pub struct RepoRegistry {
    inner: Mutex<RegistryInner>,
}

impl RepoRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, canonical_root: PathBuf) -> String {
        let mut g = self.inner.lock().unwrap();
        if let Some(id) = g.by_path.get(&canonical_root) {
            return id.clone();
        }
        let id = nanoid::nanoid!();
        g.by_path.insert(canonical_root.clone(), id.clone());
        g.by_id.insert(
            id.clone(),
            Arc::new(RepoEntry {
                canonical_root,
                write_lock: Mutex::new(()),
            }),
        );
        id
    }

    pub fn resolve(&self, repo_id: &str) -> Result<Arc<RepoEntry>> {
        if !is_valid_repo_id(repo_id) {
            return Err(KiraError::InvalidRepoId);
        }
        self.inner
            .lock()
            .unwrap()
            .by_id
            .get(repo_id)
            .cloned()
            .ok_or(KiraError::InvalidRepoId)
    }
}

/// Tauri-managed lock holding canonical dest paths registered by
/// `pick_clone_dest`. `git_clone_start` checks the dest is present here
/// before accepting it — Layer 1 capability gate that prevents
/// webview-controlled raw paths from reaching the clone engine.
///
/// `register` adds a dest with current timestamp; `check` returns true if the
/// dest is registered and not yet expired. Entries past `PENDING_CLONE_DEST_TTL`
/// are pruned on each call so the map cannot grow unboundedly. `check` does
/// NOT consume so the engine can retry on the same registered dest (e.g. user
/// triggers second clone after first one failed network-side).
#[derive(Default)]
pub struct PendingCloneDestLock {
    inner: Mutex<HashMap<PathBuf, Instant>>,
}

impl PendingCloneDestLock {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a canonical dest path. Caller (commit 3 `pick_clone_dest`) must
    /// canonicalize before calling — the lock stores paths as-is, comparison is
    /// `PathBuf` equality.
    pub fn register(&self, dest: PathBuf) {
        let mut g = self.inner.lock().unwrap();
        Self::prune_expired(&mut g);
        g.insert(dest, Instant::now());
    }

    /// Check whether `dest` was registered and is not yet expired. Side effect:
    /// prunes expired entries.
    ///
    /// Non-consuming by design — a single picker call must support retry after
    /// network fail / cancel without re-picking. The entry survives until
    /// `PENDING_CLONE_DEST_TTL`. Review observation (M3): a successful
    /// clone leaves the entry intact for up to 5 minutes, so a second
    /// `git_clone_start` on the same dest within that window passes this
    /// check. Acceptable because downstream gates close the loop: the dest
    /// is now non-empty (clone wrote `.git/`), so `dest_is_effectively_empty`
    /// rejects with `DestExists`, and `try_reserve_dest` rejects concurrent
    /// in-flight retries with `CloneInProgress`. No exploit path reaches the
    /// engine.
    pub fn check(&self, dest: &Path) -> bool {
        let mut g = self.inner.lock().unwrap();
        Self::prune_expired(&mut g);
        g.contains_key(dest)
    }

    fn prune_expired(g: &mut HashMap<PathBuf, Instant>) {
        let now = Instant::now();
        g.retain(|_, ts| now.duration_since(*ts) < PENDING_CLONE_DEST_TTL);
    }
}

/// T9d：單一 active repo 的檔案 watcher 持有處（Tauri-managed state）。前端同時只顯示
/// 一個 active repo，故全 app 只保留一個 watcher；切 repo 時 `set` 換上新的、舊的在鎖外
/// drop（其 `Drop` 自動停 debounce thread + 釋放 OS watch handle），確保無洩漏。
pub struct ActiveWatcher {
    inner: Mutex<Option<RepoWatcher>>,
    generation: AtomicU64,
}

impl Default for ActiveWatcher {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }
}

impl ActiveWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn bump_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn set_if_current(&self, watcher: Option<RepoWatcher>, expected_gen: u64) {
        let old = {
            let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if self.generation.load(Ordering::SeqCst) != expected_gen {
                return;
            }
            std::mem::replace(&mut *g, watcher)
        };
        drop(old);
    }
}

/// `git_get_diff` 的閘：移出主執行緒之後，前端丟掉的請求後端照樣在算（libgit2 停不下來），
/// 快速換選取或換 repo 會讓好幾個重的 diff 同時算。這裡保證同時只算一個；排隊中、已經被
/// 新請求取代的直接回 `Cancelled`（前端本來就會丟掉它）。正在算的那個停不下來，新的要等它算完
/// ——跟以前在主執行緒排隊一樣，不會更糟。排隊等在 async 這層，不佔 blocking 執行緒。
/// 「新」看的是領到號碼的先後：號碼在 task 第一次執行時才領，不保證等於前端送出的順序（幾乎同時
/// 送出的兩個請求可能反過來）→ 目前的選取若被取代，前端（`DiffViewer`）會重送：每個較舊的請求
/// 只領一次號、最多這樣取代它一次，重送到它們都領過號就會成功（前端另設 5 次上限當保險）
#[derive(Default)]
pub struct DiffGate {
    running: tauri::async_runtime::Mutex<()>,
    latest: AtomicU64,
}

impl DiffGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// 領號碼 → 等前一個算完 → 已經不是最新的就跳過；是的話在 blocking 執行緒跑 `work`
    pub async fn run_latest<T, F>(&self, work: F) -> Result<T>
    where
        F: FnOnce() -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let ticket = self.latest.fetch_add(1, Ordering::SeqCst) + 1;
        let _running = self.running.lock().await;
        if self.latest.load(Ordering::SeqCst) != ticket {
            return Err(KiraError::Cancelled);
        }
        tauri::async_runtime::spawn_blocking(work)
            .await
            .unwrap_or_else(|e| {
                // release 是 panic = "abort"，走不到這裡；dev / 測試裡的 panic 記下來。
                // 不回 Cancelled：那只代表「被較新的請求取代」，前端看到會重送同一個 diff
                eprintln!("[kira] diff task failed: {e}");
                Err(KiraError::Git(git2::Error::from_str("diff task failed")))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn test_register_same_path_returns_same_id() {
        let registry = RepoRegistry::new();
        let path = PathBuf::from("/tmp/repo-a");
        let id1 = registry.register(path.clone());
        let id2 = registry.register(path);
        assert_eq!(id1, id2);
    }

    #[test]
    fn test_register_different_paths_returns_different_ids() {
        let registry = RepoRegistry::new();
        let id_a = registry.register(PathBuf::from("/tmp/repo-a"));
        let id_b = registry.register(PathBuf::from("/tmp/repo-b"));
        assert_ne!(id_a, id_b);
    }

    #[test]
    fn test_resolve_unknown_valid_format_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        // 21 char URL-safe，未註冊
        let result = registry.resolve("AAAAAAAAAAAAAAAAAAAAA");
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_resolve_oversize_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let huge = "A".repeat(1_000_000);
        let result = registry.resolve(&huge);
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_resolve_short_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        let result = registry.resolve("does-not-exist");
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_resolve_invalid_chars_id_returns_invalid_repo_id() {
        let registry = RepoRegistry::new();
        // 21 char 但含非 URL-safe 字元（空格、$）
        let result = registry.resolve("AAAAAAAAAA AAAAAAAAAA");
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
        let result = registry.resolve("AAAAAAAAAAA$AAAAAAAAA");
        assert!(matches!(result, Err(KiraError::InvalidRepoId)));
    }

    #[test]
    fn test_resolve_known_id_returns_entry() {
        let registry = RepoRegistry::new();
        let path = PathBuf::from("/tmp/repo-a");
        let id = registry.register(path.clone());
        let entry = registry.resolve(&id).unwrap();
        assert_eq!(entry.canonical_root, path);
    }

    #[test]
    fn test_pending_clone_dest_lock_check_unregistered_returns_false() {
        let lock = PendingCloneDestLock::new();
        assert!(!lock.check(&PathBuf::from("/tmp/never-registered")));
    }

    #[test]
    fn test_pending_clone_dest_lock_register_then_check_returns_true() {
        let lock = PendingCloneDestLock::new();
        let dest = PathBuf::from("/tmp/some-clone-target");
        lock.register(dest.clone());
        assert!(lock.check(&dest));
    }

    #[test]
    fn test_pending_clone_dest_lock_check_does_not_consume() {
        // T11a allows retry on same dest if first clone failed — check 不能消耗
        let lock = PendingCloneDestLock::new();
        let dest = PathBuf::from("/tmp/retry-target");
        lock.register(dest.clone());
        assert!(lock.check(&dest));
        assert!(lock.check(&dest));
        assert!(lock.check(&dest));
    }

    #[test]
    fn test_pending_clone_dest_lock_register_refreshes_timestamp() {
        // 同一 dest 多次 register 不該炸；register 是 idempotent + 更新 timestamp
        let lock = PendingCloneDestLock::new();
        let dest = PathBuf::from("/tmp/refresh-target");
        lock.register(dest.clone());
        lock.register(dest.clone());
        assert!(lock.check(&dest));
    }

    #[test]
    fn test_pending_clone_dest_lock_expired_entry_pruned_on_check() {
        // 用 inner 直接塞一筆過期 entry，驗 prune 機制
        let lock = PendingCloneDestLock::new();
        let dest = PathBuf::from("/tmp/expired-target");
        {
            let mut g = lock.inner.lock().unwrap();
            // 6 分鐘前 + TTL 5 分鐘 → 必過期
            let stale = Instant::now()
                .checked_sub(Duration::from_secs(360))
                .expect("Instant::checked_sub failed");
            g.insert(dest.clone(), stale);
        }
        assert!(!lock.check(&dest));
        // prune 後 entry 被移除
        assert!(lock.inner.lock().unwrap().is_empty());
    }

    #[test]
    fn test_pending_clone_dest_lock_distinct_paths_independent() {
        let lock = PendingCloneDestLock::new();
        let a = PathBuf::from("/tmp/a");
        let b = PathBuf::from("/tmp/b");
        lock.register(a.clone());
        assert!(lock.check(&a));
        assert!(!lock.check(&b));
    }

    #[test]
    fn test_write_lock_serializes_concurrent_access() {
        let registry = Arc::new(RepoRegistry::new());
        let id = registry.register(PathBuf::from("/tmp/repo-a"));
        let entry = registry.resolve(&id).unwrap();

        let hold_ms = 80u64;
        // A 拿到鎖才通知 B 去搶：B 一定在 A 持鎖期間開始等，先後不靠 sleep 安排
        let (held_tx, held_rx) = mpsc::channel();

        let entry_a = Arc::clone(&entry);
        let h_a = thread::spawn(move || {
            let g = entry_a.write_lock.lock().unwrap();
            held_tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(hold_ms));
            let released = Instant::now();
            drop(g);
            released
        });

        let entry_b = Arc::clone(&entry);
        let h_b = thread::spawn(move || {
            held_rx.recv().unwrap();
            let _g = entry_b.write_lock.lock().unwrap();
            Instant::now()
        });

        let a_released = h_a.join().unwrap();
        let b_acquired = h_b.join().unwrap();
        // 斷言兩段持鎖區間不重疊，不比 B 等了多久：排程延遲只會讓 B 更晚取得，
        // 不會讓這條變紅（量等待時長的寫法在 macOS runner 量到 39ms < 50ms 紅過）
        assert!(
            b_acquired >= a_released,
            "B 在 A 釋放前就取得鎖，鎖未序列化"
        );
    }

    /// 一個 diff 工作：進來時記下「同時在算幾個」的最大值
    fn diff_job(
        gate: &Arc<DiffGate>,
        running: &Arc<std::sync::atomic::AtomicUsize>,
        max_running: &Arc<std::sync::atomic::AtomicUsize>,
        name: &'static str,
    ) -> tokio::task::JoinHandle<Result<&'static str>> {
        let (gate, running, max_running) = (gate.clone(), running.clone(), max_running.clone());
        tokio::spawn(async move {
            gate.run_latest(move || {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                max_running.fetch_max(now, Ordering::SeqCst);
                running.fetch_sub(1, Ordering::SeqCst);
                Ok(name)
            })
            .await
        })
    }

    #[tokio::test]
    async fn test_diff_gate_runs_one_at_a_time_and_skips_superseded_requests() {
        use std::sync::atomic::AtomicUsize;
        let gate = Arc::new(DiffGate::new());
        let running = Arc::new(AtomicUsize::new(0));
        let max_running = Arc::new(AtomicUsize::new(0));

        // A 算到一半就停住，等測試放行
        let (started_tx, mut started_rx) = tauri::async_runtime::channel::<()>(1);
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let a = {
            let (gate, running, max_running) = (gate.clone(), running.clone(), max_running.clone());
            tokio::spawn(async move {
                gate.run_latest(move || {
                    let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                    max_running.fetch_max(now, Ordering::SeqCst);
                    started_tx.blocking_send(()).unwrap();
                    release_rx.recv().unwrap();
                    running.fetch_sub(1, Ordering::SeqCst);
                    Ok("A")
                })
                .await
            })
        };
        started_rx.recv().await.unwrap();

        // B、C 在 A 算到一半時進來：都領了號碼、排在 A 後面
        let b = diff_job(&gate, &running, &max_running, "B");
        let c = diff_job(&gate, &running, &max_running, "C");
        while gate.latest.load(Ordering::SeqCst) < 3 {
            tokio::task::yield_now().await;
        }
        release_tx.send(()).unwrap();

        assert_eq!(a.await.unwrap().unwrap(), "A");
        assert!(
            matches!(b.await.unwrap(), Err(KiraError::Cancelled)),
            "B 輪到時已經被 C 取代，應該跳過"
        );
        assert_eq!(c.await.unwrap().unwrap(), "C");
        assert_eq!(
            max_running.load(Ordering::SeqCst),
            1,
            "同時在算的 diff 不能超過一個"
        );
    }

    #[tokio::test]
    async fn test_diff_gate_panic_is_not_reported_as_superseded() {
        // `CANCELLED` 只代表「被較新的請求取代」：前端看到它會重送同一個 diff，
        // panic 若也回它，會讓同一個會壞的 diff 再跑好幾次（release 是 panic = "abort"，只有 dev / 測試走得到）
        let gate = DiffGate::new();
        let result = gate
            .run_latest(|| -> Result<()> { panic!("diff blew up") })
            .await;
        let err = result.unwrap_err();
        assert_ne!(
            err.code(),
            "CANCELLED",
            "a panic must not look like supersession"
        );
        assert_eq!(err.code(), "GIT_ERROR");
    }
}
