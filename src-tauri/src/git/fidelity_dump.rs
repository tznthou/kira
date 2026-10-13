//! v8 複刻比對：在實機 fixture repo 上傾印真後端的 IPC 輸出，讓前端核對手寫 fixture
//! （`src/dev/fidelity/fixture.ts`）的語意——排序、格式、旗標是否與真後端一致。
//! 手寫 fixture 若與真後端不同，截圖比對會過，真實 app 卻長得不一樣。
//!
//! 一般 `cargo test` 不會跑（#[ignore]），需明確指定：
//!   KIRA_FIXTURE_REPO=<repo> KIRA_FIXTURE_DUMP=<out.json> \
//!     cargo test --lib fidelity_dump -- --ignored --nocapture

use git2::Repository;
use serde_json::{json, Map, Value};

#[test]
#[ignore = "needs KIRA_FIXTURE_REPO and KIRA_FIXTURE_DUMP; run explicitly"]
fn dump_fixture_ipc() {
    let repo_path = std::env::var("KIRA_FIXTURE_REPO").expect("set KIRA_FIXTURE_REPO");
    let out_path = std::env::var("KIRA_FIXTURE_DUMP").expect("set KIRA_FIXTURE_DUMP");
    let repo = Repository::open(&repo_path).expect("open fixture repo");

    let graph = super::graph::build_graph(&repo, None).expect("build_graph");
    let branches = super::branch::list_branches(&repo).expect("list_branches");
    let local: Vec<String> = branches
        .branches
        .iter()
        .filter(|b| !b.is_remote)
        .map(|b| b.name.clone())
        .collect();
    let stats = super::branch::get_branch_stats(&repo, &local).expect("get_branch_stats");
    let status = super::diff::get_status(&repo).expect("get_status");
    let ahead_behind = super::remote::ahead_behind(&repo).expect("ahead_behind");

    // 最新幾筆 commit 的 diff：核對 DiffLine / hunk 的格式
    let mut diffs = Map::new();
    for commit in graph.commits.iter().take(4) {
        let diff = super::diff::get_diff(&repo, &commit.full_oid).expect("get_diff");
        diffs.insert(
            commit.full_oid.clone(),
            serde_json::to_value(diff).expect("serialize diff"),
        );
    }

    let doc = json!({
        "graph": graph,
        "branches": branches,
        "branch_stats": stats,
        "status": status,
        "ahead_behind": ahead_behind,
        "diffs": Value::Object(diffs),
    });
    std::fs::write(
        &out_path,
        serde_json::to_string_pretty(&doc).expect("serialize dump"),
    )
    .expect("write dump");
    println!("fidelity dump written to {out_path}");
}
