use crate::error::{KiraError, Result};
use crate::github::USER_AGENT;
use reqwest::header::{ACCEPT, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use url::Url;

const API_BASE: &str = "https://api.github.com";
const MAX_API_RESPONSE_SIZE: u64 = 2_097_152; // 2 MB

#[derive(Debug, Serialize)]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub state: String,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    pub head_sha: String,
    pub html_url: String,
    pub draft: bool,
    pub review_state: Option<String>,
    pub check_status: Option<String>,
}

#[derive(Deserialize)]
struct GhPullRaw {
    number: u32,
    title: String,
    state: String,
    user: Option<GhUser>,
    created_at: String,
    updated_at: String,
    head: GhHead,
    html_url: String,
    #[serde(default)]
    draft: bool,
}

#[derive(Deserialize)]
struct GhUser {
    login: String,
}

#[derive(Deserialize)]
struct GhHead {
    sha: String,
}

pub fn parse_github_owner_repo(remote_url: &str) -> Result<(String, String)> {
    let parsed = Url::parse(remote_url).map_err(|_| KiraError::NotAGithubRepo)?;
    if parsed.scheme() != "https" {
        return Err(KiraError::NotAGithubRepo);
    }
    if !matches!(parsed.host_str(), Some("github.com")) {
        return Err(KiraError::NotAGithubRepo);
    }
    if parsed.username() != "" {
        return Err(KiraError::NotAGithubRepo);
    }
    let path = parsed.path().trim_start_matches('/').trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<&str> = path.split('/').collect();
    match parts.as_slice() {
        [owner, repo] if !owner.is_empty() && !repo.is_empty() => {
            Ok((owner.to_string(), repo.to_string()))
        }
        _ => Err(KiraError::NotAGithubRepo),
    }
}

fn extract_rate_limit_reset(resp: &reqwest::Response) -> Option<i64> {
    resp.headers()
        .get("x-ratelimit-reset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
}

/// 把 GitHub 的回應狀態對到錯誤。401 只回 `AuthFailed`、不刪 token：要刪哪一把由 command 層決定
/// （`forget_if_rejected`，它知道這個請求帶的是哪一把）
async fn check_response(resp: reqwest::Response) -> Result<reqwest::Response> {
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(KiraError::AuthFailed);
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        if let Some(remaining) = resp.headers().get("x-ratelimit-remaining") {
            if remaining.to_str().unwrap_or("1") == "0" {
                let reset_at = extract_rate_limit_reset(&resp);
                return Err(KiraError::RateLimited { reset_at });
            }
        }
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let reset_at = extract_rate_limit_reset(&resp);
        return Err(KiraError::RateLimited { reset_at });
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(KiraError::PrNotFound);
    }
    if !status.is_success() {
        return Err(KiraError::NetworkError);
    }
    Ok(resp)
}

pub fn validate_pr_state(state: &str) -> Result<&str> {
    match state {
        "open" | "closed" | "all" => Ok(state),
        _ => Err(KiraError::InvalidPath),
    }
}

pub async fn fetch_prs(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    state: &str,
    token: &str,
) -> Result<Vec<PullRequest>> {
    let state = validate_pr_state(state)?;
    let resp = client
        .get(format!("{API_BASE}/repos/{owner}/{repo}/pulls"))
        .query(&[("state", state), ("per_page", "30")])
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header("User-Agent", USER_AGENT)
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await?;
    let resp = check_response(resp).await?;
    let raw: Vec<GhPullRaw> = resp.json().await.map_err(|_| KiraError::NetworkError)?;
    Ok(raw
        .into_iter()
        .map(|pr| PullRequest {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            author: pr.user.map_or_else(|| "unknown".to_string(), |u| u.login),
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            head_sha: pr.head.sha,
            html_url: pr.html_url,
            draft: pr.draft,
            review_state: None,
            check_status: None,
        })
        .collect())
}

const MAX_DIFF_RESPONSE_SIZE: u64 = 1_048_576; // 1 MB
/// 406 的說明是一小段 JSON（實測 1.5 KB）；比這個大就不讀，當一般的錯誤
const MAX_REFUSAL_SIZE: u64 = 64 * 1024;

