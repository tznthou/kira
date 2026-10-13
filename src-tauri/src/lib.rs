mod commands;
mod error;
mod fs;
mod git;
mod github;
mod state;

use commands::clone_dest::pick_clone_dest;
use commands::fs::recent_repos_get;
use commands::git::{
    git_checkout_branch, git_clone_cancel, git_clone_start, git_commit, git_create_branch,
    git_delete_branch, git_get_ahead_behind, git_get_branch_stats, git_get_diff, git_get_graph,
    git_get_repo_info, git_get_status, git_list_branches, git_open_recent_repo,
    git_pick_and_open_repo, git_pull, git_push, git_stage_all, git_stage_file, git_unstage_all,
    git_unstage_file,
};
use commands::github::{
    github_get_auth_status, github_get_pr_diff, github_get_prs, github_logout, github_poll_token,
    github_start_device_flow,
};
use git::clone_registry::CloneRegistry;
use state::{ActiveWatcher, DiffGate, PendingCloneDestLock, RepoRegistry};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RepoRegistry::new())
        .manage(CloneRegistry::new())
        .manage(PendingCloneDestLock::new())
        .manage(ActiveWatcher::new())
        .manage(DiffGate::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            git_pick_and_open_repo,
            git_open_recent_repo,
            git_get_graph,
            git_get_diff,
            git_get_status,
            git_stage_file,
            git_unstage_file,
            git_stage_all,
            git_unstage_all,
            git_commit,
            git_push,
            git_pull,
            git_get_ahead_behind,
            git_get_repo_info,
            git_list_branches,
            git_get_branch_stats,
            git_create_branch,
            git_delete_branch,
            git_checkout_branch,
            github_start_device_flow,
            github_poll_token,
            github_logout,
            github_get_auth_status,
            github_get_prs,
            github_get_pr_diff,
            recent_repos_get,
            pick_clone_dest,
            git_clone_start,
            git_clone_cancel,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
