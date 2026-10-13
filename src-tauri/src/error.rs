use serde::{ser::SerializeStruct, Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum KiraError {
    #[error("not a git repository")]
    NotARepo,

    #[error("permission denied")]
    PermissionDenied,

    #[error("repository is not open")]
    RepoNotOpen,

    #[error("commit not found: {0}")]
    CommitNotFound(String),

    #[error("file not found")]
    FileNotFound,

    #[error("file is not staged")]
    FileNotStaged,

    #[error("nothing to commit")]
    NothingToCommit,

    #[error("repository is in the middle of merge/rebase/cherry-pick")]
    RepositoryNotClean,

    #[error("commit message is empty")]
    EmptyMessage,

    #[error("commit message is too long")]
    MessageTooLong,

    #[error("invalid path")]
    InvalidPath,

    #[error("invalid clone URL")]
    InvalidUrl,

    #[error("invalid repo id")]
    InvalidRepoId,

    #[error("invalid remote name")]
    InvalidRemote,

    #[error("invalid branch name")]
    InvalidBranchName,

    // T10 branch operation error variants — SPEC.md `git_*_branch`.
    #[error("branch already exists")]
    BranchExists,

    #[error("branch not found")]
    BranchNotFound,

    #[error("base commit not found")]
    BaseNotFound,

    #[error("working tree has uncommitted changes")]
    DirtyTree,

    #[error("cannot delete the current branch")]
    CannotDeleteCurrent,

    #[error("branch has unmerged commits")]
    BranchUnmerged,

    #[error("checkout would cause conflicts")]
    CheckoutConflict,

    #[error("HEAD is unborn (no commits yet)")]
    UnbornHead,

    #[error("branch name conflicts with existing branch on case-insensitive filesystem")]
    BranchNameConflictCase,

    #[error("authentication required")]
    AuthFailed,

    #[error("network operation failed")]
    NetworkError,

    #[error("push rejected by remote")]
    PushRejected,

    #[error("merge conflict")]
    MergeConflict,

    #[error("git user identity not configured")]
    GitIdentityMissing,

    #[error("keyring access failed")]
    KeyringError,

    // T11a clone error variants — SPEC.md `git_clone_start` / `git_clone_cancel`.
    // DestExists is surfaced both by preflight (platform-noise aware) and libgit2
    // (ErrorCode::Exists). InsufficientDiskSpace is mapped from ErrorClass::Os with
    // ENOSPC-equivalent message (cross-platform substring match).
    // InvalidCloneId surfaces from CloneRegistry lookup misses (malformed or
    // already-settled clone_id). Cancelled is returned by clone_repo when any
    // sidecar callback observed `cancel_requested` and returned false.
    #[error("destination already exists and is not empty")]
    DestExists,

    #[error("insufficient disk space")]
    InsufficientDiskSpace,

    #[error("invalid clone id")]
    InvalidCloneId,

    #[error("clone already in progress for this destination")]
    CloneInProgress,

    #[error("operation cancelled")]
    Cancelled,

    // T12a GitHub PR error variants — SPEC.md `github_get_prs` / `github_get_pr_diff`.
    #[error("not a GitHub repository")]
    NotAGithubRepo,

    #[error("pull request not found")]
    PrNotFound,

    #[error("patch parse failed")]
    PatchParseFailed,

    /// PR 的 diff 太大：GitHub 回 406 too_large（超過 300 個檔，或超過它自己算的 20,000 行），或回應超過
    /// Kira 自己的 1 MB。再試也拿不到，右欄寫一條說明、不給 Retry（Phase 5c）
    #[error("pull request diff too large")]
    PrDiffTooLarge,

    #[error("API rate limited")]
    RateLimited { reset_at: Option<i64> },

    #[error(transparent)]
    Git(#[from] git2::Error),
}

/// reqwest 失敗（網路 / TLS / JSON parse / timeout）統一映射為 NetworkError。
/// 對 caller 屏蔽底層細節，避免 `reqwest::Error::source()` 的 path/URL/host 訊息經 `?` 流入
/// 上層 log；KiraError::NetworkError 的 Serialize 訊息已是 generic「network operation failed」。
impl From<reqwest::Error> for KiraError {
    fn from(_: reqwest::Error) -> Self {
        KiraError::NetworkError
    }
}

impl KiraError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotARepo => "NOT_A_REPO",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::RepoNotOpen => "REPO_NOT_OPEN",
            Self::CommitNotFound(_) => "COMMIT_NOT_FOUND",
            Self::FileNotFound => "FILE_NOT_FOUND",
            Self::FileNotStaged => "FILE_NOT_STAGED",
            Self::NothingToCommit => "NOTHING_TO_COMMIT",
            Self::RepositoryNotClean => "REPOSITORY_NOT_CLEAN",
            Self::EmptyMessage => "EMPTY_MESSAGE",
            Self::MessageTooLong => "MESSAGE_TOO_LONG",
            Self::InvalidPath => "INVALID_PATH",
            Self::InvalidUrl => "INVALID_URL",
            Self::InvalidRepoId => "INVALID_REPO_ID",
            Self::InvalidRemote => "INVALID_REMOTE",
            Self::InvalidBranchName => "INVALID_BRANCH_NAME",
            Self::BranchExists => "BRANCH_EXISTS",
            Self::BranchNotFound => "BRANCH_NOT_FOUND",
            Self::BaseNotFound => "BASE_NOT_FOUND",
            Self::DirtyTree => "DIRTY_TREE",
            Self::CannotDeleteCurrent => "CANNOT_DELETE_CURRENT",
            Self::BranchUnmerged => "BRANCH_UNMERGED",
            Self::CheckoutConflict => "CHECKOUT_CONFLICT",
            Self::UnbornHead => "UNBORN_HEAD",
            Self::BranchNameConflictCase => "BRANCH_NAME_CONFLICT_CASE",
            Self::AuthFailed => "AUTH_FAILED",
            Self::NetworkError => "NETWORK_ERROR",
            Self::PushRejected => "REJECTED",
            Self::MergeConflict => "CONFLICT",
            Self::GitIdentityMissing => "GIT_IDENTITY_MISSING",
            Self::KeyringError => "KEYRING_ERROR",
            Self::DestExists => "DEST_EXISTS",
            Self::InsufficientDiskSpace => "INSUFFICIENT_DISK_SPACE",
            Self::InvalidCloneId => "INVALID_CLONE_ID",
            Self::CloneInProgress => "CLONE_IN_PROGRESS",
            Self::Cancelled => "CANCELLED",
            Self::NotAGithubRepo => "NOT_A_GITHUB_REPO",
            Self::PrNotFound => "PR_NOT_FOUND",
            Self::PatchParseFailed => "PATCH_PARSE_FAILED",
            Self::PrDiffTooLarge => "PR_DIFF_TOO_LARGE",
            Self::RateLimited { .. } => "RATE_LIMITED",
            Self::Git(_) => "GIT_ERROR",
        }
    }
}