/// GitHub 拒給這份 diff 是因為太大：406，`errors` 裡有 `too_large`（超過 300 個檔，或超過它自己算的
/// 20,000 行；2026-10-12 對 kubernetes 的 PR 實測，那個「行數」不是 additions + deletions）
async fn refused_as_too_large(resp: reqwest::Response) -> bool {
    if resp.content_length().is_some_and(|n| n > MAX_REFUSAL_SIZE) {
        return false;
    }
    let Ok(body) = resp.text().await else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("errors")?.as_array().cloned())
        .is_some_and(|errors| {
            errors
                .iter()
                .any(|e| e.get("code").and_then(|c| c.as_str()) == Some("too_large"))
        })
}

pub async fn fetch_pr_diff(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    pr_number: u32,
    token: &str,
) -> Result<String> {
    fetch_pr_diff_at(client, API_BASE, owner, repo, pr_number, token).await
}

/// `api_base` 讓測試換成 mockito
async fn fetch_pr_diff_at(
    client: &reqwest::Client,
    api_base: &str,
    owner: &str,
    repo: &str,
    pr_number: u32,
    token: &str,
) -> Result<String> {
    let url = format!("{api_base}/repos/{owner}/{repo}/pulls/{pr_number}");
    let resp = client
        .get(&url)
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header("User-Agent", USER_AGENT)
        .header(ACCEPT, "application/vnd.github.diff")
        .send()
        .await?;
    // 太大的 PR：GitHub 拒給（406 too_large），或照給但超過 Kira 自己的 1 MB。兩種都再試也拿不到，
    // 同一個碼，右欄寫一條說明、不給 Retry（Phase 5c）。其他 406 照舊是網路錯誤
    if resp.status() == reqwest::StatusCode::NOT_ACCEPTABLE {
        return Err(if refused_as_too_large(resp).await {
            KiraError::PrDiffTooLarge
        } else {
            KiraError::NetworkError
        });
    }
    let resp = check_response(resp).await?;
    if let Some(len) = resp.content_length() {
        if len > MAX_DIFF_RESPONSE_SIZE {
            return Err(KiraError::PrDiffTooLarge);
        }
    }
    let text = resp.text().await.map_err(|_| KiraError::NetworkError)?;
    if text.len() as u64 > MAX_DIFF_RESPONSE_SIZE {
        return Err(KiraError::PrDiffTooLarge);
    }
    Ok(text)
}

// --- Review state aggregation ---

#[derive(Deserialize)]
struct GhReview {
    user: Option<GhUser>,
    state: String,
}

fn aggregate_reviews(reviews: &[GhReview]) -> Option<String> {
    let mut latest_by_user: HashMap<String, &str> = HashMap::new();
    for r in reviews {
        let login = r.user.as_ref().map_or("_", |u| u.login.as_str());
        if r.state == "COMMENTED" || r.state == "PENDING" {
            continue;
        }
        if r.state == "DISMISSED" {
            latest_by_user.remove(login);
            continue;
        }
        latest_by_user.insert(login.to_string(), &r.state);
    }
    if latest_by_user.is_empty() {
        return None;
    }
    if latest_by_user.values().any(|s| *s == "CHANGES_REQUESTED") {
        return Some("changes_requested".to_string());
    }
    if latest_by_user.values().any(|s| *s == "APPROVED") {
        return Some("approved".to_string());
    }
    None
}

pub async fn fetch_pr_reviews(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    pr_number: u32,
    token: &str,
) -> Result<Option<String>> {
    let url = format!("{API_BASE}/repos/{owner}/{repo}/pulls/{pr_number}/reviews");
    let resp = client
        .get(&url)
        .query(&[("per_page", "100")])
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header("User-Agent", USER_AGENT)
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await?;
    let resp = check_response(resp).await?;
    let resp = check_body_size(resp).await?;
    let reviews: Vec<GhReview> =
        serde_json::from_str(&resp).map_err(|_| KiraError::NetworkError)?;
    Ok(aggregate_reviews(&reviews))
}

// --- Check runs aggregation ---

#[derive(Deserialize)]
struct GhCheckRunsResponse {
    check_runs: Vec<GhCheckRun>,
}

#[derive(Deserialize)]
struct GhCheckRun {
    status: String,
    conclusion: Option<String>,
}

