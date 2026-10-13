use crate::error::{KiraError, Result};
use crate::git::diff::DiffResult;
use crate::github::auth::{
    self, DeviceCodeResponse, Keychain, PollOutcome, PollResult, TokenStore,
};
use crate::github::patch_parser;
use crate::github::pr::{self, PullRequest};
use crate::state::RepoRegistry;
use futures::stream::{self, StreamExt};
use serde::Serialize;
use std::time::Duration;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct AuthStatus {
    pub authenticated: bool,
    pub username: Option<String>,
}

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Centralized HTTP client with overall request timeout。
/// `reqwest::Client::new()` 預設沒有 overall timeout——TLS stall / proxy 卡住 / 網路半開
/// 會讓 `await` 永不返、device flow modal 無響應，使用者只能重啟 app。30 秒對 github.com
/// 已寬裕，同時把卡死時間 bound 到 user 可感知範圍。
fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|_| KiraError::NetworkError)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn github_start_device_flow() -> Result<DeviceCodeResponse> {
    let client = http_client()?;
    auth::request_device_code(&client).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn github_poll_token(device_code: String) -> Result<PollOutcome> {
    let client = http_client()?;
    match auth::poll_access_token(&client, &device_code).await? {
        PollResult::Token(token) => {
            // Token 進 keyring 後立刻丟棄；IPC 對 webview 永遠回 tokenless `Success`
            auth::store_token(&token)?;
            Ok(PollOutcome::Success)
        }
        PollResult::Other(outcome) => Ok(outcome),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn github_logout() -> Result<()> {
    auth::delete_token()
}

fn resolve_github_owner_repo(registry: &RepoRegistry, repo_id: &str) -> Result<(String, String)> {
    let entry = registry.resolve(repo_id)?;
    let repo =
        git2::Repository::open(&entry.canonical_root).map_err(|_| KiraError::NotAGithubRepo)?;
    let remote = repo
        .find_remote("origin")
        .map_err(|_| KiraError::NotAGithubRepo)?;
    let url = remote.url().ok_or(KiraError::NotAGithubRepo)?;
    pr::parse_github_owner_repo(url)
}

fn require_token() -> Result<String> {
    auth::load_token()?.ok_or(KiraError::AuthFailed)
}

/// GitHub 對帶著 `used` 的請求回 401：那把 token 不能用了，忘掉它（`forget_rejected` 決定是不是還存著它）。
/// 刪除寫在這裡、不在 `pr::check_response`：只有這一層知道請求帶的是哪一把
fn forget_if_rejected<T>(store: &dyn TokenStore, used: &str, result: Result<T>) -> Result<T> {
    if matches!(result, Err(KiraError::AuthFailed)) {
        let _ = auth::forget_rejected(store, used);
    }
    result
}

#[tauri::command(rename_all = "snake_case")]
pub async fn github_get_prs(
    registry: State<'_, RepoRegistry>,
    repo_id: String,
    state: String,
) -> Result<Vec<PullRequest>> {
    let (owner, repo) = resolve_github_owner_repo(&registry, &repo_id)?;
    let token = require_token()?;
    let client = http_client()?;
    let mut prs = forget_if_rejected(
        &Keychain,
        &token,
        pr::fetch_prs(&client, &owner, &repo, &state, &token).await,
    )?;

    const MAX_ENRICHMENT_CONCURRENCY: usize = 4;

    let tasks: Vec<_> = prs.iter().map(|p| (p.number, p.head_sha.clone())).collect();
    let results: Vec<_> = stream::iter(tasks.into_iter().map(|(number, sha)| {
        let client = client.clone();
        let owner = owner.clone();
        let repo = repo.clone();
        let token = token.clone();
        async move {
            let (review, checks) = futures::join!(
                pr::fetch_pr_reviews(&client, &owner, &repo, number, &token),
                pr::fetch_check_runs(&client, &owner, &repo, &sha, &token),
            );
            (review.unwrap_or(None), checks.unwrap_or(None))
        }
    }))
    .buffered(MAX_ENRICHMENT_CONCURRENCY)
    .collect()
    .await;
    for (pr, (review_state, check_status)) in prs.iter_mut().zip(results) {
        pr.review_state = review_state;
        pr.check_status = check_status;
    }

    Ok(prs)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn github_get_pr_diff(
    registry: State<'_, RepoRegistry>,
    repo_id: String,
    pr_number: u32,
) -> Result<DiffResult> {
    let (owner, repo) = resolve_github_owner_repo(&registry, &repo_id)?;
    let token = require_token()?;
    let client = http_client()?;
    let diff_text = forget_if_rejected(
        &Keychain,
        &token,
        pr::fetch_pr_diff(&client, &owner, &repo, pr_number, &token).await,
    )?;
    patch_parser::parse_unified_diff(&diff_text)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn github_get_auth_status() -> Result<AuthStatus> {
    auth_status(&Keychain, auth::GITHUB_API_BASE).await
}

/// 登入狀態：keychain 有沒有 token、GitHub 還收不收。測試換 `store` 與 `api_base`（mockito）
async fn auth_status(store: &dyn TokenStore, api_base: &str) -> Result<AuthStatus> {
    let Some(token) = store.load()? else {
        return Ok(AuthStatus {
            authenticated: false,
            username: None,
        });
    };
    let client = http_client()?;
    match auth::fetch_username_at(&client, api_base, &token).await {
        Ok(login) => Ok(AuthStatus {
            authenticated: true,
            username: Some(login),
        }),
        Err(KiraError::AuthFailed) => {
            // 401 = stored token rejected by GitHub（過期 / revoked）→ silently clear，
            // UI 重回 unauthenticated state；不向上拋 AuthFailed 避免 user 看到 misleading 提示
            let _ = auth::forget_rejected(store, &token);
            Ok(AuthStatus {
                authenticated: false,
                username: None,
            })
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::auth::test_store::ScriptedStore;

    /// 請求帶著 old 出去，401 回來時存的已經是 new（這期間有人登入）：new 留著（Phase 5c）
    #[test]
    fn test_a_401_leaves_a_token_stored_while_the_request_was_out() {
        let store = ScriptedStore::holding("new");
        let r: Result<()> = forget_if_rejected(&store, "old", Err(KiraError::AuthFailed));
        assert!(matches!(r, Err(KiraError::AuthFailed)));
        assert_eq!(store.deletes(), 0);
    }

    #[test]
    fn test_a_401_forgets_the_token_it_carried() {
        let store = ScriptedStore::holding("old");
        let r: Result<()> = forget_if_rejected(&store, "old", Err(KiraError::AuthFailed));
        assert!(matches!(r, Err(KiraError::AuthFailed)));
        assert_eq!(store.deletes(), 1);
    }

    /// 只有 401 才忘：網路錯誤、rate limit、成功都不動 token
    #[test]
    fn test_other_answers_forget_nothing() {
        let store = ScriptedStore::holding("old");
        for err in [
            KiraError::NetworkError,
            KiraError::RateLimited { reset_at: None },
        ] {
            let _ = forget_if_rejected::<()>(&store, "old", Err(err));
        }
        let _ = forget_if_rejected(&store, "old", Ok(()));
        assert_eq!(store.deletes(), 0);
    }

    /// 開機的登入狀態查詢帶著 old 出去，GitHub 回 401 之前有人登入、存了 new：new 留著；查詢照樣回未登入
    /// （前端只在「已登入」時寫入狀態，`Account.tsx`，所以不會把新登入蓋掉）
    #[tokio::test]
    async fn test_auth_status_401_leaves_a_token_stored_meanwhile() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/user")
            .with_status(401)
            .create_async()
            .await;
        let store = ScriptedStore::new(&[Some("old"), Some("new")]);
        let status = auth_status(&store, &server.url()).await.unwrap();
        assert!(!status.authenticated);
        assert_eq!(store.deletes(), 0);
    }

    #[tokio::test]
    async fn test_auth_status_401_forgets_the_rejected_token() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/user")
            .with_status(401)
            .create_async()
            .await;
        let store = ScriptedStore::holding("old");
        let status = auth_status(&store, &server.url()).await.unwrap();
        assert!(!status.authenticated);
        assert_eq!(store.deletes(), 1);
    }

    #[tokio::test]
    async fn test_auth_status_signed_in() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/user")
            .match_header("authorization", "Bearer old")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"login": "octocat"}"#)
            .create_async()
            .await;
        let store = ScriptedStore::holding("old");
        let status = auth_status(&store, &server.url()).await.unwrap();
        assert!(status.authenticated);
        assert_eq!(status.username.as_deref(), Some("octocat"));
        assert_eq!(store.deletes(), 0);
    }

    /// 沒有 token：不打 GitHub，直接未登入
    #[tokio::test]
    async fn test_auth_status_without_a_token() {
        let store = ScriptedStore::new(&[None]);
        let status = auth_status(&store, "http://127.0.0.1:9").await.unwrap();
        assert!(!status.authenticated);
        assert_eq!(store.deletes(), 0);
    }
}
