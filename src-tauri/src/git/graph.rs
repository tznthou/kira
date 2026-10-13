use crate::error::Result;
use git2::{BranchType, Direction, ErrorCode, Oid, ReferenceType, Remote, Repository, Sort};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

const DEFAULT_LIMIT: u32 = 1000;
const MAX_LIMIT: u32 = 10_000;
const SHORT_OID_LEN: usize = 7;

#[derive(Debug, Serialize)]
pub struct Author {
    pub name: String,
    pub email: String,
    pub timestamp: i64,
}

#[derive(Debug, Serialize)]
pub struct CommitNode {
    pub oid: String,
    pub full_oid: String,
    pub message: String,
    pub author: Author,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct BranchRef {
    pub name: String,
    pub target: String,
    pub is_remote: bool,
    /// local 分支設定的 upstream，只回報 remote-tracking 分支（例 "origin/feat/x"）。
    /// upstream 是本機分支時為 None——前端用它把 local 與 remote 併成同一條路線，本機的不該參與。
    pub upstream: Option<String>,
    /// remote-tracking 分支在遠端上的名字（例 "feat/x"）。tracking ref 的前綴不一定是
    /// remote 名，所以依 fetch refspec 反推；找不到 remote 或有歧義時為 None。local 分支為 None。
    pub name_on_remote: Option<String>,
}

/// 與 commits 同一次快照的 HEAD。detached：branch=None、oid=Some；unborn（HEAD 指向還沒有 commit
/// 的分支）：branch=Some、oid=None；HEAD 讀不到（損壞）：兩者皆 None。
#[derive(Debug, Serialize)]
pub struct HeadInfo {
    pub oid: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TagRef {
    pub name: String,
    pub target: String,
}

#[derive(Debug, Serialize)]
pub struct GraphData {
    pub commits: Vec<CommitNode>,
    pub branches: Vec<BranchRef>,
    pub tags: Vec<TagRef>,
    /// revwalk 在 limit 處被截斷，歷史還有更多 commit 未回傳。
    /// UI 必須顯示提示 — 否則使用者會把這批當成完整歷史（見 DiffResult.truncated）。
    pub truncated: bool,
    pub head: HeadInfo,
    /// <remote>/HEAD 指向、而且還存在的分支在遠端上的名字；origin 優先。
    pub default_branch: Option<String>,
}

pub fn build_graph(repo: &Repository, limit: Option<u32>) -> Result<GraphData> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;

    // HEAD 只讀一次：回報的 head 與 revwalk 的起點必須是同一個快照
    let head = head_info(repo);
    let remotes = RemoteRefspecs::load(repo);
    let branches = collect_branches(repo, &remotes)?;
    let tags = collect_tags(repo)?;
    let ref_map = build_ref_map(&branches, &tags);
    let default_branch = default_branch(repo, &remotes);

    let head_oid = head.oid.as_deref().and_then(|oid| Oid::from_str(oid).ok());
    let (commits, truncated) = walk_commits(repo, head_oid, &branches, &tags, &ref_map, limit)?;

    Ok(GraphData {
        commits,
        branches,
        tags,
        truncated,
        head,
        default_branch,
    })
}

/// unborn 時仍回報 HEAD 指向的分支：路線圖要拿它當這個 repo 的線（第一筆 commit 之前站牌就寫
/// 「You are on main」，主幹判定也不必等第一筆 commit）。RepoInfo.head_branch 不跟著改——它是推送
/// 的對象，unborn 分支沒有東西可推。
fn head_info(repo: &Repository) -> HeadInfo {
    match repo.head() {
        Ok(head) => HeadInfo {
            oid: head.target().map(|oid| oid.to_string()),
            branch: head
                .is_branch()
                .then(|| head.shorthand().map(String::from))
                .flatten(),
        },
        Err(e) if e.code() == ErrorCode::UnbornBranch => HeadInfo {
            oid: None,
            branch: unborn_branch(repo),
        },
        Err(_) => HeadInfo {
            oid: None,
            branch: None,
        },
    }
}

/// unborn 的 HEAD 仍是指向 `refs/heads/<名>` 的符號參照，只是那個分支還沒有 commit。
/// 指向其他命名空間的不算分支。
fn unborn_branch(repo: &Repository) -> Option<String> {
    let head = repo.find_reference("HEAD").ok()?;
    head.symbolic_target()?
        .strip_prefix("refs/heads/")
        .map(String::from)
}

/// 預先載入所有 remote，讓每條 remote-tracking 分支都能依 fetch refspec 算出「在遠端上叫什麼」。
/// tracking ref 的前綴不一定是 remote 名（自訂 refspec 下 remote 叫 origin、ref 卻在
/// refs/remotes/upstream/），remote 名也可能含 `/`，所以不能切字串猜。
struct RemoteRefspecs<'r> {
    remotes: Vec<Remote<'r>>,
}

