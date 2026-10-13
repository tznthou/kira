//! T9d 檔案系統 watcher：偵測 repo 的 `.git/` 被外部（terminal CLI / 其他工具）改動，
//! debounce 合併連續 event 後 emit `repo:external-change`，讓前端自動 refresh。
//!
//! 設計（方案 B+，經多方案評估 + 計畫審視定案）：
//! - **selective watch**：non-recursive watch gitdir root（HEAD/index/FETCH_HEAD/packed-refs/
//!   config…）+ recursive watch `refs/`（branch commit 動的是 refs/heads/*，不是 HEAD）。
//!   明確不 watch `objects/`（fetch/commit 海量 object writes 會撐爆 event queue）。
//! - **self-roll trailing debounce**（400ms）：不引入 notify-debouncer-full（MSRV 超標）。
//! - **gitdir 解析**靠 caller 傳入 `repo.path()`，正確處理 linked worktree / submodule 的
//!   `.git`-as-file 情境（`<root>/.git` 不一定是目錄）。
//! - notify 型別只在本檔內使用，對外 emit 自訂 payload → 換版/移除只動單檔。

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use git2::Repository;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const EXTERNAL_CHANGE_EVENT: &str = "repo:external-change";
const DEBOUNCE_MS: u64 = 400;

#[derive(Clone, Serialize)]
struct ExternalChangeEvent {
    repo_id: String,
}

/// 一個 active repo 的 watcher：持有 notify watcher + debounce thread。
/// `Drop` 時兩者都收掉（drop notify watcher → 其持有的 sender drop → debounce thread
/// 的 receiver disconnect → thread 退出 → join），確保切 repo / app 關閉時無洩漏。
/// 參考既有 `CloneSettleGuard` 的 RAII cleanup 紀律。
pub struct RepoWatcher {
    // Option 讓 Drop 能 take 出來控制 drop / join 順序；欄位本身不被讀，存在只為維持 watch。
    watcher: Option<RecommendedWatcher>,
    debounce: Option<JoinHandle<()>>,
}

impl RepoWatcher {
    /// 對 `workdir` 對應的 repo 啟動 selective watch。內部用 git2 `repo.path()` 解析
    /// 真實 gitdir（處理 linked worktree / submodule 的 `.git`-as-file 情境）。
    ///
    /// 失敗回 `Err`（caller 應 graceful degrade：log 後不啟用 watcher、不阻擋 open；
    /// 前端 window-focus 補刷仍可兜底）。個別 `watch()` 失敗（如全新 repo 還沒 `refs/`）
    /// 不致命，只 log，因 gitdir root 已涵蓋多數狀態檔。
    pub fn start(app: AppHandle, repo_id: String, workdir: &Path) -> notify::Result<Self> {
        Self::start_with_callback(
            workdir,
            move || {
                let _ = app.emit(
                    EXTERNAL_CHANGE_EVENT,
                    ExternalChangeEvent {
                        repo_id: repo_id.clone(),
                    },
                );
            },
            Duration::from_millis(DEBOUNCE_MS),
        )
    }

