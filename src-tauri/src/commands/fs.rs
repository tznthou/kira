use crate::fs::recent_repos::{self, RecentRepo};
use tauri::AppHandle;

/// Read-only IPC：load recent repos (含 stale prune)。前端 mirror，disk source of truth。
/// **不需要 `(async)` attribute**：純 `std::fs` 讀小 JSON（recent_repos.json < 1KB，
/// 最多 10 筆 entries），sub-ms I/O sync 直接執行不阻塞 Tauri runtime thread。
/// 若未來檔案變大或加 expensive metadata，升級為 `(async)`（重的 IPC 不佔主執行緒）。
#[tauri::command]
pub fn recent_repos_get(app: AppHandle) -> Vec<RecentRepo> {
    recent_repos::load(&app)
}