impl<'r> RemoteRefspecs<'r> {
    fn load(repo: &'r Repository) -> Self {
        let remotes = match repo.remotes() {
            Ok(names) => names
                .iter()
                .flatten()
                .filter_map(|name| repo.find_remote(name).ok())
                .collect(),
            Err(_) => Vec::new(),
        };
        Self { remotes }
    }

    /// "refs/remotes/upstream/feat/x" → Some("feat/x")。剛好一個 remote 的 fetch refspec 認得
    /// 這個 ref 才算得出來；沒有（殘留 ref）或兩個以上（歧義）回 None，與 libgit2
    /// `branch_remote_name` 的 NotFound / Ambiguous 一致。
    fn name_on_remote(&self, refname: &str) -> Option<String> {
        let mut matches = self.remotes.iter().filter_map(|remote| {
            remote
                .refspecs()
                .find(|spec| spec.direction() == Direction::Fetch && spec.dst_matches(refname))
                .map(|spec| spec.rtransform(refname))
        });
        let first = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        let source = first.ok()?;
        let source = source.as_str()?;
        Some(
            source
                .strip_prefix("refs/heads/")
                .unwrap_or(source)
                .to_string(),
        )
    }
}

/// <remote>/HEAD 指向、而且還存在的分支在遠端上的名字；origin 優先，其次依 libgit2 列出的
/// remote 順序。origin/HEAD 可能指向已不存在的分支（遠端預設分支改名、舊分支被 prune）——
/// 視同沒有，前端的主幹偵測才會往下一順位走。
fn default_branch(repo: &Repository, remotes: &RemoteRefspecs) -> Option<String> {
    let names: Vec<&str> = remotes.remotes.iter().filter_map(|r| r.name()).collect();
    let ordered = names
        .iter()
        .filter(|name| **name == "origin")
        .chain(names.iter().filter(|name| **name != "origin"));
    for name in ordered {
        let Ok(head) = repo.find_reference(&format!("refs/remotes/{name}/HEAD")) else {
            continue;
        };
        if head.kind() != Some(ReferenceType::Symbolic) {
            continue;
        }
        let Ok(target) = head.resolve() else {
            continue;
        };
        if let Some(branch) = target.name().and_then(|n| remotes.name_on_remote(n)) {
            return Some(branch);
        }
    }
    None
}

/// local 分支的 upstream，只回報 remote-tracking 分支（"origin/feat/x"）；本機 upstream 回 None。
/// tracking ref 已被 prune 時名字照給——前端合併時找不到那個 tip，無害。
fn remote_upstream(repo: &Repository, refname: &str) -> Option<String> {
    let upstream = repo.branch_upstream_name(refname).ok()?;
    upstream
        .as_str()?
        .strip_prefix("refs/remotes/")
        .map(String::from)
}

fn collect_branches(repo: &Repository, remotes: &RemoteRefspecs) -> Result<Vec<BranchRef>> {
    let mut out = Vec::new();
    for entry in repo.branches(None)? {
        let (branch, btype) = entry?;
        let Some(name) = branch.name()?.map(String::from) else {
            continue;
        };
        let Some(target) = branch.get().target() else {
            continue;
        };
        let is_remote = matches!(btype, BranchType::Remote);
        let (upstream, name_on_remote) = match (is_remote, branch.get().name()) {
            (true, Some(refname)) => (None, remotes.name_on_remote(refname)),
            (false, Some(refname)) => (remote_upstream(repo, refname), None),
            (_, None) => (None, None),
        };
        out.push(BranchRef {
            name,
            target: target.to_string(),
            is_remote,
            upstream,
            name_on_remote,
        });
    }
    Ok(out)
}

