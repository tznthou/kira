use crate::error::{KiraError, Result};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard, PoisonError};

/// MVP 階段 hardcode；T9 收尾改 build.rs 注入避免 fork 共用
pub const GITHUB_CLIENT_ID: &str = "Ov23lixXH7urUvgnrhi9";
const KEYRING_SERVICE: &str = "kira-github";
const KEYRING_USERNAME: &str = "default";
const SCOPE: &str = "repo read:user";
const GITHUB_BASE: &str = "https://github.com";
pub(crate) const GITHUB_API_BASE: &str = "https://api.github.com";
const USER_AGENT: &str = "Kira-Git-GUI";

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// IPC-facing GitHub Device Flow polling 6 種 state。
/// `Success` 故意不帶 token：token 在 commands::github_poll_token 內 store_token 後即丟棄，
/// 永不跨 IPC 邊界，防 renderer / DevTools / 前端 logging / 未來 XSS 取得 repo-scope OAuth token
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PollOutcome {
    Success,
    AuthorizationPending,
    /// Server 要求 client 增加 polling interval；new_interval 是新的最小間隔（秒）
    SlowDown {
        new_interval: u64,
    },
    /// device_code 已過期（user 沒在 expires_in 內完成授權），整個 flow 重來
    ExpiredToken,
    /// User 在瀏覽器拒絕授權
    AccessDenied,
    /// 不該發生（incorrect_device_code / unsupported_grant_type / schema drift）
    Unexpected,
}

/// Internal polling result：只在 auth + commands module 流通，
/// 透過 `pub(crate)` 把 token 鎖在 Rust 邊界內
pub(crate) enum PollResult {
    Token(String),
    Other(PollOutcome),
}

#[derive(Debug, Deserialize)]
struct TokenResponseRaw {
    access_token: Option<String>,
    error: Option<String>,
    interval: Option<u64>,
}

/// Public wrapper：production 對 https://github.com 發起 device code request
pub async fn request_device_code(client: &reqwest::Client) -> Result<DeviceCodeResponse> {
    request_device_code_at(client, GITHUB_BASE, GITHUB_CLIENT_ID, SCOPE).await
}

/// Internal IO layer，base_url 注入給 mock test 用。
/// reqwest::Error → KiraError::NetworkError 由 `From<reqwest::Error>` impl 自動完成（見 error.rs）
async fn request_device_code_at(
    client: &reqwest::Client,
    base_url: &str,
    client_id: &str,
    scope: &str,
) -> Result<DeviceCodeResponse> {
    let url = format!("{base_url}/login/device/code");
    let resp = client
        .post(&url)
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .form(&[("client_id", client_id), ("scope", scope)])
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(KiraError::NetworkError);
    }
    let body: DeviceCodeResponse = resp.json().await?;
    // 深度防禦：拒絕非 HTTPS verification_uri。正常情況 GitHub 永遠回 https://github.com/login/device，
    // 但若 reqwest TLS 配置失誤或上游回傳被改寫成 `javascript:alert(1)`，前端 anchor 會把
    // user-clicked URI 當作 webview RCE entry point（Tauri webview 對 javascript: scheme 不阻擋）。
    if !body.verification_uri.starts_with("https://") {
        return Err(KiraError::NetworkError);
    }
    Ok(body)
}

/// Public wrapper：對 https://github.com poll token
pub(crate) async fn poll_access_token(
    client: &reqwest::Client,
    device_code: &str,
) -> Result<PollResult> {
    poll_access_token_at(client, GITHUB_BASE, GITHUB_CLIENT_ID, device_code).await
}

