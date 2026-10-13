use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use git2::build::{CheckoutBuilder, RepoBuilder};
use git2::{CheckoutNotificationType, ErrorCode, FetchOptions, RemoteCallbacks};
use serde::Serialize;

use crate::error::{KiraError, Result};
use crate::git::clone_registry::CloneHandle;
use crate::git::remote::{classify_git_error, github_token_cred_callback, RemoteOp};

/// Phase boundary for clone progress events. Engine determines phase from
/// libgit2 transfer/checkout state; the IPC layer wires it to a throttled
/// Tauri emitter (`make_throttled_clone_emitter` in commands/git.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ClonePhase {
    Receiving,
    Resolving,
    CheckingOut,
}

/// macOS Finder / Windows Explorer drop these into otherwise-empty dirs.
/// libgit2's "non-empty" check only ignores `.` / `..`, so an effectively
/// empty Finder-created dest would fail DEST_EXISTS without preflight.
const PLATFORM_NOISE: &[&str] = &[".DS_Store", "desktop.ini", ".localized", "Thumbs.db"];

/// Returns true if `dest` does not exist, is empty, or contains only platform
/// noise files (engine rm-noises before invoking RepoBuilder::clone).
///
/// `pub(crate)` so the IPC layer can run this preflight synchronously before
/// `git_clone_start` returns to the frontend (Codex review finding: fast
/// terminal failures must be returned synchronously rather than racing the
/// `clone:done` event against the `git_clone_start` promise resolve).
pub(crate) fn dest_is_effectively_empty(dest: &Path) -> Result<bool> {
    let entries = match std::fs::read_dir(dest) {
        Ok(it) => it,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(_) => return Err(KiraError::InvalidPath),
    };
    for entry in entries {
        let entry = entry.map_err(|_| KiraError::InvalidPath)?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !PLATFORM_NOISE.contains(&name_str.as_ref()) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Best-effort rm of platform noise inside `dest`. Errors per file ignored —
/// libgit2's downstream EEXISTS handler will report DEST_EXISTS if we couldn't
/// clean enough to satisfy its empty check.
///
/// `pub(crate)` so the IPC layer can rm-noise synchronously after preflight,
/// keeping clone_repo's own preflight idempotent (effectively_empty check is
/// defense-in-depth — by the time clone_repo runs in spawn_blocking the IPC
/// layer has already cleaned noise files).
pub(crate) fn rm_platform_noise(dest: &Path) {
    let Ok(entries) = std::fs::read_dir(dest) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if PLATFORM_NOISE.contains(&name_str.as_ref()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Cancel-observed gate for sidecar callbacks. Returns `true` if the callback
/// should continue, `false` if cancel was requested (and `cancel_observed_in_callback`
/// has been set so the post-clone classifier can return `Cancelled`).
///
/// Centralizes the load → store → return-false pattern shared by
/// transfer_progress / sideband_progress / update_tips / checkout notify
/// (git2-rs 0.19 drops GIT_EUSER mapping; the AtomicBool flag is the source
/// of truth).
fn should_continue(handle: &CloneHandle) -> bool {
    if handle.cancel_requested.load(Ordering::Relaxed) {
        handle
            .cancel_observed_in_callback
            .store(true, Ordering::Relaxed);
        return false;
    }
    true
}

/// Synchronous clone engine. IPC layer (commit 7) wraps this in
/// `tokio::task::spawn_blocking`.
///
/// Cancel discipline:
/// - All four sidecar callbacks (transfer_progress / sideband_progress /
///   update_tips / checkout notify) read `handle.cancel_requested`; when true
///   they return false to abort *and* set `cancel_observed_in_callback` so
///   the post-clone error classifier can return `Cancelled` instead of the
///   network/generic fallback.
/// - git2-rs 0.19 drops `GIT_EUSER` mapping for `transfer_progress` return
///   false, so cancel detection cannot rely on `err.code() == ErrorCode::User`
///   alone — the AtomicBool flag is the source of truth.
///
/// Unborn HEAD: cloning an empty (no-commits) repo succeeds at fetch but the
/// checkout step fails with `ErrorCode::UnbornBranch`. SPEC.md treats this
/// as success (dest contains `.git/`, working tree empty, HEAD unborn).
///
/// `on_progress(phase, current, total, bytes)` is called from inside
/// `transfer_progress`. Commit 6 adds throttle + Tauri emit; commit 4 uses
/// the closure for unit-test instrumentation.
pub fn clone_repo<F>(url: &str, dest: &Path, handle: Arc<CloneHandle>, on_progress: F) -> Result<()>
where
    F: FnMut(ClonePhase, u32, u32, u64) + Send + 'static,
{
    if !dest_is_effectively_empty(dest)? {
        return Err(KiraError::DestExists);
    }
    rm_platform_noise(dest);

    // Single emitter shared across transfer (Receiving / Resolving) and
    // checkout (CheckingOut) callbacks. `Arc<Mutex<F>>` because the two
    // callbacks live in different closures with `'static` Send bounds.
    let emitter: Arc<Mutex<F>> = Arc::new(Mutex::new(on_progress));

    let mut callbacks = RemoteCallbacks::new();
    // Shared GitHub allowlist + keyring-token resolver (T5 push path).
    // Public HTTPS clones never trigger this callback; private GitHub repos
    // see USER_PASS_PLAINTEXT and pull the keyring token. Non-github HTTPS
    // hosts (incl. private GitLab / Bitbucket) are rejected by the
    // allowlist — caller surfaces AUTH_FAILED with hint "private repos are
    // GitHub-only" (SPEC T11a v1 limitation).
    callbacks.credentials(github_token_cred_callback);

    let cancel_xfer = Arc::clone(&handle);
    let emitter_xfer = Arc::clone(&emitter);
    callbacks.transfer_progress(move |stats| {
        if !should_continue(&cancel_xfer) {
            return false;
        }
        let total = stats.total_objects();
        let received = stats.received_objects();
        let (phase, current, gross, bytes) = if received < total {
            (
                ClonePhase::Receiving,
                received as u32,
                total as u32,
                stats.received_bytes() as u64,
            )
        } else {
            (
                ClonePhase::Resolving,
                stats.indexed_deltas() as u32,
                stats.total_deltas() as u32,
                0u64,
            )
        };
        if let Ok(mut g) = emitter_xfer.lock() {
            g(phase, current, gross, bytes);
        }
        true
    });

    let cancel_sb = Arc::clone(&handle);
    callbacks.sideband_progress(move |_data| should_continue(&cancel_sb));

    let cancel_tips = Arc::clone(&handle);
    callbacks.update_tips(move |_refname, _from, _to| should_continue(&cancel_tips));

    let mut fetch_options = FetchOptions::new();
    fetch_options.remote_callbacks(callbacks);
    // T11a v1 不下 LFS / submodule / shallow / mirror — SPEC limitation 段

    let mut checkout = CheckoutBuilder::new();
    let cancel_co = Arc::clone(&handle);
    checkout.notify_on(CheckoutNotificationType::all());
    checkout.notify(move |_notify_type, _path, _baseline, _target, _workdir| {
        should_continue(&cancel_co)
    });

    // CheckingOut phase emit. progress callback signature is
    // `FnMut(Option<&Path>, usize, usize)`; cannot abort (use notify above).
    // Bytes field is 0 since checkout doesn't transfer pack bytes.
    let emitter_co = Arc::clone(&emitter);
    checkout.progress(move |_path, current, total| {
        if let Ok(mut g) = emitter_co.lock() {
            g(ClonePhase::CheckingOut, current as u32, total as u32, 0u64);
        }
    });

    let mut builder = RepoBuilder::new();
    builder.fetch_options(fetch_options);
    builder.with_checkout(checkout);

    match builder.clone(url, dest) {
        Ok(_repo) => Ok(()),
        Err(e) => {
            if handle.cancel_observed_in_callback.load(Ordering::Relaxed) {
                return Err(KiraError::Cancelled);
            }
            // Unborn HEAD: empty repo clone, fetch succeeded but checkout
            // has no HEAD to extract. SPEC says treat as success.
            if matches!(e.code(), ErrorCode::UnbornBranch) {
                return Ok(());
            }
            Err(classify_git_error(&e, RemoteOp::Clone))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use std::fs;
    use std::sync::Mutex;
    use tempfile::TempDir;

    /// `format!("file://{}", path)` is only valid on Unix, where absolute paths
    /// start with `/`; on Windows it yields `file://C:\...`, which libgit2 takes
    /// as a literal path and cannot find.
    fn file_url(path: &Path) -> String {
        url::Url::from_file_path(path).unwrap().to_string()
    }

    /// Create a bare repo with a single commit at HEAD so clone-from-file:// works.
    fn init_bare_with_commit() -> TempDir {
        let bare = TempDir::new().unwrap();
        let working = TempDir::new().unwrap();
        let repo = Repository::init(working.path()).unwrap();
        fs::write(working.path().join("README.md"), "hello").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        let tree_oid = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = Signature::now("t11a", "t11a@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();
        // Push working repo into bare so file:// clone sees real refs
        let bare_repo = Repository::init_bare(bare.path()).unwrap();
        drop(bare_repo);
        let mut remote = repo.remote("bare", &file_url(bare.path())).unwrap();
        remote.push(&["refs/heads/main:refs/heads/main"], None).ok();
        // Fallback: try `master` if init created that
        remote
            .push(&["refs/heads/master:refs/heads/master"], None)
            .ok();
        bare
    }

    fn empty_bare() -> TempDir {
        let bare = TempDir::new().unwrap();
        Repository::init_bare(bare.path()).unwrap();
        bare
    }

    fn empty_dest_dir() -> TempDir {
        TempDir::new().unwrap()
    }

    type PhaseLog = Arc<Mutex<Vec<ClonePhase>>>;

    /// Capture phase emissions into a Vec for assertions.
    fn capture_emitter() -> (
        PhaseLog,
        impl FnMut(ClonePhase, u32, u32, u64) + Send + 'static,
    ) {
        let log: PhaseLog = Arc::new(Mutex::new(Vec::new()));
        let log_for_closure = Arc::clone(&log);
        let closure = move |phase: ClonePhase, _current: u32, _total: u32, _bytes: u64| {
            log_for_closure.lock().unwrap().push(phase);
        };
        (log, closure)
    }

    #[test]
    fn test_clone_repo_local_bare_with_commit_succeeds() {
        let bare = init_bare_with_commit();
        let dest = empty_dest_dir();
        // Force dest to not pre-exist — RepoBuilder::clone wants empty target
        let dest_path = dest.path().join("clone-target");
        let url = file_url(bare.path());
        let handle = Arc::new(CloneHandle::new());
        let (_log, on_progress) = capture_emitter();

        clone_repo(&url, &dest_path, handle, on_progress).expect("clone should succeed");

        // .git/ exists in dest
        assert!(dest_path.join(".git").exists());
    }

    #[test]
    fn test_clone_repo_emits_checkingout_phase_during_checkout() {
        // SPEC: CheckingOut phase must reach the emitter via
        // CheckoutBuilder::progress, otherwise frontend would freeze at
        // 100% after Resolving while libgit2 writes files.
        let bare = init_bare_with_commit();
        let dest = empty_dest_dir();
        let dest_path = dest.path().join("clone-target");
        let url = file_url(bare.path());
        let handle = Arc::new(CloneHandle::new());
        let (log, on_progress) = capture_emitter();

        clone_repo(&url, &dest_path, handle, on_progress).expect("clone should succeed");

        let phases = log.lock().unwrap();
        // For file:// + single-file commit, transfer is typically too small
        // to fire transfer_progress, but checkout always fires for the README.
        assert!(
            phases.contains(&ClonePhase::CheckingOut),
            "expected at least one CheckingOut emit; got {phases:?}"
        );
    }

    #[test]
    fn test_clone_repo_empty_bare_returns_ok_with_unborn_head() {
        // SPEC: cloning a no-commit repo → success, dest has .git/, HEAD unborn
        let bare = empty_bare();
        let dest = empty_dest_dir();
        let dest_path = dest.path().join("clone-target");
        let url = file_url(bare.path());
        let handle = Arc::new(CloneHandle::new());
        let (_log, on_progress) = capture_emitter();

        clone_repo(&url, &dest_path, handle, on_progress)
            .expect("clone of empty repo should succeed (unborn HEAD swallowed)");

        // .git/ should exist
        assert!(dest_path.join(".git").exists());
    }

    #[test]
    fn test_clone_repo_dest_with_non_noise_file_returns_dest_exists() {
        let bare = init_bare_with_commit();
        let dest = empty_dest_dir();
        let dest_path = dest.path().to_path_buf();
        fs::write(dest_path.join("hello.txt"), "blocker").unwrap();
        let url = file_url(bare.path());
        let handle = Arc::new(CloneHandle::new());
        let (_log, on_progress) = capture_emitter();

        let result = clone_repo(&url, &dest_path, handle, on_progress);
        assert!(
            matches!(result, Err(KiraError::DestExists)),
            "expected DestExists, got {result:?}"
        );
    }

    #[test]
    fn test_clone_repo_dest_with_only_platform_noise_succeeds() {
        // SPEC: dest containing only .DS_Store / desktop.ini etc. → effectively empty
        let bare = init_bare_with_commit();
        let dest = empty_dest_dir();
        let dest_path = dest.path().to_path_buf();
        fs::write(dest_path.join(".DS_Store"), "noise").unwrap();
        fs::write(dest_path.join("Thumbs.db"), "noise").unwrap();
        let url = file_url(bare.path());
        let handle = Arc::new(CloneHandle::new());
        let (_log, on_progress) = capture_emitter();

        let result = clone_repo(&url, &dest_path, handle, on_progress);
        assert!(
            result.is_ok(),
            "expected clone to succeed after noise rm, got {result:?}"
        );
        assert!(dest_path.join(".git").exists());
    }

    #[test]
    fn test_clone_repo_cancelled_before_start_returns_cancelled() {
        // Pre-cancel: handle has cancel_requested=true before clone runs.
        // The first callback that runs (likely transfer_progress's "Counting"
        // or sideband_progress) sets cancel_observed_in_callback.
        let bare = init_bare_with_commit();
        let dest = empty_dest_dir();
        let dest_path = dest.path().join("clone-target");
        let url = file_url(bare.path());
        let handle = Arc::new(CloneHandle::new());
        handle.cancel_requested.store(true, Ordering::Relaxed);
        let (_log, on_progress) = capture_emitter();

        let result = clone_repo(&url, &dest_path, Arc::clone(&handle), on_progress);
        assert!(
            matches!(result, Err(KiraError::Cancelled)),
            "expected Cancelled, got {result:?}"
        );
        // Either side of the cancel check should have observed
        assert!(handle.cancel_observed_in_callback.load(Ordering::Relaxed));
    }

    #[test]
    fn test_dest_is_effectively_empty_nonexistent_dir() {
        let dest = empty_dest_dir().path().join("does-not-exist");
        assert!(dest_is_effectively_empty(&dest).unwrap());
    }

    #[test]
    fn test_dest_is_effectively_empty_empty_dir() {
        let dest = empty_dest_dir();
        assert!(dest_is_effectively_empty(dest.path()).unwrap());
    }

    #[test]
    fn test_dest_is_effectively_empty_with_real_file_returns_false() {
        let dest = empty_dest_dir();
        fs::write(dest.path().join("real.txt"), "x").unwrap();
        assert!(!dest_is_effectively_empty(dest.path()).unwrap());
    }

    #[test]
    fn test_dest_is_effectively_empty_only_noise_returns_true() {
        let dest = empty_dest_dir();
        fs::write(dest.path().join(".DS_Store"), "x").unwrap();
        fs::write(dest.path().join("desktop.ini"), "x").unwrap();
        fs::write(dest.path().join(".localized"), "x").unwrap();
        fs::write(dest.path().join("Thumbs.db"), "x").unwrap();
        assert!(dest_is_effectively_empty(dest.path()).unwrap());
    }

    #[test]
    fn test_rm_platform_noise_removes_only_listed_names() {
        let dest = empty_dest_dir();
        fs::write(dest.path().join(".DS_Store"), "x").unwrap();
        fs::write(dest.path().join("Thumbs.db"), "x").unwrap();
        fs::write(dest.path().join("keep.txt"), "x").unwrap();
        rm_platform_noise(dest.path());
        assert!(!dest.path().join(".DS_Store").exists());
        assert!(!dest.path().join("Thumbs.db").exists());
        assert!(dest.path().join("keep.txt").exists());
    }
}