    /// `start` 的核心，把 `on_change` callback 與 debounce `window` 抽成參數，讓
    /// integration test 能用真實 fs 變更 + 短 window 驗證「.git 變動 → debounce → 觸發」
    /// 這條 end-to-end 路徑（不需 tauri AppHandle / 真實 emit）。production `start`
    /// 傳入「emit `ExternalChangeEvent`」與 `DEBOUNCE_MS`。
    fn start_with_callback(
        workdir: &Path,
        on_change: impl FnMut() + Send + 'static,
        window: Duration,
    ) -> notify::Result<Self> {
        let gitdir = resolve_gitdir(workdir);
        let (tx, rx) = mpsc::channel();
        let mut watcher = RecommendedWatcher::new(tx, Config::default())?;

        // gitdir root 涵蓋 HEAD/index/FETCH_HEAD/... 是必要 target；若所有 target 都
        // watch 失敗（FSEvents/inotify 資源不足等），watcher 形同 inert → 回 Err 讓 caller
        // graceful degrade（focus 補刷兜底），不回 Ok 裝成功（健全性審查）。
        let mut watched_any = false;
        let mut first_err = None;
        for (path, mode) in watch_targets(&gitdir) {
            match watcher.watch(&path, mode) {
                Ok(()) => watched_any = true,
                Err(e) => {
                    // path / notify error 可能含換行 → sanitize 防 log injection（安全審查）
                    let msg = format!("watcher.watch({}) failed: {e}", path.display())
                        .replace(['\n', '\r'], " ");
                    eprintln!("[kira] {msg}");
                    if first_err.is_none() {
                        first_err = Some(e);
                    }
                }
            }
        }
        if !watched_any {
            return Err(first_err.expect("no watch target succeeded but no error captured"));
        }

        let debounce = spawn_debounce(rx, on_change, window);

        Ok(Self {
            watcher: Some(watcher),
            debounce: Some(debounce),
        })
    }
}

impl Drop for RepoWatcher {
    fn drop(&mut self) {
        // 先 drop notify watcher：停 OS-level watch + drop 它持有的 sender，
        // 使 debounce thread 的 recv 收到 Disconnected 而退出。
        drop(self.watcher.take());
        if let Some(t) = self.debounce.take() {
            let _ = t.join();
        }
    }
}

/// 從 `workdir` 解析真實 gitdir（git2 `repo.path()`），正確處理 `.git`-as-file 的
/// linked worktree / submodule（`<workdir>/.git` 不一定是目錄）。caller 在 open 成功後
/// 才呼叫，故幾乎必成功；極端失敗（race 刪 repo）fallback 到 `<workdir>/.git`，後續
/// 個別 `watch()` 失敗會被 `start` 容錯吞掉。
fn resolve_gitdir(workdir: &Path) -> PathBuf {
    Repository::open(workdir)
        .map(|r| r.path().to_path_buf())
        .unwrap_or_else(|_| workdir.join(".git"))
}

/// selective watch 目標清單。gitdir root 用 non-recursive（涵蓋 HEAD / index /
/// FETCH_HEAD / ORIG_HEAD / MERGE_HEAD / packed-refs / config 等直屬檔）；`refs/` 用
/// recursive（涵蓋 refs/heads|tags|remotes）。明確排除 `objects/`。
fn watch_targets(gitdir: &Path) -> Vec<(PathBuf, RecursiveMode)> {
    vec![
        (gitdir.to_path_buf(), RecursiveMode::NonRecursive),
        (gitdir.join("refs"), RecursiveMode::Recursive),
    ]
}