async fn poll_access_token_at(
    client: &reqwest::Client,
    base_url: &str,
    client_id: &str,
    device_code: &str,
) -> Result<PollResult> {
    let url = format!("{base_url}/login/oauth/access_token");
    let resp = client
        .post(&url)
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .form(&[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await?;
    let body: TokenResponseRaw = resp.json().await?;
    if let Some(token) = body.access_token {
        return Ok(PollResult::Token(token));
    }
    Ok(PollResult::Other(map_error_to_outcome(
        body.error.as_deref(),
        body.interval,
    )))
}

fn map_error_to_outcome(err: Option<&str>, interval: Option<u64>) -> PollOutcome {
    match err {
        Some("authorization_pending") => PollOutcome::AuthorizationPending,
        Some("slow_down") => PollOutcome::SlowDown {
            new_interval: interval.unwrap_or(5),
        },
        Some("expired_token") => PollOutcome::ExpiredToken,
        Some("access_denied") => PollOutcome::AccessDenied,
        _ => PollOutcome::Unexpected,
    }
}

/// 取 GitHub user login (username) 給帳號鈕顯示；`api_base` 讓測試換成 mockito
pub(crate) async fn fetch_username_at(
    client: &reqwest::Client,
    api_base: &str,
    token: &str,
) -> Result<String> {
    let url = format!("{api_base}/user");
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", USER_AGENT)
        .send()
        .await?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(KiraError::AuthFailed);
    }
    if !resp.status().is_success() {
        return Err(KiraError::NetworkError);
    }
    let body: serde_json::Value = resp.json().await?;
    body.get("login")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or(KiraError::NetworkError)
}

// --- keyring storage ---

/// 放 GitHub token 的地方：app 裡是系統 keychain，測試換成記憶體裡的（測試不碰 keychain）
pub trait TokenStore: Send + Sync {
    fn load(&self) -> Result<Option<String>>;
    fn store(&self, token: &str) -> Result<()>;
    fn delete(&self) -> Result<()>;
}

/// 系統 keychain（keyring 3）
pub struct Keychain;

impl TokenStore for Keychain {
    fn load(&self) -> Result<Option<String>> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USERNAME)
            .map_err(|_| KiraError::KeyringError)?;
        match entry.get_password() {
            Ok(t) => Ok(Some(t)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(KiraError::KeyringError),
        }
    }

    fn store(&self, token: &str) -> Result<()> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USERNAME)
            .map_err(|_| KiraError::KeyringError)?;
        entry
            .set_password(token)
            .map_err(|_| KiraError::KeyringError)
    }

    fn delete(&self) -> Result<()> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USERNAME)
            .map_err(|_| KiraError::KeyringError)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(KiraError::KeyringError),
        }
    }
}

/// 登入存新 token 的同時，帶著舊 token 的請求可能正帶著 401 回來：存、登出、下面的「比對後刪除」都拿這把鎖，
/// 刪掉的就不會是比對之後才存進來的那一把
static TOKEN_LOCK: Mutex<()> = Mutex::new(());

fn token_lock() -> MutexGuard<'static, ()> {
    // 拿著鎖時 panic 不會留下寫一半的東西（每一步都是單一次 keychain 呼叫），照樣往下走
    TOKEN_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn store_token(token: &str) -> Result<()> {
    let _held = token_lock();
    Keychain.store(token)
}

pub fn load_token() -> Result<Option<String>> {
    Keychain.load()
}

pub fn delete_token() -> Result<()> {
    let _held = token_lock();
    Keychain.delete()
}

/// 帶著 `used` 的請求被 GitHub 回 401：那把 token 不能用了，忘掉它——只在存著的還是它的時候。
/// 請求在外面時重新登入，存進來的是新 token，舊請求晚到的 401 不能把它刪掉（Phase 5c；原本每個 401
/// 都刪掉當下存著的那一把）。比對與刪除在同一把鎖裡，中間不會有新 token 插進來
pub fn forget_rejected(store: &dyn TokenStore, used: &str) -> Result<()> {
    let _held = token_lock();
    match store.load()? {
        Some(current) if current == used => store.delete(),
        _ => Ok(()),
    }
}

/// 測試用的 keychain：load 依序回腳本裡的值、用完後一直回最後一個（模擬請求在外面時有人登入，第二次讀到的
/// 就是新 token）；delete 計數並清空
#[cfg(test)]
pub(crate) mod test_store {
    use super::TokenStore;
    use crate::error::Result;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    pub(crate) struct ScriptedStore {
        reads: Mutex<VecDeque<Option<String>>>,
        deletes: Mutex<usize>,
    }

    impl ScriptedStore {
        pub(crate) fn new(reads: &[Option<&str>]) -> Self {
            Self {
                reads: Mutex::new(reads.iter().map(|r| r.map(String::from)).collect()),
                deletes: Mutex::new(0),
            }
        }