fn collect_tags(repo: &Repository) -> Result<Vec<TagRef>> {
    let mut out = Vec::new();
    for reference in repo.references()? {
        let reference = reference?;
        if !reference.is_tag() {
            continue;
        }
        let Some(name) = reference.shorthand().map(String::from) else {
            continue;
        };
        let Ok(commit) = reference.peel_to_commit() else {
            continue;
        };
        out.push(TagRef {
            name,
            target: commit.id().to_string(),
        });
    }
    Ok(out)
}

fn build_ref_map(branches: &[BranchRef], tags: &[TagRef]) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for b in branches {
        map.entry(b.target.clone())
            .or_default()
            .push(b.name.clone());
    }
    for t in tags {
        map.entry(t.target.clone())
            .or_default()
            .push(t.name.clone());
    }
    map
}

fn walk_commits(
    repo: &Repository,
    head_oid: Option<Oid>,
    branches: &[BranchRef],
    tags: &[TagRef],
    ref_map: &HashMap<String, Vec<String>>,
    limit: usize,
) -> Result<(Vec<CommitNode>, bool)> {
    let mut seeds: HashSet<Oid> = HashSet::new();
    seeds.extend(head_oid);
    for b in branches {
        if let Ok(oid) = Oid::from_str(&b.target) {
            seeds.insert(oid);
        }
    }
    for t in tags {
        if let Ok(oid) = Oid::from_str(&t.target) {
            seeds.insert(oid);
        }
    }

    if seeds.is_empty() {
        return Ok((Vec::new(), false));
    }

    let mut walker = repo.revwalk()?;
    walker.set_sorting(Sort::TIME | Sort::TOPOLOGICAL)?;
    for oid in &seeds {
        walker.push(*oid)?;
    }

    let mut commits = Vec::with_capacity(limit);
    for oid_res in walker.by_ref().take(limit) {
        let oid = oid_res?;
        let commit = repo.find_commit(oid)?;
        let full = oid.to_string();
        let short = full[..SHORT_OID_LEN].to_string();
        let message = commit
            .message()
            .unwrap_or("")
            .lines()
            .next()
            .unwrap_or("")
            .to_string();
        let signature = commit.author();
        let author = Author {
            name: signature.name().unwrap_or("").to_string(),
            email: signature.email().unwrap_or("").to_string(),
            timestamp: signature.when().seconds(),
        };
        let parents = commit.parents().map(|p| p.id().to_string()).collect();
        let refs = ref_map.get(&full).cloned().unwrap_or_default();
        commits.push(CommitNode {
            oid: short,
            full_oid: full,
            message,
            author,
            parents,
            refs,
        });
    }

    // 取滿 limit 後再偷看一筆判斷是否還有歷史。用「多走一步」而非
    // commits.len() == limit — 後者在歷史長度剛好等於 limit 時會誤報截斷。
    let truncated = walker.next().is_some();

    Ok((commits, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use tempfile::TempDir;

    fn init_repo() -> (TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        (dir, repo)
    }

    fn commit(repo: &Repository, message: &str) -> Oid {
        let sig = Signature::now("test", "test@example.com").unwrap();
        let mut index = repo.index().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let parents: Vec<git2::Commit> = repo
            .head()
            .ok()
            .and_then(|h| h.target())
            .and_then(|oid| repo.find_commit(oid).ok())
            .into_iter()
            .collect();
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)
            .unwrap()
    }

    #[test]
    fn test_build_graph_empty_repo_returns_empty() {
        let (_dir, repo) = init_repo();
        let graph = build_graph(&repo, None).unwrap();
        assert!(graph.commits.is_empty());
        assert!(graph.branches.is_empty());
        assert!(graph.tags.is_empty());
    }

    #[test]
    fn test_build_graph_three_commits_returns_newest_first() {
        let (_dir, repo) = init_repo();
        commit(&repo, "first");
        commit(&repo, "second");
        let head_oid = commit(&repo, "third");

        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(graph.commits.len(), 3);
        assert_eq!(graph.commits[0].full_oid, head_oid.to_string());
        assert_eq!(graph.commits[0].message, "third");
        assert_eq!(graph.commits[0].oid.len(), SHORT_OID_LEN);
        assert_eq!(graph.commits[2].message, "first");
        assert!(graph.commits[2].parents.is_empty());
        assert_eq!(graph.commits[1].parents.len(), 1);
    }

    #[test]
    fn test_build_graph_limit_truncates() {
        let (_dir, repo) = init_repo();
        for i in 0..5 {
            commit(&repo, &format!("c{i}"));
        }
        let graph = build_graph(&repo, Some(2)).unwrap();
        assert_eq!(graph.commits.len(), 2);
        assert!(graph.truncated);
    }

    // 側欄的「視窗外」圓標靠這條：分支清單不看視窗，tip 早於載入的 commit 時 ref 照樣在 branches、
    // target 不在 commits（v8-fixture 只有 184 筆，正式 1000 筆上限在實機 fixture 上驗不到，所以在這裡守）
    #[test]
    fn test_build_graph_branch_beyond_the_window_is_listed_without_its_commit() {
        let (_dir, repo) = init_repo();
        let old = commit(&repo, "c0");
        repo.branch("old", &repo.find_commit(old).unwrap(), false)
            .unwrap();
        for i in 1..5 {
            commit(&repo, &format!("c{i}"));
        }
        let graph = build_graph(&repo, Some(2)).unwrap();
        let b = graph
            .branches
            .iter()
            .find(|b| b.name == "old")
            .expect("a branch beyond the window is still listed");
        assert_eq!(b.target, old.to_string());
        assert!(!graph.commits.iter().any(|c| c.full_oid == b.target));
        assert!(graph.truncated);
    }

    #[test]
    fn test_build_graph_exact_limit_is_not_truncated() {
        let (_dir, repo) = init_repo();
        for i in 0..3 {
            commit(&repo, &format!("c{i}"));
        }
        // 歷史長度剛好等於 limit：沒有第 4 筆，不得回報截斷。
        // 這是 len() == limit 那種寫法會誤報的邊界。
        let graph = build_graph(&repo, Some(3)).unwrap();
        assert_eq!(graph.commits.len(), 3);
        assert!(!graph.truncated);
    }

    #[test]
    fn test_build_graph_under_limit_is_not_truncated() {
        let (_dir, repo) = init_repo();
        commit(&repo, "only");
        let graph = build_graph(&repo, Some(10)).unwrap();
        assert!(!graph.truncated);
    }

    #[test]
    fn test_build_graph_limit_u32_max_does_not_panic() {
        let (_dir, repo) = init_repo();
        commit(&repo, "first");
        let graph = build_graph(&repo, Some(u32::MAX)).unwrap();
        assert_eq!(graph.commits.len(), 1);
    }

    #[test]
    fn test_build_graph_branch_appears_on_commit() {
        let (_dir, repo) = init_repo();
        commit(&repo, "first");
        let head_oid = commit(&repo, "second");
        let head_commit = repo.find_commit(head_oid).unwrap();
        repo.branch("feature/x", &head_commit, false).unwrap();

        let graph = build_graph(&repo, None).unwrap();
        let head_node = &graph.commits[0];
        assert_eq!(head_node.full_oid, head_oid.to_string());
        assert!(
            head_node.refs.iter().any(|r| r == "feature/x"),
            "expected feature/x ref on head, got {:?}",
            head_node.refs
        );
        assert!(graph.branches.iter().any(|b| b.name == "feature/x"));
    }

    #[test]
    fn test_build_graph_lightweight_tag_appears_on_commit() {
        let (_dir, repo) = init_repo();
        let oid = commit(&repo, "first");
        let target = repo.find_commit(oid).unwrap();
        repo.tag_lightweight("v1.0", target.as_object(), false)
            .unwrap();

        let graph = build_graph(&repo, None).unwrap();
        let node = &graph.commits[0];
        assert!(
            node.refs.iter().any(|r| r == "v1.0"),
            "expected v1.0 ref, got {:?}",
            node.refs
        );
        let tag_ref = graph.tags.iter().find(|t| t.name == "v1.0").unwrap();
        assert_eq!(tag_ref.target, oid.to_string());
    }

    #[test]
    fn test_build_graph_annotated_tag_resolves_to_commit_oid() {
        let (_dir, repo) = init_repo();
        let oid = commit(&repo, "first");
        let target = repo.find_commit(oid).unwrap();
        let sig = Signature::now("test", "test@example.com").unwrap();
        repo.tag("v2.0", target.as_object(), &sig, "release v2.0", false)
            .unwrap();

        let graph = build_graph(&repo, None).unwrap();
        let tag_ref = graph.tags.iter().find(|t| t.name == "v2.0").unwrap();
        assert_eq!(
            tag_ref.target,
            oid.to_string(),
            "annotated tag must peel to commit oid, not tag object oid"
        );
        let node = graph
            .commits
            .iter()
            .find(|c| c.full_oid == oid.to_string())
            .expect("commit must appear in graph");
        assert!(
            node.refs.iter().any(|r| r == "v2.0"),
            "expected v2.0 ref on commit, got {:?}",
            node.refs
        );
    }

    #[test]
    fn test_build_graph_tag_only_reachable_commit_is_included() {
        let (_dir, repo) = init_repo();
        commit(&repo, "first");
        let second = commit(&repo, "second");
        commit(&repo, "third");

        let target = repo.find_commit(second).unwrap();
        repo.tag_lightweight("milestone", target.as_object(), false)
            .unwrap();

        let head = repo.head().unwrap();
        let head_commit = repo.find_commit(head.target().unwrap()).unwrap();
        let grand_parent = head_commit.parent(0).unwrap().parent(0).unwrap();
        repo.reset(grand_parent.as_object(), git2::ResetType::Hard, None)
            .unwrap();

        let graph = build_graph(&repo, None).unwrap();
        assert!(
            graph
                .commits
                .iter()
                .any(|c| c.full_oid == second.to_string()),
            "commit reachable only via tag must be included"
        );
    }

    /// 第一個 commit 前把 HEAD 指到 refs/heads/main，不依賴 libgit2 / 全域設定的預設分支名。
    fn init_main() -> (TempDir, Repository) {
        let (dir, repo) = init_repo();
        repo.set_head("refs/heads/main").unwrap();
        (dir, repo)
    }

    /// 模擬已 fetch 過的 remote：只建設定（可自訂 fetch refspec），不碰網路。
    fn add_remote(repo: &Repository, name: &str, fetch: Option<&str>) {
        let url = "https://example.invalid/repo.git";
        match fetch {
            Some(spec) => repo.remote_with_fetch(name, url, spec).unwrap(),
            None => repo.remote(name, url).unwrap(),
        };
    }

    fn set_ref(repo: &Repository, refname: &str, oid: Oid) {
        repo.reference(refname, oid, true, "test").unwrap();
    }

    fn branch_ref<'a>(graph: &'a GraphData, name: &str) -> &'a BranchRef {
        graph
            .branches
            .iter()
            .find(|b| b.name == name)
            .unwrap_or_else(|| panic!("no branch {name} in {:?}", graph.branches))
    }

    #[test]
    fn test_build_graph_head_on_branch() {
        let (_dir, repo) = init_main();
        let tip = commit(&repo, "first");
        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(graph.head.branch.as_deref(), Some("main"));
        assert_eq!(graph.head.oid, Some(tip.to_string()));
    }

    #[test]
    fn test_build_graph_head_detached_has_oid_without_branch() {
        let (_dir, repo) = init_main();
        let first = commit(&repo, "first");
        commit(&repo, "second");
        repo.set_head_detached(first).unwrap();
        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(graph.head.branch, None);
        assert_eq!(graph.head.oid, Some(first.to_string()));
    }

    #[test]
    fn test_build_graph_head_unborn_has_branch_without_oid() {
        let (_dir, repo) = init_main();
        let graph = build_graph(&repo, None).unwrap();
        assert!(graph.commits.is_empty());
        assert_eq!(graph.head.branch.as_deref(), Some("main"));
        assert_eq!(graph.head.oid, None);
    }

    #[test]
    fn test_build_graph_head_orphan_has_branch_and_lists_other_history() {
        let (_dir, repo) = init_main();
        commit(&repo, "first");
        // git switch --orphan：HEAD 指向還沒有 commit 的分支，main 的歷史照列
        repo.set_head("refs/heads/orphan").unwrap();
        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(graph.head.branch.as_deref(), Some("orphan"));
        assert_eq!(graph.head.oid, None);
        assert_eq!(graph.commits.len(), 1);
        assert_eq!(graph.commits[0].message, "first");
    }

    #[test]
    fn test_build_graph_head_outside_refs_heads_has_no_branch() {
        let (_dir, repo) = init_repo();
        // 符號參照指向不存在的 tag：libgit2 一樣回 unborn，但那不是分支（set_head 不收這種參照，直接寫檔）
        std::fs::write(repo.path().join("HEAD"), "ref: refs/tags/nowhere\n").unwrap();
        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(graph.head.branch, None);
        assert_eq!(graph.head.oid, None);
    }

    #[test]
    fn test_build_graph_head_unreadable_has_neither() {
        let (_dir, repo) = init_main();
        commit(&repo, "first");
        // HEAD 本身完好、指向 main，但 main 的 ref 壞了：讀不到 ≠ unborn，不能回報成「main 還沒有 commit」
        std::fs::write(repo.path().join("refs/heads/main"), "garbage\n").unwrap();
        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(graph.head.branch, None);
        assert_eq!(graph.head.oid, None);
    }

    #[test]
    fn test_build_graph_name_on_remote_follows_fetch_refspec() {
        let (_dir, repo) = init_main();
        let oid = commit(&repo, "first");
        add_remote(&repo, "origin", None);
        // remote 名含 `/`
        add_remote(&repo, "team/origin", None);
        // 自訂 refspec：remote 叫 corp，tracking ref 卻在 refs/remotes/upstream/*
        add_remote(&repo, "corp", Some("+refs/heads/*:refs/remotes/upstream/*"));
        set_ref(&repo, "refs/remotes/origin/feat/x", oid);
        set_ref(&repo, "refs/remotes/team/origin/main", oid);
        set_ref(&repo, "refs/remotes/upstream/main", oid);

        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(
            branch_ref(&graph, "origin/feat/x")
                .name_on_remote
                .as_deref(),
            Some("feat/x")
        );
        assert_eq!(
            branch_ref(&graph, "team/origin/main")
                .name_on_remote
                .as_deref(),
            Some("main")
        );
        assert_eq!(
            branch_ref(&graph, "upstream/main")
                .name_on_remote
                .as_deref(),
            Some("main"),
            "prefix `upstream/` is not the remote name `corp` — must go through the refspec"
        );
        assert_eq!(branch_ref(&graph, "main").name_on_remote, None);
    }

    #[test]
    fn test_build_graph_name_on_remote_none_when_unknown_or_ambiguous() {
        let (_dir, repo) = init_main();
        let oid = commit(&repo, "first");
        add_remote(&repo, "solo", None);
        add_remote(&repo, "origin", None);
        // 兩個 remote 都把 fetch 寫進 refs/remotes/origin/*
        add_remote(&repo, "dup", Some("+refs/heads/*:refs/remotes/origin/*"));
        set_ref(&repo, "refs/remotes/solo/main", oid);
        set_ref(&repo, "refs/remotes/origin/main", oid);
        // 殘留：沒有任何 remote 認得
        set_ref(&repo, "refs/remotes/gone/feat", oid);

        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(
            branch_ref(&graph, "solo/main").name_on_remote.as_deref(),
            Some("main")
        );
        assert_eq!(branch_ref(&graph, "origin/main").name_on_remote, None);
        assert_eq!(branch_ref(&graph, "gone/feat").name_on_remote, None);
    }

    #[test]
    fn test_build_graph_upstream_only_reports_remote_tracking() {
        let (_dir, repo) = init_main();
        let oid = commit(&repo, "first");
        add_remote(&repo, "origin", None);
        set_ref(&repo, "refs/remotes/origin/main", oid);
        let head_commit = repo.find_commit(oid).unwrap();
        repo.branch("feat-local", &head_commit, false).unwrap();
        repo.branch("nolink", &head_commit, false).unwrap();
        repo.find_branch("main", BranchType::Local)
            .unwrap()
            .set_upstream(Some("origin/main"))
            .unwrap();
        // upstream 是本機分支（branch.feat-local.remote = "."）
        repo.find_branch("feat-local", BranchType::Local)
            .unwrap()
            .set_upstream(Some("main"))
            .unwrap();

        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(
            branch_ref(&graph, "main").upstream.as_deref(),
            Some("origin/main")
        );
        assert_eq!(branch_ref(&graph, "feat-local").upstream, None);
        assert_eq!(branch_ref(&graph, "nolink").upstream, None);
        assert_eq!(branch_ref(&graph, "origin/main").upstream, None);
    }

    #[test]
    fn test_build_graph_upstream_kept_when_tracking_ref_pruned() {
        let (_dir, repo) = init_main();
        let oid = commit(&repo, "first");
        add_remote(&repo, "origin", None);
        set_ref(&repo, "refs/remotes/origin/gone", oid);
        repo.find_branch("main", BranchType::Local)
            .unwrap()
            .set_upstream(Some("origin/gone"))
            .unwrap();
        repo.find_reference("refs/remotes/origin/gone")
            .unwrap()
            .delete()
            .unwrap();

        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(
            branch_ref(&graph, "main").upstream.as_deref(),
            Some("origin/gone")
        );
    }

    #[test]
    fn test_build_graph_default_branch_prefers_origin_head() {
        let (_dir, repo) = init_main();
        let oid = commit(&repo, "first");
        add_remote(&repo, "upstream", None);
        add_remote(&repo, "origin", None);
        set_ref(&repo, "refs/remotes/origin/main", oid);
        set_ref(&repo, "refs/remotes/upstream/develop", oid);
        repo.reference_symbolic(
            "refs/remotes/upstream/HEAD",
            "refs/remotes/upstream/develop",
            true,
            "test",
        )
        .unwrap();
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            true,
            "test",
        )
        .unwrap();

        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(graph.default_branch.as_deref(), Some("main"));
    }

    #[test]
    fn test_build_graph_default_branch_skips_dangling_origin_head() {
        let (_dir, repo) = init_main();
        let oid = commit(&repo, "first");
        add_remote(&repo, "origin", None);
        add_remote(&repo, "upstream", None);
        set_ref(&repo, "refs/remotes/upstream/develop", oid);
        // 遠端預設分支改名、舊分支被 prune 後的樣子：origin/HEAD 指向不存在的 ref
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/renamed-away",
            true,
            "test",
        )
        .unwrap();
        repo.reference_symbolic(
            "refs/remotes/upstream/HEAD",
            "refs/remotes/upstream/develop",
            true,
            "test",
        )
        .unwrap();

        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(graph.default_branch.as_deref(), Some("develop"));
    }

    #[test]
    fn test_build_graph_default_branch_none_without_resolvable_head() {
        let (_dir, repo) = init_main();
        commit(&repo, "first");
        add_remote(&repo, "origin", None);
        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(graph.default_branch, None, "no origin/HEAD at all");

        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/renamed-away",
            true,
            "test",
        )
        .unwrap();
        let graph = build_graph(&repo, None).unwrap();
        assert_eq!(graph.default_branch, None, "origin/HEAD dangles");
    }
}