/// Trailing debounce：收到第一個 event 後，持續吸收後續 event 直到靜默滿 `window`，
/// 才呼叫 `on_change` 一次 → 把一陣 burst（如 `git checkout` 同時動 HEAD+index+refs）
/// coalesce 成單次 refresh。`rx` disconnect（watcher 被 drop）時退出。
///
/// 泛型 `T`：debounce 不關心 event 內容，只關心「有沒有 event」→ 與 notify 型別解耦，
/// 純邏輯可單測（test 用 `Receiver<()>`，不需 tauri app）。
fn spawn_debounce<T: Send + 'static>(
    rx: Receiver<T>,
    mut on_change: impl FnMut() + Send + 'static,
    window: Duration,
) -> JoinHandle<()> {
    thread::spawn(move || loop {
        // 阻塞等第一個 event（無活動時不空轉）
        if rx.recv().is_err() {
            return; // disconnected
        }
        // 進入 debounce 窗口：每來一個 event 就重置，靜默滿 window 才跳出
        loop {
            match rx.recv_timeout(window) {
                Ok(_) => continue,
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        on_change();
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn debounce_coalesces_burst_into_single_call() {
        let (tx, rx) = mpsc::channel::<()>();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let window = Duration::from_millis(80);
        let handle = spawn_debounce(
            rx,
            move || {
                c.fetch_add(1, Ordering::SeqCst);
            },
            window,
        );

        // burst：連發 5 個 event，間隔遠小於 window
        for _ in 0..5 {
            tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(250)); // 等窗口 settle
        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "window 內的 burst 應 coalesce 成 1 次 on_change"
        );

        drop(tx);
        handle.join().unwrap();
    }

    #[test]
    fn debounce_emits_again_after_quiet_gap() {
        let (tx, rx) = mpsc::channel::<()>();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let window = Duration::from_millis(60);
        let handle = spawn_debounce(
            rx,
            move || {
                c.fetch_add(1, Ordering::SeqCst);
            },
            window,
        );

        tx.send(()).unwrap();
        thread::sleep(Duration::from_millis(180)); // 等第一次 settle
        tx.send(()).unwrap();
        thread::sleep(Duration::from_millis(180)); // 等第二次 settle
        assert_eq!(
            count.load(Ordering::SeqCst),
            2,
            "兩次活動間隔 > window 應分別觸發（共 2 次）"
        );

        drop(tx);
        handle.join().unwrap();
    }

    #[test]
    fn debounce_thread_exits_on_disconnect() {
        let (tx, rx) = mpsc::channel::<()>();
        let handle = spawn_debounce(rx, || {}, Duration::from_millis(50));
        drop(tx); // sender 關閉 → thread 應退出，join 不 hang
        handle.join().unwrap();
    }

    #[test]
    fn watch_targets_covers_root_and_refs_excludes_objects() {
        let gitdir = Path::new("/tmp/some-repo/.git");
        let targets = watch_targets(gitdir);
        assert!(
            targets
                .iter()
                .any(|(p, m)| p == gitdir && matches!(m, RecursiveMode::NonRecursive)),
            "應 non-recursive watch gitdir root"
        );
        assert!(
            targets
                .iter()
                .any(|(p, m)| p == &gitdir.join("refs") && matches!(m, RecursiveMode::Recursive)),
            "應 recursive watch refs/"
        );
        assert!(
            !targets.iter().any(|(p, _)| p.ends_with("objects")),
            "明確不 watch objects/"
        );
    }

    #[test]
    fn resolve_gitdir_points_into_dotgit_for_normal_repo() {
        let dir = tempfile::tempdir().unwrap();
        Repository::init(dir.path()).unwrap();
        let gitdir = resolve_gitdir(dir.path());
        assert!(
            gitdir.to_string_lossy().contains(".git"),
            "一般 repo 的 gitdir 應指向 .git，實得 {gitdir:?}"
        );
    }

    // End-to-end（plan 風險區「watcher↔OS 整合」的自動化驗證，取代不可重複的手動 smoke）：
    // 真實 temp repo + 真實 .git/HEAD 寫入 → 經 notify watch + debounce → callback 觸發。
    // 有 fs 事件 timing 依賴（FSEvents / inotify 延遲），故 sleep margin 放寬。
    #[test]
    fn start_with_callback_fires_on_real_gitdir_write() {
        let dir = tempfile::tempdir().unwrap();
        Repository::init(dir.path()).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let _watcher = RepoWatcher::start_with_callback(
            dir.path(),
            move || {
                c.fetch_add(1, Ordering::SeqCst);
            },
            Duration::from_millis(80),
        )
        .unwrap();

        // 給 watcher 完成註冊的時間，再模擬外部 git 改 .git/HEAD
        thread::sleep(Duration::from_millis(150));
        std::fs::write(
            dir.path().join(".git").join("HEAD"),
            b"ref: refs/heads/other\n",
        )
        .unwrap();

        // 等 fs 事件延遲 + debounce window settle
        thread::sleep(Duration::from_millis(900));
        assert!(
            count.load(Ordering::SeqCst) >= 1,
            "真實 .git/HEAD 寫入應觸發至少一次 debounce callback"
        );
    }
}