        pub(crate) fn holding(token: &str) -> Self {
            Self::new(&[Some(token)])
        }

        pub(crate) fn deletes(&self) -> usize {
            *self.deletes.lock().unwrap()
        }
    }

    impl TokenStore for ScriptedStore {
        fn load(&self) -> Result<Option<String>> {
            let mut reads = self.reads.lock().unwrap();
            Ok(if reads.len() > 1 {
                reads.pop_front().flatten()
            } else {
                reads.front().cloned().flatten()
            })
        }

        fn store(&self, token: &str) -> Result<()> {
            *self.reads.lock().unwrap() = VecDeque::from([Some(token.to_string())]);
            Ok(())
        }

        fn delete(&self) -> Result<()> {
            *self.deletes.lock().unwrap() += 1;
            *self.reads.lock().unwrap() = VecDeque::from([None]);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_store::ScriptedStore;
    use super::*;

    /// 請求帶著 T1 出去，401 回來之前有人登入、存了 T2：T2 留著（Phase 5c）
    #[test]
    fn test_forget_rejected_keeps_a_token_stored_since() {
        let store = ScriptedStore::holding("T2");
        forget_rejected(&store, "T1").unwrap();
        assert_eq!(store.deletes(), 0);
        assert_eq!(store.load().unwrap().as_deref(), Some("T2"));
    }

    /// GitHub 不收的就是存著的那一把：忘掉
    #[test]
    fn test_forget_rejected_forgets_the_token_github_rejected() {
        let store = ScriptedStore::holding("T1");
        forget_rejected(&store, "T1").unwrap();
        assert_eq!(store.deletes(), 1);
        assert_eq!(store.load().unwrap(), None);
    }

    /// 這期間已經登出、什麼都沒存：沒有要刪的
    #[test]
    fn test_forget_rejected_with_nothing_stored_deletes_nothing() {
        let store = ScriptedStore::new(&[None]);
        forget_rejected(&store, "T1").unwrap();
        assert_eq!(store.deletes(), 0);
    }

    #[test]
    fn test_map_error_to_outcome_authorization_pending() {
        let outcome = map_error_to_outcome(Some("authorization_pending"), None);
        assert!(matches!(outcome, PollOutcome::AuthorizationPending));
    }

    #[test]
    fn test_map_error_to_outcome_slow_down_with_interval() {
        let outcome = map_error_to_outcome(Some("slow_down"), Some(10));
        match outcome {
            PollOutcome::SlowDown { new_interval } => assert_eq!(new_interval, 10),
            _ => panic!("expected SlowDown"),
        }
    }

    #[test]
    fn test_map_error_to_outcome_slow_down_without_interval_defaults_5() {
        let outcome = map_error_to_outcome(Some("slow_down"), None);
        match outcome {
            PollOutcome::SlowDown { new_interval } => assert_eq!(new_interval, 5),
            _ => panic!("expected SlowDown with default 5"),
        }
    }

    #[test]
    fn test_map_error_to_outcome_expired_token() {
        let outcome = map_error_to_outcome(Some("expired_token"), None);
        assert!(matches!(outcome, PollOutcome::ExpiredToken));
    }

    #[test]
    fn test_map_error_to_outcome_access_denied() {
        let outcome = map_error_to_outcome(Some("access_denied"), None);
        assert!(matches!(outcome, PollOutcome::AccessDenied));
    }

    #[test]
    fn test_map_error_to_outcome_unknown_string_returns_unexpected() {
        let outcome = map_error_to_outcome(Some("incorrect_device_code"), None);
        assert!(matches!(outcome, PollOutcome::Unexpected));
    }

    #[test]
    fn test_map_error_to_outcome_none_returns_unexpected() {
        let outcome = map_error_to_outcome(None, None);
        assert!(matches!(outcome, PollOutcome::Unexpected));
    }

    /// 防 token 透過 Serialize 漏出 IPC 邊界——PollOutcome::Success 序列化不含 token / access 字串
    #[test]
    fn test_poll_outcome_success_serialization_does_not_leak_token() {
        let json = serde_json::to_string(&PollOutcome::Success).unwrap();
        assert!(
            !json.contains("token"),
            "PollOutcome::Success leaked token field: {json}"
        );
        assert!(
            !json.contains("access"),
            "PollOutcome::Success leaked access field: {json}"
        );
        assert_eq!(json, r#"{"kind":"success"}"#);
    }

    #[tokio::test]
    async fn test_request_device_code_at_success_returns_response() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/login/device/code")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "device_code": "abc123",
                    "user_code": "WDJB-MJHT",
                    "verification_uri": "https://github.com/login/device",
                    "expires_in": 900,
                    "interval": 5
                }"#,
            )
            .create_async()
            .await;
        let client = reqwest::Client::new();

