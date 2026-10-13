//! v8 Phase 2 步驟 0：git2 0.19 在邊界情境下的實際回傳（唯讀，只開 repo 不寫入）。
use git2::{BranchType, Direction, Error, Repository};
use std::path::Path;

fn err(e: &Error) -> String {
    format!("Err(code={:?}, class={:?}, \"{}\")", e.code(), e.class(), e.message())
}

fn remote_name(repo: &Repository, refname: &str) -> String {
    match repo.branch_remote_name(refname) {
        Ok(b) => format!("Ok({:?})", b.as_str().unwrap_or("<non-utf8>")),
        Err(e) => err(&e),
    }
}

fn upstream_name(repo: &Repository, refname: &str) -> String {
    match repo.branch_upstream_name(refname) {
        Ok(b) => {
            let full = b.as_str().unwrap_or("<non-utf8>").to_string();
            let exists = repo.find_reference(&full).is_ok();
            format!("Ok({full:?}) tracking_ref_exists={exists}")
        }
        Err(e) => err(&e),
    }
}

fn symbolic(repo: &Repository, refname: &str) -> String {
    match repo.find_reference(refname) {
        Ok(r) => {
            let resolved = match r.resolve() {
                Ok(t) => format!("resolves to {:?}", t.name().unwrap_or("?")),
                Err(e) => format!("resolve {}", err(&e)),
            };
            format!("Ok(kind={:?}, symbolic_target={:?}) {resolved}", r.kind(), r.symbolic_target())
        }
        Err(e) => err(&e),
    }
}

/// remote 上的分支名：找到 remote → 取 dst 符合的 fetch refspec → rtransform 回 refs/heads/<name>
fn name_on_remote(repo: &Repository, refname: &str) -> String {
    let remote = match repo.branch_remote_name(refname) {
        Ok(b) => b.as_str().unwrap_or("").to_string(),
        Err(e) => return format!("(no remote) {}", err(&e)),
    };
    let remote = match repo.find_remote(&remote) {
        Ok(r) => r,
        Err(e) => return format!("find_remote {}", err(&e)),
    };
    for spec in remote.refspecs() {
        if spec.direction() == Direction::Fetch && spec.dst_matches(refname) {
            return match spec.rtransform(refname) {
                Ok(b) => format!("Ok({:?}) via refspec {:?}", b.as_str().unwrap_or("?"), spec.str().unwrap_or("?")),
                Err(e) => format!("rtransform {}", err(&e)),
            };
        }
    }
    "no fetch refspec matches".to_string()
}

fn branches(repo: &Repository, kind: BranchType) -> String {
    let mut out = Vec::new();
    for b in repo.branches(Some(kind)).expect("branches") {
        let (b, _) = b.expect("branch");
        let short = b.name().ok().flatten().unwrap_or("<none>").to_string();
        let full = b.get().name().unwrap_or("?").to_string();
        let sym = if b.get().kind() == Some(git2::ReferenceType::Symbolic) { " (symbolic)" } else { "" };
        out.push(format!("{short} [{full}]{sym}"));
    }
    out.join(", ")
}

fn head(repo: &Repository) -> String {
    let detached = repo.head_detached().map(|d| d.to_string()).unwrap_or_else(|e| err(&e));
    match repo.head() {
        Ok(h) => format!(
            "Ok(target={:?}, shorthand={:?}) head_detached={detached}",
            h.target().map(|o| o.to_string()[..7].to_string()),
            h.shorthand()
        ),
        Err(e) => format!("{} head_detached={detached}", err(&e)),
    }
}

fn row(scenario: &str, call: &str, result: String) {
    println!("{scenario:<20} {call:<52} {result}");
}

fn main() {
    let base = std::env::args().nth(1).expect("usage: probe <repos dir>");
    let open = |name: &str| Repository::open(Path::new(&base).join(name)).expect(name);

    let r = open("s1-clone");
    row("s1-clone", "remote branches", branches(&r, BranchType::Remote));
    row("s1-clone", "branch_remote_name(origin/main)", remote_name(&r, "refs/remotes/origin/main"));
    row("s1-clone", "branch_remote_name(origin/feat/x)", remote_name(&r, "refs/remotes/origin/feat/x"));
    row("s1-clone", "name_on_remote(origin/feat/x)", name_on_remote(&r, "refs/remotes/origin/feat/x"));
    row("s1-clone", "find_reference(origin/HEAD)", symbolic(&r, "refs/remotes/origin/HEAD"));
    row("s1-clone", "branch_upstream_name(main)", upstream_name(&r, "refs/heads/main"));
    row("s1-clone", "branch_upstream_name(nolink)", upstream_name(&r, "refs/heads/nolink"));

    let r = open("s2-slash-remote");
    row("s2-slash-remote", "remote branches", branches(&r, BranchType::Remote));
    row("s2-slash-remote", "branch_remote_name(team/origin/main)", remote_name(&r, "refs/remotes/team/origin/main"));
    row("s2-slash-remote", "name_on_remote(team/origin/feat/x)", name_on_remote(&r, "refs/remotes/team/origin/feat/x"));
    row("s2-slash-remote", "find_reference(team/origin/HEAD)", symbolic(&r, "refs/remotes/team/origin/HEAD"));

    let r = open("s3-stale");
    row("s3-stale", "remote branches", branches(&r, BranchType::Remote));
    row("s3-stale", "branch_remote_name(gone/feat) [no such remote]", remote_name(&r, "refs/remotes/gone/feat"));
    row("s3-stale", "branch_remote_name(old/main) [remote config gone]", remote_name(&r, "refs/remotes/old/main"));

    let r = open("s4-ambiguous");
    row("s4-ambiguous", "branch_remote_name(origin/main)", remote_name(&r, "refs/remotes/origin/main"));

    let r = open("s5-custom-refspec");
    row("s5-custom-refspec", "remote branches", branches(&r, BranchType::Remote));
    row("s5-custom-refspec", "branch_remote_name(upstream/main)", remote_name(&r, "refs/remotes/upstream/main"));
    row("s5-custom-refspec", "name_on_remote(upstream/feat/x)", name_on_remote(&r, "refs/remotes/upstream/feat/x"));
    row("s5-custom-refspec", "branch_upstream_name(main)", upstream_name(&r, "refs/heads/main"));

    let r = open("s6-no-origin-head");
    row("s6-no-origin-head", "find_reference(origin/HEAD)", symbolic(&r, "refs/remotes/origin/HEAD"));

    let r = open("s7-dangling-head");
    row("s7-dangling-head", "find_reference(origin/HEAD)", symbolic(&r, "refs/remotes/origin/HEAD"));
    row("s7-dangling-head", "remote branches", branches(&r, BranchType::Remote));

    let r = open("s8-upstream-pruned");
    row("s8-upstream-pruned", "branch_upstream_name(gone-later)", upstream_name(&r, "refs/heads/gone-later"));

    let r = open("s9-upstream-local");
    row("s9-upstream-local", "branch_upstream_name(feat-local)", upstream_name(&r, "refs/heads/feat-local"));

    row("s10-detached", "head()", head(&open("s10-detached")));
    row("s11-unborn", "head()", head(&open("s11-unborn")));
}