fn aggregate_check_runs(runs: &[GhCheckRun]) -> Option<String> {
    if runs.is_empty() {
        return None;
    }
    if runs.iter().any(|r| {
        matches!(
            r.conclusion.as_deref(),
            Some("failure")
                | Some("timed_out")
                | Some("cancelled")
                | Some("startup_failure")
                | Some("action_required")
        )
    }) {
        return Some("failure".to_string());
    }
    if runs
        .iter()
        .any(|r| r.status == "queued" || r.status == "in_progress")
    {
        return Some("pending".to_string());
    }
    if runs.iter().all(|r| {
        r.conclusion.as_deref() == Some("success") || r.conclusion.as_deref() == Some("skipped")
    }) {
        return Some("success".to_string());
    }
    Some("pending".to_string())
}

async fn check_body_size(resp: reqwest::Response) -> Result<String> {
    if let Some(len) = resp.content_length() {
        if len > MAX_API_RESPONSE_SIZE {
            return Err(KiraError::NetworkError);
        }
    }
    let text = resp.text().await.map_err(|_| KiraError::NetworkError)?;
    if text.len() as u64 > MAX_API_RESPONSE_SIZE {
        return Err(KiraError::NetworkError);
    }
    Ok(text)
}

fn validate_sha(sha: &str) -> Result<()> {
    if sha.is_empty() || sha.len() > 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(KiraError::InvalidPath);
    }
    Ok(())
}