        let resp = request_device_code_at(&client, &server.url(), "test-id", "repo")
            .await
            .unwrap();
        assert_eq!(resp.user_code, "WDJB-MJHT");
        assert_eq!(resp.interval, 5);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_request_device_code_at_rejects_non_https_verification_uri() {
        // 防 MITM/upstream-drift 改寫 verification_uri 成 `javascript:` 等可在 webview 觸發 RCE 的 scheme
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("POST", "/login/device/code")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "device_code": "abc",
                    "user_code": "X",
                    "verification_uri": "javascript:alert(1)",
                    "expires_in": 900,
                    "interval": 5
                }"#,
            )
            .create_async()
            .await;
        let client = reqwest::Client::new();
        let err = request_device_code_at(&client, &server.url(), "id", "repo")
            .await
            .unwrap_err();
        assert!(matches!(err, KiraError::NetworkError));
    }

    #[tokio::test]
    async fn test_request_device_code_at_500_returns_network_error() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("POST", "/login/device/code")
            .with_status(500)
            .create_async()
            .await;
        let client = reqwest::Client::new();

        let err = request_device_code_at(&client, &server.url(), "x", "repo")
            .await
            .unwrap_err();
        assert!(matches!(err, KiraError::NetworkError));
    }

    #[tokio::test]
    async fn test_poll_access_token_at_success_returns_token_internal() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("POST", "/login/oauth/access_token")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"access_token": "ghu_AAA", "token_type": "bearer", "scope": "repo"}"#)
            .create_async()
            .await;
        let client = reqwest::Client::new();

        let result = poll_access_token_at(&client, &server.url(), "id", "code")
            .await
            .unwrap();
        match result {
            PollResult::Token(token) => assert_eq!(token, "ghu_AAA"),
            _ => panic!("expected PollResult::Token"),
        }
    }

    #[tokio::test]
    async fn test_poll_access_token_at_authorization_pending() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("POST", "/login/oauth/access_token")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"error": "authorization_pending"}"#)
            .create_async()
            .await;
        let client = reqwest::Client::new();

        let result = poll_access_token_at(&client, &server.url(), "id", "code")
            .await
            .unwrap();
        assert!(matches!(
            result,
            PollResult::Other(PollOutcome::AuthorizationPending)
        ));
    }

    #[tokio::test]
    async fn test_poll_access_token_at_slow_down_with_server_interval() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("POST", "/login/oauth/access_token")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"error": "slow_down", "interval": 12}"#)
            .create_async()
            .await;
        let client = reqwest::Client::new();

        let result = poll_access_token_at(&client, &server.url(), "id", "code")
            .await
            .unwrap();
        match result {
            PollResult::Other(PollOutcome::SlowDown { new_interval }) => {
                assert_eq!(new_interval, 12)
            }
            _ => panic!("expected PollResult::Other(SlowDown)"),
        }
    }

    #[tokio::test]
    async fn test_fetch_username_at_success_returns_login() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("GET", "/user")
            .match_header("authorization", "Bearer ghu_TOKEN")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"login": "octocat", "id": 1}"#)
            .create_async()
            .await;
        let client = reqwest::Client::new();

        let username = fetch_username_at(&client, &server.url(), "ghu_TOKEN")
            .await
            .unwrap();
        assert_eq!(username, "octocat");
    }

    #[tokio::test]
    async fn test_fetch_username_at_401_returns_auth_failed() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("GET", "/user")
            .with_status(401)
            .create_async()
            .await;
        let client = reqwest::Client::new();

        let err = fetch_username_at(&client, &server.url(), "stale")
            .await
            .unwrap_err();
        assert!(matches!(err, KiraError::AuthFailed));
    }
}