impl Serialize for KiraError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let fields = if matches!(self, Self::RateLimited { .. }) {
            3
        } else {
            2
        };
        let mut state = serializer.serialize_struct("KiraError", fields)?;
        state.serialize_field("code", self.code())?;
        let message = match self {
            Self::Git(_) => "git operation failed".to_string(),
            Self::CommitNotFound(_) => "commit not found".to_string(),
            Self::RateLimited { reset_at: Some(ts) } => {
                let secs_left = ts
                    - std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                if secs_left > 0 {
                    let mins = secs_left / 60;
                    let secs = secs_left % 60;
                    format!("API rate limited. Retry in {mins}m {secs}s")
                } else {
                    "API rate limited. Retry now".to_string()
                }
            }
            other => other.to_string(),
        };
        state.serialize_field("message", &message)?;
        // 重置時刻給右欄寫成「Try again after 14:32」（Phase 5c resetHint）：unix 秒，GitHub 沒給就是 null。
        // message 照舊（相對時間，序列化當下算的）
        if let Self::RateLimited { reset_at } = self {
            state.serialize_field("reset_at", reset_at)?;
        }
        state.end()
    }
}

pub type Result<T> = std::result::Result<T, KiraError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serialize_git_error_redacts_internal_message() {
        let leaky = git2::Error::from_str(
            "failed to resolve path '/Users/secret/project': No such file or directory",
        );
        let err = KiraError::Git(leaky);
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains(r#""code":"GIT_ERROR""#));
        assert!(json.contains(r#""message":"git operation failed""#));
        assert!(!json.contains("/Users/secret"));
    }

    #[test]
    fn test_serialize_classified_variants_keep_message() {
        let err = KiraError::RepoNotOpen;
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains(r#""code":"REPO_NOT_OPEN""#));
        assert!(json.contains("repository is not open"));
    }

    #[test]
    fn test_serialize_invalid_repo_id_keeps_message() {
        let err = KiraError::InvalidRepoId;
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains(r#""code":"INVALID_REPO_ID""#));
        assert!(json.contains("invalid repo id"));
    }

    #[test]
    fn test_serialize_commit_not_found_redacts_oid() {
        let err = KiraError::CommitNotFound("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef".to_string());
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains(r#""code":"COMMIT_NOT_FOUND""#));
        assert!(json.contains(r#""message":"commit not found""#));
        assert!(!json.contains("deadbeef"));
    }

    #[test]
    fn test_serialize_git_identity_missing_keeps_message() {
        let err = KiraError::GitIdentityMissing;
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains(r#""code":"GIT_IDENTITY_MISSING""#));
        assert!(json.contains(r#""message":"git user identity not configured""#));
    }

    #[test]
    fn test_serialize_t5_variants_have_correct_codes_and_generic_messages() {
        // 6 個 T5 新 variants：code 對應 SPEC.md，message 為 generic 不含路徑/URL/git2 raw 訊息
        let cases: &[(KiraError, &str, &str)] = &[
            (
                KiraError::AuthFailed,
                "AUTH_FAILED",
                "authentication required",
            ),
            (
                KiraError::NetworkError,
                "NETWORK_ERROR",
                "network operation failed",
            ),
            (
                KiraError::PushRejected,
                "REJECTED",
                "push rejected by remote",
            ),
            (KiraError::MergeConflict, "CONFLICT", "merge conflict"),
            (
                KiraError::InvalidRemote,
                "INVALID_REMOTE",
                "invalid remote name",
            ),
            (
                KiraError::InvalidBranchName,
                "INVALID_BRANCH_NAME",
                "invalid branch name",
            ),
        ];
        for (err, code, message) in cases {
            let json = serde_json::to_string(err).unwrap();
            assert!(
                json.contains(&format!(r#""code":"{code}""#)),
                "code mismatch for {err:?}: got {json}"
            );
            assert!(
                json.contains(&format!(r#""message":"{message}""#)),
                "message mismatch for {err:?}: got {json}"
            );
            // 不應含路徑/URL 字樣
            assert!(!json.contains("/"), "leaked path-like char: {json}");
            assert!(!json.contains("http"), "leaked URL: {json}");
        }
    }

    #[test]
    fn test_serialize_t11a_clone_variants_have_correct_codes_and_generic_messages() {
        // T11a：對齊 SPEC.md
        // git_clone_start Error variants 命名。InvalidCloneId / Cancelled
        // 跟其 caller 一起進後續 commit。
        let cases: &[(KiraError, &str, &str)] = &[
            (
                KiraError::DestExists,
                "DEST_EXISTS",
                "destination already exists and is not empty",
            ),
            (
                KiraError::InsufficientDiskSpace,
                "INSUFFICIENT_DISK_SPACE",
                "insufficient disk space",
            ),
            (
                KiraError::InvalidCloneId,
                "INVALID_CLONE_ID",
                "invalid clone id",
            ),
            (
                KiraError::CloneInProgress,
                "CLONE_IN_PROGRESS",
                "clone already in progress for this destination",
            ),
            (KiraError::Cancelled, "CANCELLED", "operation cancelled"),
        ];
        for (err, code, message) in cases {
            let json = serde_json::to_string(err).unwrap();
            assert!(
                json.contains(&format!(r#""code":"{code}""#)),
                "code mismatch for {err:?}: got {json}"
            );
            assert!(
                json.contains(&format!(r#""message":"{message}""#)),
                "message mismatch for {err:?}: got {json}"
            );
            assert!(!json.contains("/Users/"), "leaked /Users path: {json}");
            assert!(!json.contains("http"), "leaked URL: {json}");
        }
    }

    #[test]
    fn test_serialize_t12a_github_pr_variants_have_correct_codes_and_generic_messages() {
        let cases: &[(KiraError, &str, &str)] = &[
            (
                KiraError::NotAGithubRepo,
                "NOT_A_GITHUB_REPO",
                "not a GitHub repository",
            ),
            (
                KiraError::PrNotFound,
                "PR_NOT_FOUND",
                "pull request not found",
            ),
            (
                KiraError::PrDiffTooLarge,
                "PR_DIFF_TOO_LARGE",
                "pull request diff too large",
            ),
            (
                KiraError::PatchParseFailed,
                "PATCH_PARSE_FAILED",
                "patch parse failed",
            ),
            (
                KiraError::RateLimited { reset_at: None },
                "RATE_LIMITED",
                "API rate limited",
            ),
        ];
        for (err, code, message) in cases {
            let json = serde_json::to_string(err).unwrap();
            assert!(
                json.contains(&format!(r#""code":"{code}""#)),
                "code mismatch for {err:?}: got {json}"
            );
            assert!(
                json.contains(&format!(r#""message":"{message}""#)),
                "message mismatch for {err:?}: got {json}"
            );
        }
    }

    #[test]
    fn test_serialize_t10_branch_variants_have_correct_codes_and_generic_messages() {
        // T10：對齊 SPEC.md 命名
        let cases: &[(KiraError, &str, &str)] = &[
            (
                KiraError::BranchExists,
                "BRANCH_EXISTS",
                "branch already exists",
            ),
            (
                KiraError::BranchNotFound,
                "BRANCH_NOT_FOUND",
                "branch not found",
            ),
            (
                KiraError::BaseNotFound,
                "BASE_NOT_FOUND",
                "base commit not found",
            ),
            (
                KiraError::DirtyTree,
                "DIRTY_TREE",
                "working tree has uncommitted changes",
            ),
            (
                KiraError::CannotDeleteCurrent,
                "CANNOT_DELETE_CURRENT",
                "cannot delete the current branch",
            ),
            (
                KiraError::BranchUnmerged,
                "BRANCH_UNMERGED",
                "branch has unmerged commits",
            ),
            (
                KiraError::CheckoutConflict,
                "CHECKOUT_CONFLICT",
                "checkout would cause conflicts",
            ),
            (
                KiraError::UnbornHead,
                "UNBORN_HEAD",
                "HEAD is unborn (no commits yet)",
            ),
            (
                KiraError::BranchNameConflictCase,
                "BRANCH_NAME_CONFLICT_CASE",
                "branch name conflicts with existing branch on case-insensitive filesystem",
            ),
        ];
        for (err, code, message) in cases {
            let json = serde_json::to_string(err).unwrap();
            assert!(
                json.contains(&format!(r#""code":"{code}""#)),
                "code mismatch for {err:?}: got {json}"
            );
            assert!(
                json.contains(&format!(r#""message":"{message}""#)),
                "message mismatch for {err:?}: got {json}"
            );
            assert!(!json.contains("/Users/"), "leaked /Users path: {json}");
            assert!(!json.contains("http"), "leaked URL: {json}");
        }
    }

    #[test]
    fn test_serialize_rate_limited_with_reset_shows_human_readable() {
        let future_ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 120;
        let err = KiraError::RateLimited {
            reset_at: Some(future_ts),
        };
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains(r#""code":"RATE_LIMITED""#));
        assert!(json.contains("Retry in"), "expected human readable: {json}");
    }

    #[test]
    fn test_serialize_rate_limited_without_reset_generic_message() {
        let err = KiraError::RateLimited { reset_at: None };
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains(r#""message":"API rate limited""#));
        assert!(!json.contains("Retry after"));
    }

    /// 右欄把重置時刻寫成時鐘時刻（Phase 5c `resetHint`），所以送 unix 秒；message 照舊。
    /// 1791009120 = 2026-10-03 14:32 +08:00
    #[test]
    fn test_serialize_rate_limited_sends_reset_at() {
        let v = serde_json::to_value(KiraError::RateLimited {
            reset_at: Some(1_791_009_120),
        })
        .unwrap();
        assert_eq!(v["code"], "RATE_LIMITED");
        assert_eq!(v["reset_at"], 1_791_009_120, "{v}");
        assert!(
            v["message"]
                .as_str()
                .unwrap()
                .starts_with("API rate limited"),
            "{v}"
        );
    }

    /// GitHub 沒說幾點：欄位照樣在、值是 null（右欄寫「Try again later.」）
    #[test]
    fn test_serialize_rate_limited_without_reset_sends_null() {
        let v = serde_json::to_value(KiraError::RateLimited { reset_at: None }).unwrap();
        assert!(v.as_object().unwrap().contains_key("reset_at"), "{v}");
        assert!(v["reset_at"].is_null(), "{v}");
    }

    /// 只有 rate limit 帶重置時刻
    #[test]
    fn test_serialize_other_errors_have_no_reset_at() {
        for err in [KiraError::NetworkError, KiraError::AuthFailed] {
            let v = serde_json::to_value(&err).unwrap();
            assert!(!v.as_object().unwrap().contains_key("reset_at"), "{v}");
        }
    }
}
