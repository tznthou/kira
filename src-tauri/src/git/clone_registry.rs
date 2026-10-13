use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::error::{KiraError, Result};

const CLONE_ID_LEN: usize = 21;

fn is_valid_clone_id(id: &str) -> bool {
    id.len() == CLONE_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// In-flight clone handle owned by `CloneRegistry`.
///
/// `cancel_requested` is set by `git_clone_cancel` IPC; all RemoteCallbacks
/// and `CheckoutBuilder::notify` in the clone engine read this and return
/// false to abort transfer. When a callback returns false *because* cancel
/// was observed, it also sets `cancel_observed_in_callback = true` so the
/// engine can classify the resulting error as `Cancelled` rather than the
/// generic fallback (git2-rs 0.19 drops GIT_EUSER
/// mapping for `transfer_progress` return false).
pub struct CloneHandle {
    pub cancel_requested: AtomicBool,
    pub cancel_observed_in_callback: AtomicBool,
}

impl CloneHandle {
    pub fn new() -> Self {
        Self {
            cancel_requested: AtomicBool::new(false),
            cancel_observed_in_callback: AtomicBool::new(false),
        }
    }
}

impl Default for CloneHandle {
    fn default() -> Self {
        Self::new()
    }
}

/// Tauri-managed registry of in-flight clones. Maps URL-safe 21-char clone_id
/// to its `CloneHandle`. Keep behavior analogous to `RepoRegistry`:
///
/// - `register` issues a fresh nanoid clone_id and stores the handle.
/// - `lookup` returns the handle for an active clone_id or `InvalidCloneId`
///   for malformed / unknown / already-settled ids.
/// - `remove` is idempotent — clone settle path calls it once on success or
///   fail; double-call is harmless.
///
/// `active_dests` tracks dest paths currently held by an in-flight clone so
/// `git_clone_start` can reject duplicate concurrent clones on the same
/// destination (Codex review finding: without this gate, two concurrent clones
/// pass the `dest_is_effectively_empty` preflight, then RepoBuilder::clone's
/// auto-cleanup on failure can rm the other clone's working tree mid-write).
/// `try_reserve_dest` is atomic insert-if-absent; `release_dest` is called
/// from `run_clone_background` settle path so the dest becomes available
/// again for retry after success / fail / cancel.
#[derive(Default)]
pub struct CloneRegistry {
    inner: Mutex<HashMap<String, Arc<CloneHandle>>>,
    active_dests: Mutex<HashSet<PathBuf>>,
}

impl CloneRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register an in-flight clone. Returns the fresh clone_id (21-char
    /// URL-safe nanoid). The handle is stored as `Arc` so the engine thread
    /// and the cancel IPC can both hold references.
    pub fn register(&self, handle: Arc<CloneHandle>) -> String {
        let id = nanoid::nanoid!();
        self.inner.lock().unwrap().insert(id.clone(), handle);
        id
    }

    /// Look up a handle by clone_id. Returns `InvalidCloneId` if the id is
    /// malformed (length / chars), unknown, or already settled.
    pub fn lookup(&self, clone_id: &str) -> Result<Arc<CloneHandle>> {
        if !is_valid_clone_id(clone_id) {
            return Err(KiraError::InvalidCloneId);
        }
        self.inner
            .lock()
            .unwrap()
            .get(clone_id)
            .cloned()
            .ok_or(KiraError::InvalidCloneId)
    }

    /// Remove a handle after clone settles. Idempotent — removing an unknown
    /// id is a no-op so the engine settle path stays clean across success
    /// and fail branches.
    pub fn remove(&self, clone_id: &str) {
        self.inner.lock().unwrap().remove(clone_id);
    }

    /// Atomically reserve a dest path. Returns `true` if the dest was newly
    /// inserted (caller now owns it); `false` if another clone is already
    /// in-flight on this dest. Caller must `release_dest` from the settle
    /// path regardless of outcome (success or fail).
    pub fn try_reserve_dest(&self, dest: PathBuf) -> bool {
        self.active_dests.lock().unwrap().insert(dest)
    }

    /// Release a dest from the active set. Idempotent — releasing a never-
    /// reserved dest is a no-op so cancel races and double-settle paths stay
    /// safe.
    pub fn release_dest(&self, dest: &Path) {
        self.active_dests.lock().unwrap().remove(dest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn test_clone_handle_new_initial_state_is_not_cancelled() {
        let handle = CloneHandle::new();
        assert!(!handle.cancel_requested.load(Ordering::Relaxed));
        assert!(!handle.cancel_observed_in_callback.load(Ordering::Relaxed));
    }

    #[test]
    fn test_clone_handle_cancel_requested_is_observable_via_arc() {
        let handle = Arc::new(CloneHandle::new());
        let cloned = Arc::clone(&handle);
        cloned.cancel_requested.store(true, Ordering::Relaxed);
        // 原 handle 透過 Arc 也看得到
        assert!(handle.cancel_requested.load(Ordering::Relaxed));
    }

    #[test]
    fn test_register_returns_url_safe_21_char_id() {
        let registry = CloneRegistry::new();
        let id = registry.register(Arc::new(CloneHandle::new()));
        assert_eq!(id.len(), CLONE_ID_LEN);
        assert!(id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    }

    #[test]
    fn test_register_two_handles_returns_different_ids() {
        let registry = CloneRegistry::new();
        let id_a = registry.register(Arc::new(CloneHandle::new()));
        let id_b = registry.register(Arc::new(CloneHandle::new()));
        assert_ne!(id_a, id_b);
    }

    #[test]
    fn test_lookup_known_id_returns_handle() {
        let registry = CloneRegistry::new();
        let original = Arc::new(CloneHandle::new());
        let id = registry.register(Arc::clone(&original));
        let resolved = registry.lookup(&id).unwrap();
        assert!(Arc::ptr_eq(&original, &resolved));
    }

    #[test]
    fn test_lookup_unknown_valid_format_id_returns_invalid_clone_id() {
        let registry = CloneRegistry::new();
        // 21 char URL-safe but never registered
        let result = registry.lookup("AAAAAAAAAAAAAAAAAAAAA");
        assert!(matches!(result, Err(KiraError::InvalidCloneId)));
    }

    #[test]
    fn test_lookup_malformed_id_returns_invalid_clone_id() {
        let registry = CloneRegistry::new();
        // Too short
        assert!(matches!(
            registry.lookup("short"),
            Err(KiraError::InvalidCloneId)
        ));
        // Too long
        let huge = "A".repeat(1000);
        assert!(matches!(
            registry.lookup(&huge),
            Err(KiraError::InvalidCloneId)
        ));
        // Invalid chars (space / $)
        assert!(matches!(
            registry.lookup("AAAAAAAAAA AAAAAAAAAA"),
            Err(KiraError::InvalidCloneId)
        ));
        assert!(matches!(
            registry.lookup("AAAAAAAAAAA$AAAAAAAAA"),
            Err(KiraError::InvalidCloneId)
        ));
    }

    #[test]
    fn test_remove_then_lookup_returns_invalid_clone_id() {
        let registry = CloneRegistry::new();
        let id = registry.register(Arc::new(CloneHandle::new()));
        registry.remove(&id);
        assert!(matches!(
            registry.lookup(&id),
            Err(KiraError::InvalidCloneId)
        ));
    }

    #[test]
    fn test_remove_unknown_id_is_idempotent_noop() {
        let registry = CloneRegistry::new();
        // Removing a never-registered id must not panic
        registry.remove("AAAAAAAAAAAAAAAAAAAAA");
        registry.remove("nope");
    }

    #[test]
    fn test_try_reserve_dest_first_call_returns_true() {
        let registry = CloneRegistry::new();
        let dest = PathBuf::from("/tmp/dest-a");
        assert!(registry.try_reserve_dest(dest));
    }

    #[test]
    fn test_try_reserve_dest_duplicate_returns_false() {
        // Codex review finding: second concurrent clone on same dest must be rejected
        let registry = CloneRegistry::new();
        let dest = PathBuf::from("/tmp/dest-a");
        assert!(registry.try_reserve_dest(dest.clone()));
        assert!(!registry.try_reserve_dest(dest));
    }

    #[test]
    fn test_release_dest_then_re_reserve_returns_true() {
        // After settle, dest must be retry-able (network error / cancel +
        // user re-clicking Clone on same dest)
        let registry = CloneRegistry::new();
        let dest = PathBuf::from("/tmp/dest-a");
        assert!(registry.try_reserve_dest(dest.clone()));
        registry.release_dest(&dest);
        assert!(registry.try_reserve_dest(dest));
    }

    #[test]
    fn test_release_unreserved_dest_is_idempotent_noop() {
        let registry = CloneRegistry::new();
        registry.release_dest(Path::new("/tmp/never-reserved"));
    }

    #[test]
    fn test_distinct_dests_are_independently_reservable() {
        let registry = CloneRegistry::new();
        assert!(registry.try_reserve_dest(PathBuf::from("/tmp/a")));
        assert!(registry.try_reserve_dest(PathBuf::from("/tmp/b")));
        assert!(registry.try_reserve_dest(PathBuf::from("/tmp/c")));
    }
}