pub async fn fetch_check_runs(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    sha: &str,
    token: &str,
) -> Result<Option<String>> {
    validate_sha(sha)?;
    let url = format!("{API_BASE}/repos/{owner}/{repo}/commits/{sha}/check-runs");
    let resp = client
        .get(&url)
        .query(&[("per_page", "100")])
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header("User-Agent", USER_AGENT)
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await?;
    let resp = check_response(resp).await?;
    let text = check_body_size(resp).await?;
    let body: GhCheckRunsResponse =
        serde_json::from_str(&text).map_err(|_| KiraError::NetworkError)?;
    Ok(aggregate_check_runs(&body.check_runs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_owner_repo_canonical_https() {
        let (o, r) = parse_github_owner_repo("https://github.com/tznthou/kira.git").unwrap();
        assert_eq!(o, "tznthou");
        assert_eq!(r, "kira");
    }

    #[test]
    fn test_parse_owner_repo_no_git_suffix() {
        let (o, r) = parse_github_owner_repo("https://github.com/foo/bar").unwrap();
        assert_eq!(o, "foo");
        assert_eq!(r, "bar");
    }

    #[test]
    fn test_parse_owner_repo_trailing_slash() {
        let (o, r) = parse_github_owner_repo("https://github.com/foo/bar/").unwrap();
        assert_eq!(o, "foo");
        assert_eq!(r, "bar");
    }

    #[test]
    fn test_parse_rejects_ssh() {
        assert!(parse_github_owner_repo("git@github.com:foo/bar.git").is_err());
    }

    #[test]
    fn test_parse_rejects_non_github_host() {
        assert!(parse_github_owner_repo("https://gitlab.com/foo/bar.git").is_err());
    }

    #[test]
    fn test_parse_rejects_api_github() {
        assert!(parse_github_owner_repo("https://api.github.com/repos/foo/bar").is_err());
    }

    #[test]
    fn test_parse_rejects_typosquat() {
        assert!(parse_github_owner_repo("https://github.com.evil.com/foo/bar").is_err());
    }

    #[test]
    fn test_parse_rejects_userinfo_spoof() {
        assert!(parse_github_owner_repo("https://github.com@evil.com/foo/bar").is_err());
    }

    #[test]
    fn test_parse_rejects_too_few_segments() {
        assert!(parse_github_owner_repo("https://github.com/onlyone").is_err());
    }

    #[test]
    fn test_parse_rejects_too_many_segments() {
        assert!(parse_github_owner_repo("https://github.com/a/b/c").is_err());
    }

    #[test]
    fn test_parse_rejects_empty() {
        assert!(parse_github_owner_repo("").is_err());
    }

    #[test]
    fn test_validate_pr_state_accepts_valid() {
        assert_eq!(validate_pr_state("open").unwrap(), "open");
        assert_eq!(validate_pr_state("closed").unwrap(), "closed");
        assert_eq!(validate_pr_state("all").unwrap(), "all");
    }

    #[test]
    fn test_validate_pr_state_rejects_invalid() {
        assert!(validate_pr_state("merged").is_err());
        assert!(validate_pr_state("open&per_page=100").is_err());
        assert!(validate_pr_state("").is_err());
    }

    fn make_review(login: &str, state: &str) -> GhReview {
        GhReview {
            user: Some(GhUser {
                login: login.to_string(),
            }),
            state: state.to_string(),
        }
    }

    #[test]
    fn test_review_aggregation_empty_returns_none() {
        assert_eq!(aggregate_reviews(&[]), None);
    }

    #[test]
    fn test_review_aggregation_only_commented_returns_none() {
        let reviews = vec![make_review("a", "COMMENTED")];
        assert_eq!(aggregate_reviews(&reviews), None);
    }

    #[test]
    fn test_review_aggregation_approved() {
        let reviews = vec![make_review("a", "APPROVED")];
        assert_eq!(aggregate_reviews(&reviews), Some("approved".to_string()));
    }

    #[test]
    fn test_review_aggregation_changes_requested_takes_priority() {
        let reviews = vec![
            make_review("a", "APPROVED"),
            make_review("b", "CHANGES_REQUESTED"),
        ];
        assert_eq!(
            aggregate_reviews(&reviews),
            Some("changes_requested".to_string())
        );
    }

    #[test]
    fn test_review_aggregation_latest_per_reviewer() {
        let reviews = vec![
            make_review("a", "CHANGES_REQUESTED"),
            make_review("a", "APPROVED"),
        ];
        assert_eq!(aggregate_reviews(&reviews), Some("approved".to_string()));
    }

    #[test]
    fn test_review_aggregation_dismissed_skipped() {
        let reviews = vec![make_review("a", "DISMISSED")];
        assert_eq!(aggregate_reviews(&reviews), None);
    }

    #[test]
    fn test_review_aggregation_dismissed_clears_previous() {
        let reviews = vec![
            make_review("a", "CHANGES_REQUESTED"),
            make_review("a", "DISMISSED"),
        ];
        assert_eq!(aggregate_reviews(&reviews), None);
    }

    #[test]
    fn test_check_runs_startup_failure_is_failure() {
        let runs = vec![make_check("completed", Some("startup_failure"))];
        assert_eq!(aggregate_check_runs(&runs), Some("failure".to_string()));
    }

    #[test]
    fn test_check_runs_action_required_is_failure() {
        let runs = vec![make_check("completed", Some("action_required"))];
        assert_eq!(aggregate_check_runs(&runs), Some("failure".to_string()));
    }

    fn make_check(status: &str, conclusion: Option<&str>) -> GhCheckRun {
        GhCheckRun {
            status: status.to_string(),
            conclusion: conclusion.map(|s| s.to_string()),
        }
    }

    #[test]
    fn test_check_runs_empty_returns_none() {
        assert_eq!(aggregate_check_runs(&[]), None);
    }

    #[test]
    fn test_check_runs_all_success() {
        let runs = vec![make_check("completed", Some("success"))];
        assert_eq!(aggregate_check_runs(&runs), Some("success".to_string()));
    }

    #[test]
    fn test_check_runs_any_failure() {
        let runs = vec![
            make_check("completed", Some("success")),
            make_check("completed", Some("failure")),
        ];
        assert_eq!(aggregate_check_runs(&runs), Some("failure".to_string()));
    }

    #[test]
    fn test_check_runs_pending() {
        let runs = vec![
            make_check("completed", Some("success")),
            make_check("in_progress", None),
        ];
        assert_eq!(aggregate_check_runs(&runs), Some("pending".to_string()));
    }

    #[test]
    fn test_check_runs_queued() {
        let runs = vec![make_check("queued", None)];
        assert_eq!(aggregate_check_runs(&runs), Some("pending".to_string()));
    }

    #[test]
    fn test_check_runs_timed_out_is_failure() {
        let runs = vec![make_check("completed", Some("timed_out"))];
        assert_eq!(aggregate_check_runs(&runs), Some("failure".to_string()));
    }

    #[test]
    fn test_check_runs_skipped_counts_as_success() {
        let runs = vec![
            make_check("completed", Some("success")),
            make_check("completed", Some("skipped")),
        ];
        assert_eq!(aggregate_check_runs(&runs), Some("success".to_string()));
    }

    // --- PR diff 的上限（Phase 5c）：GitHub 拒給的、超過 1 MB 的都是「太大」，再試也拿不到 ---

    const PULL: &str = "/repos/o/r/pulls/7";

    async fn diff_from(server: &mockito::ServerGuard) -> Result<String> {
        fetch_pr_diff_at(&reqwest::Client::new(), &server.url(), "o", "r", 7, "t").await
    }

    /// 超過 300 個檔：GitHub 回 406 too_large（原文照 2026-10-12 對 kubernetes #141664 的實測）
    #[tokio::test]
    async fn test_pr_diff_over_githubs_file_limit_is_too_large() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", PULL)
            .match_header("accept", "application/vnd.github.diff")
            .with_status(406)
            .with_header("content-type", "application/json")
            .with_body(r#"{"message":"Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead.","errors":[{"resource":"PullRequest","field":"diff","code":"too_large"}],"documentation_url":"https://docs.github.com/rest/pulls/pulls#list-pull-requests-files","status":"406"}"#)
            .create_async()
            .await;
        assert_eq!(
            diff_from(&server).await.unwrap_err().code(),
            "PR_DIFF_TOO_LARGE"
        );
    }

    /// 超過它自己算的 20,000 行：同一個碼（#138573 的原文）
    #[tokio::test]
    async fn test_pr_diff_over_githubs_line_limit_is_too_large() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", PULL)
            .with_status(406)
            .with_header("content-type", "application/json")
            .with_body(r#"{"message":"Sorry, the diff exceeded the maximum number of lines (20000)","errors":[{"resource":"PullRequest","field":"diff","code":"too_large"}],"documentation_url":"https://docs.github.com/rest/pulls/pulls#get-a-pull-request","status":"406"}"#)
            .create_async()
            .await;
        assert_eq!(
            diff_from(&server).await.unwrap_err().code(),
            "PR_DIFF_TOO_LARGE"
        );
    }

    /// 406 但不是 too_large：照舊是網路錯誤（可以重試）
    #[tokio::test]
    async fn test_pr_diff_other_406_stays_a_network_error() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", PULL)
            .with_status(406)
            .with_header("content-type", "application/json")
            .with_body(r#"{"message":"Unsupported 'Accept' header"}"#)
            .create_async()
            .await;
        assert_eq!(
            diff_from(&server).await.unwrap_err().code(),
            "NETWORK_ERROR"
        );
    }

    /// GitHub 照給、但超過 Kira 的 1 MB（#139380 的回應 1.33 MB）：同一個碼
    #[tokio::test]
    async fn test_pr_diff_over_one_megabyte_is_too_large() {
        let mut server = mockito::Server::new_async().await;
        let body = format!(
            "diff --git a/x b/x\n{}",
            "+".repeat(MAX_DIFF_RESPONSE_SIZE as usize)
        );
        let _m = server
            .mock("GET", PULL)
            .with_status(200)
            .with_body(body)
            .create_async()
            .await;
        assert_eq!(
            diff_from(&server).await.unwrap_err().code(),
            "PR_DIFF_TOO_LARGE"
        );
    }

    /// 沒有 Content-Length（chunked）：收完量到也一樣
    #[tokio::test]
    async fn test_pr_diff_over_one_megabyte_without_a_length_is_too_large() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", PULL)
            .with_status(200)
            .with_chunked_body(|w| w.write_all(&vec![b'+'; MAX_DIFF_RESPONSE_SIZE as usize + 1]))
            .create_async()
            .await;
        assert_eq!(
            diff_from(&server).await.unwrap_err().code(),
            "PR_DIFF_TOO_LARGE"
        );
    }

    /// 上限內：原文照回
    #[tokio::test]
    async fn test_pr_diff_within_the_limits_is_the_text() {
        let mut server = mockito::Server::new_async().await;
        let text = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
        let _m = server
            .mock("GET", PULL)
            .with_status(200)
            .with_body(text)
            .create_async()
            .await;
        assert_eq!(diff_from(&server).await.unwrap(), text);
    }
}
