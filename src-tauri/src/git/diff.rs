use crate::error::{KiraError, Result};
use git2::{Delta, DiffFindOptions, DiffOptions, Oid, Patch, Repository, Status, StatusOptions};
use serde::Serialize;

const MAX_BLOB_SIZE: i64 = 10 * 1024 * 1024;
const RENAME_LIMIT: u32 = 200;
const MAX_OID_LEN: usize = 40;
/// 單一 commit 最多回幾個 file diff——超過 cap 即截斷並 set `truncated=true`。
/// 防大型/惡意 commit（e.g. monorepo wide refactor 動 5000 檔）讓 renderer 同步 highlight
/// 全部變慢 / 凍結 UI。前端用此 flag 顯示「列表已截斷」提示。
const MAX_FILES_PER_DIFF: usize = 500;
const MAX_UNSTAGED_FILES: usize = 5000;
/// 顯示預算：超過的檔整檔收合（列出檔名與大小、不送內容）。開 repo 會立刻載 HEAD 的 diff，
/// 而卡的是前端逐行渲染（release 實測每行 25–68µs、每千字元 0.4–1.6ms），上限內最壞約 0.5 秒。
/// 單檔上限讓一個大鎖檔不會吃光總量、擠掉排在它後面的程式碼。
/// 算字元不算 UTF-8 位元組：渲染成本跟字元數走（同樣 60,300 字，中文 180KB 只比英文 60KB 慢約 15%），
/// 算位元組會讓中文提早三倍被收合
pub(crate) const MAX_FILE_DIFF_LINES: usize = 2_000;
pub(crate) const MAX_FILE_DIFF_CHARS: usize = 128 * 1024;
pub(crate) const MAX_TOTAL_DIFF_LINES: usize = 5_000;
pub(crate) const MAX_TOTAL_DIFF_CHARS: usize = 256 * 1024;

#[derive(Debug, Serialize)]
pub struct DiffResult {
    pub files: Vec<FileDiff>,
    /// File 數量超過 MAX_FILES_PER_DIFF 時 backend 截斷並 set true，UI 應顯示截斷提示
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct FileDiff {
    pub path: String,
    pub status: FileStatusKind,
    pub hunks: Vec<Hunk>,
    pub binary: bool,
    pub too_large: bool,
    /// 超過顯示預算被收合時有值（hunks 為空）；`lines` / `bytes` 是這個檔自己的大小
    pub omitted: Option<Omitted>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Omitted {
    pub reason: OmitReason,
    pub lines: usize,
    pub bytes: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq, Clone, Copy)]
pub enum OmitReason {
    /// 這個檔自己就超過單檔上限
    File,
    /// 前面送出的檔已經用掉總量，這個檔放不下
    Total,
}

/// 一個檔送出去的量：預算看行數與字元，收合時顯示的大小用 UTF-8 位元組。
/// 每行都算「去掉行尾換行的內容 + 1」
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DiffCost {
    pub lines: usize,
    pub chars: usize,
    pub bytes: usize,
}

impl DiffCost {
    /// 送出去的一行：`text` 是送出去的文字（已去掉行尾換行），`raw_len` 是這段文字原本的位元組數。
    /// 兩條路徑都經過這裡，每行「+ 1」的算法只寫一次
    fn add_line(&mut self, text: &str, raw_len: usize) {
        self.lines += 1;
        self.chars += text.chars().count() + 1;
        self.bytes += raw_len + 1;
    }
}

/// 一次 diff 的顯示預算：依路徑順序逐檔問「放不放得下」，放得下才計入。放不下的檔收合，
/// 但繼續看下一個檔——後面更小的檔放得下照送。超過單檔上限的大鎖檔排在 `src/` 前面時
/// 不會擠掉程式碼；單檔上限內的鎖檔仍會先用掉總量
#[derive(Default)]
pub(crate) struct DiffBudget {
    lines: usize,
    chars: usize,
}

impl DiffBudget {
    /// 放得下就計入、回 `None`；放不下回這個檔的收合資訊（原因與它自己的大小）
    pub(crate) fn admit(&mut self, cost: DiffCost) -> Option<Omitted> {
        let omit = |reason: OmitReason| {
            Some(Omitted {
                reason,
                lines: cost.lines,
                bytes: cost.bytes,
            })
        };
        if cost.lines > MAX_FILE_DIFF_LINES || cost.chars > MAX_FILE_DIFF_CHARS {
            return omit(OmitReason::File);
        }
        if self.lines + cost.lines > MAX_TOTAL_DIFF_LINES
            || self.chars + cost.chars > MAX_TOTAL_DIFF_CHARS
        {
            return omit(OmitReason::Total);
        }
        self.lines += cost.lines;
        self.chars += cost.chars;
        None
    }
}

/// 已經建好的 hunks 送出去的量。PR 解析路徑用；git 路徑在建字串之前用 `patch_cost` 算。
/// 行數與字元數兩邊相同；位元組是各自看到的大小——不合法的 UTF-8 時，git 路徑是 repo 裡的原始大小，
/// 這裡的文字已經解碼過（每段換成 U+FFFD），是解碼後的大小
pub(crate) fn hunks_cost(hunks: &[Hunk]) -> DiffCost {
    let mut cost = DiffCost::default();
    for line in hunks.iter().flat_map(|h| h.lines.iter()) {
        cost.add_line(&line.content, line.content.len());
    }
    cost
}

/// `Hunk.context` 的上限（字元）
const MAX_HUNK_CONTEXT_CHARS: usize = 80;

/// hunk 標頭 `@@ … @@` 後面那段 → `Hunk.context`，git 與 PR 兩條路徑共用。那一行是 repo 的內容：
/// 不合法的 UTF-8 換成 U+FFFD（libgit2 照原始位元組給；它截在 80 位元組內、不切開字，2026-10-11 實測），
/// 控制字元（換行、跳脫序列）換成空白；去掉頭尾空白；最多 80 字元（GitHub 的 patch 不截）。
/// 雙向控制字元（U+202E 等，不是控制字元類）照原樣送：前端跟 diff 的行一起標出來（Phase 5 Q-T）
pub(crate) fn hunk_context(after: &[u8]) -> String {
    let text: String = String::from_utf8_lossy(after)
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let capped: String = text.trim().chars().take(MAX_HUNK_CONTEXT_CHARS).collect();
    capped.trim_end().to_string()
}

/// libgit2 的標頭 `@@ -a,b +c,d @@ 函式名\n` 裡，收尾的 `@@` 之後那段（範圍裡不會有 `@@`，函式名裡有也不影響）
fn header_tail(header: &[u8]) -> &[u8] {
    let rest = header.strip_prefix(b"@@").unwrap_or(header);
    rest.windows(2)
        .position(|w| w == b"@@")
        .map_or(&[] as &[u8], |i| &rest[i + 2..])
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub enum FileStatusKind {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Serialize)]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// 標頭 `@@ … @@` 後面那段：libgit2 從 hunk 往上找的第一行字母、`_` 或 `$` 開頭的行（多半是函式名），
    /// 沒有就是空字串。經 `hunk_context` 清理、最多 80 字元；不算進顯示預算——一個 hunk 一段，
    /// 比起它的行是零頭，算進去只會讓收合的界線跟著函式名長短浮動
    pub context: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize)]
pub struct DiffLine {
    pub origin: char,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct WorkingTreeStatus {
    pub staged: Vec<FileStatus>,
    pub unstaged: Vec<FileStatus>,
    pub conflicted: Vec<ConflictedFile>,
    pub unstaged_truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct FileStatus {
    pub path: String,
    pub status: WorktreeStatusKind,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub enum WorktreeStatusKind {
    Modified,
    New,
    Deleted,
}

/// SPEC.md `git_get_status` conflicted entry. `conflict_type` is derived from
/// libgit2 Index stage 1/2/3 entries:
///
/// | ancestor (stage 1) | our (stage 2) | their (stage 3) | conflict_type   |
/// |---|---|---|---|
/// | Some              | Some          | Some           | BothModified    |
/// | None              | Some          | Some           | BothAdded       |
/// | Some              | Some          | None           | DeletedByThem   |
/// | Some              | None          | Some           | DeletedByUs     |
///
/// `RenamedByBoth` is reserved in the schema but not actively emitted in T10
/// v1 — libgit2 Index has no direct cross-path rename-conflict signal, so it
/// falls back to BothModified for that pattern.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ConflictedFile {
    pub path: String,
    pub conflict_type: ConflictType,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub enum ConflictType {
    BothModified,
    BothAdded,
    DeletedByUs,
    DeletedByThem,
    // Reserved by SPEC contract for cross-path rename conflicts. libgit2's
    // Index has no direct signal, so T10 v1 falls back to BothModified for
    // that pattern; the variant stays so the IPC schema is stable when a
    // future commit adds path-tracking heuristics.
    #[allow(dead_code)]
    RenamedByBoth,
}

pub fn get_diff(repo: &Repository, oid_str: &str) -> Result<DiffResult> {
    validate_oid_str(oid_str)?;
    let oid = Oid::from_str(oid_str).map_err(|_| KiraError::CommitNotFound(oid_str.to_string()))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|_| KiraError::CommitNotFound(oid_str.to_string()))?;
    let new_tree = commit.tree()?;
    let old_tree = if commit.parent_count() == 0 {
        None
    } else {
        Some(commit.parent(0)?.tree()?)
    };

    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    opts.max_size(MAX_BLOB_SIZE);
    let mut diff = repo.diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(&mut opts))?;

    let mut find_opts = DiffFindOptions::new();
    find_opts
        .renames(true)
        .copies(true)
        .rename_limit(RENAME_LIMIT as usize);
    diff.find_similar(Some(&mut find_opts))?;

    let (files, truncated) = collect_file_diffs(&diff)?;
    Ok(DiffResult { files, truncated })
}

pub fn get_status(repo: &Repository) -> Result<WorkingTreeStatus> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut unstaged_truncated = false;

    for entry in statuses.iter() {
        let s = entry.status();
        if s.is_conflicted() {
            continue;
        }
        let path = entry
            .path()
            .map(String::from)
            .unwrap_or_else(|| String::from_utf8_lossy(entry.path_bytes()).into_owned());

        if let Some(status) = staged_kind(s) {
            staged.push(FileStatus {
                path: path.clone(),
                status,
            });
        }
        if let Some(status) = unstaged_kind(s) {
            if unstaged.len() < MAX_UNSTAGED_FILES {
                unstaged.push(FileStatus { path, status });
            } else {
                unstaged_truncated = true;
            }
        }
    }

    let conflicted = collect_conflicts(repo)?;

    Ok(WorkingTreeStatus {
        staged,
        unstaged,
        conflicted,
        unstaged_truncated,
    })
}

fn collect_conflicts(repo: &Repository) -> Result<Vec<ConflictedFile>> {
    let index = repo.index()?;
    if !index.has_conflicts() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for conflict in index.conflicts()? {
        let conflict = conflict?;
        let (path_bytes, conflict_type) = classify_conflict(&conflict);
        let path = String::from_utf8_lossy(&path_bytes).into_owned();
        out.push(ConflictedFile {
            path,
            conflict_type,
        });
    }
    Ok(out)
}

fn classify_conflict(c: &git2::IndexConflict) -> (Vec<u8>, ConflictType) {
    let kind = match (c.ancestor.is_some(), c.our.is_some(), c.their.is_some()) {
        (false, true, true) => ConflictType::BothAdded,
        (true, true, true) => ConflictType::BothModified,
        (true, true, false) => ConflictType::DeletedByThem,
        (true, false, true) => ConflictType::DeletedByUs,
        // Structurally invalid combinations (e.g. only ancestor present) get a
        // best-effort label rather than dropping the row — UI still shows a
        // path needing manual resolution.
        _ => ConflictType::BothModified,
    };
    let path = c
        .our
        .as_ref()
        .or(c.their.as_ref())
        .or(c.ancestor.as_ref())
        .map(|e| e.path.clone())
        .unwrap_or_default();
    (path, kind)
}

fn collect_file_diffs(diff: &git2::Diff<'_>) -> Result<(Vec<FileDiff>, bool)> {
    let deltas = diff.deltas();
    let total = deltas.len();
    let mut files = Vec::with_capacity(total.min(MAX_FILES_PER_DIFF));
    let mut budget = DiffBudget::default();
    for (idx, delta) in deltas.take(MAX_FILES_PER_DIFF).enumerate() {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let status = map_delta_status(delta.status());

        // libgit2 對 BINARY flag 與 file size 是 lazy 填充，只有 Patch::from_diff 觸發 blob load
        // 之後才會 populate；必須先 load patch 再 read delta 的 flags 才不會拿到 false/0 預設值。
        // 先算這個檔的大小（合法 UTF-8 時不建字串），放得下才收行；patch 在這一圈結束就丟，一次只握一個。
        // binary / too_large 沒有 hunk，大小是 0，不吃預算
        let (hunks, omitted) = match Patch::from_diff(diff, idx)? {
            Some(mut patch) => match budget.admit(patch_cost(&patch)?) {
                None => (collect_hunks(&mut patch)?, None),
                omitted => (Vec::new(), omitted),
            },
            None => (Vec::new(), None),
        };
        let (binary, too_large) = classify_blob_flags(&delta);

        files.push(FileDiff {
            path,
            status,
            hunks,
            binary,
            too_large,
            omitted,
        });
    }
    let truncated = total > MAX_FILES_PER_DIFF;
    Ok((files, truncated))
}

/// 剝除 line content 末尾的 `\r\n` 或 `\n`（只剝一個）。
/// libgit2 `DiffLine::content()` 帶原始 line bytes 含尾端換行；前端用 `whitespace-pre`
/// 渲染每一列，若 content 多帶換行會多吃一行視覺空間，讓 old/new line number 跟內容
/// 對不齊。EOL 標記由 line 的 origin (' ', '+', '-', '=' for EOF marker) 表達，內容本身
/// 不需保留換行。`patch_cost` 與 `collect_hunks` 共用它：算的跟送的是同一段文字
fn strip_eol(raw: &[u8]) -> &[u8] {
    raw.strip_suffix(b"\r\n")
        .or_else(|| raw.strip_suffix(b"\n"))
        .unwrap_or(raw)
}

/// 這個 patch 送出去的量：跟 `collect_hunks` 收的行一一對應。只讀 libgit2 借出的 bytes；
/// 字元數照送出去的文字算，跟 `collect_hunks` 同樣經過 `strip_eol` 與 `from_utf8_lossy`
/// （合法 UTF-8 不建字串，不合法的每一段換成一個 U+FFFD）。只數 UTF-8 開頭位元組的話，
/// 單獨的 0x80–0xBF 一個都不算，整行 0x80 就能整檔繞過上限
fn patch_cost(patch: &Patch<'_>) -> Result<DiffCost> {
    let mut cost = DiffCost::default();
    for h in 0..patch.num_hunks() {
        for l in 0..patch.num_lines_in_hunk(h)? {
            let content = strip_eol(patch.line_in_hunk(h, l)?.content());
            cost.add_line(&String::from_utf8_lossy(content), content.len());
        }
    }
    Ok(cost)
}

/// 對 (binary, too_large) 取 mutually-exclusive view：
/// libgit2 對 size > MAX_BLOB_SIZE 也會 set BINARY flag，前端需 too_large 優先級高過 binary
/// 才能顯示「太大略過」而不是泛 binary 訊息。size cap 邊界用 `>` 而非 `>=`，跟 DiffOptions::max_size
/// 觸發點對齊（max_size(N) 只在 size > N 時觸發）。
fn classify_blob_flags(delta: &git2::DiffDelta<'_>) -> (bool, bool) {
    let cap = MAX_BLOB_SIZE as u64;
    let too_large = delta.old_file().size() > cap || delta.new_file().size() > cap;
    let raw_binary = delta.old_file().is_binary() || delta.new_file().is_binary();
    let binary = raw_binary && !too_large;
    (binary, too_large)
}

fn collect_hunks(patch: &mut Patch<'_>) -> Result<Vec<Hunk>> {
    let num = patch.num_hunks();
    let mut hunks = Vec::with_capacity(num);
    for h in 0..num {
        let (hunk, line_count) = patch.hunk(h)?;
        let mut lines = Vec::with_capacity(line_count);
        for l in 0..line_count {
            let dline = patch.line_in_hunk(h, l)?;
            lines.push(DiffLine {
                origin: dline.origin(),
                content: String::from_utf8_lossy(strip_eol(dline.content())).into_owned(),
                old_lineno: dline.old_lineno(),
                new_lineno: dline.new_lineno(),
            });
        }
        hunks.push(Hunk {
            old_start: hunk.old_start(),
            old_lines: hunk.old_lines(),
            new_start: hunk.new_start(),
            new_lines: hunk.new_lines(),
            context: hunk_context(header_tail(hunk.header())),
            lines,
        });
    }
    Ok(hunks)
}

fn validate_oid_str(s: &str) -> Result<()> {
    if s.is_empty() || s.len() > MAX_OID_LEN || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(KiraError::CommitNotFound("invalid oid format".into()));
    }
    Ok(())
}

fn map_delta_status(d: Delta) -> FileStatusKind {
    match d {
        Delta::Added => FileStatusKind::Added,
        Delta::Deleted => FileStatusKind::Deleted,
        Delta::Renamed | Delta::Copied => FileStatusKind::Renamed,
        _ => FileStatusKind::Modified,
    }
}

fn staged_kind(s: Status) -> Option<WorktreeStatusKind> {
    if s.intersects(Status::INDEX_NEW) {
        Some(WorktreeStatusKind::New)
    } else if s.intersects(Status::INDEX_DELETED) {
        Some(WorktreeStatusKind::Deleted)
    } else if s
        .intersects(Status::INDEX_MODIFIED | Status::INDEX_RENAMED | Status::INDEX_TYPECHANGE)
    {
        Some(WorktreeStatusKind::Modified)
    } else {
        None
    }
}

fn unstaged_kind(s: Status) -> Option<WorktreeStatusKind> {
    if s.intersects(Status::WT_NEW) {
        Some(WorktreeStatusKind::New)
    } else if s.intersects(Status::WT_DELETED) {
        Some(WorktreeStatusKind::Deleted)
    } else if s.intersects(Status::WT_MODIFIED | Status::WT_RENAMED | Status::WT_TYPECHANGE) {
        Some(WorktreeStatusKind::Modified)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{BranchType, Repository, Signature};
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn init_repo() -> (TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        (dir, repo)
    }

    fn write_file(root: &Path, name: &str, content: &str) {
        fs::write(root.join(name), content).unwrap();
    }

    fn stage_all(repo: &Repository) {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
    }

    fn commit_all(repo: &Repository, message: &str) -> Oid {
        stage_all(repo);
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
    fn test_get_diff_invalid_oid_returns_commit_not_found() {
        let (_dir, repo) = init_repo();
        let result = get_diff(&repo, "deadbeef");
        assert!(matches!(result, Err(KiraError::CommitNotFound(_))));
    }

    #[test]
    fn test_get_diff_oid_with_newline_does_not_leak_raw_input() {
        let (_dir, repo) = init_repo();
        let poisoned = "deadbeef\nERROR: leaked secret token";
        let err = get_diff(&repo, poisoned).unwrap_err();
        let msg = err.to_string();
        assert!(
            !msg.contains("ERROR"),
            "poisoned oid leaked into error: {msg}"
        );
        assert!(!msg.contains('\n'), "newline leaked into error: {msg}");
        assert!(matches!(err, KiraError::CommitNotFound(_)));
    }

    #[test]
    fn test_get_diff_oid_too_long_does_not_leak_raw_input() {
        let (_dir, repo) = init_repo();
        let long = "a".repeat(200);
        let err = get_diff(&repo, &long).unwrap_err();
        assert!(!err.to_string().contains(&long));
    }

    #[test]
    fn test_get_diff_unknown_oid_returns_commit_not_found() {
        let (_dir, repo) = init_repo();
        // valid hex format but non-existent
        let result = get_diff(&repo, "0000000000000000000000000000000000000001");
        assert!(matches!(result, Err(KiraError::CommitNotFound(_))));
    }

    #[test]
    fn test_get_diff_initial_commit_lists_added_files_with_hunks() {
        let (dir, repo) = init_repo();
        write_file(dir.path(), "a.txt", "hello\nworld\n");
        let oid = commit_all(&repo, "init");

        let result = get_diff(&repo, &oid.to_string()).unwrap();
        assert_eq!(result.files.len(), 1);
        let f = &result.files[0];
        assert_eq!(f.path, "a.txt");
        assert_eq!(f.status, FileStatusKind::Added);
        assert!(!f.hunks.is_empty(), "added file must have hunks");
        let first_hunk = &f.hunks[0];
        assert!(first_hunk.lines.iter().any(|l| l.origin == '+'));
    }

    #[test]
    fn test_get_diff_modified_file_returns_added_and_removed_lines() {
        let (dir, repo) = init_repo();
        write_file(dir.path(), "a.txt", "one\ntwo\nthree\n");
        commit_all(&repo, "first");
        write_file(dir.path(), "a.txt", "one\ntwoX\nthree\n");
        let oid = commit_all(&repo, "second");

        let result = get_diff(&repo, &oid.to_string()).unwrap();
        assert_eq!(result.files.len(), 1);
        let f = &result.files[0];
        assert_eq!(f.status, FileStatusKind::Modified);
        let lines: Vec<_> = f.hunks.iter().flat_map(|h| h.lines.iter()).collect();
        // 注意：DiffLine.content 已 strip 末尾 \n（避免前端 whitespace-pre 多吃換行對齊錯位）
        assert!(lines.iter().any(|l| l.origin == '+' && l.content == "twoX"));
        assert!(lines.iter().any(|l| l.origin == '-' && l.content == "two"));
    }

    #[test]
    fn test_get_diff_deleted_file_marked_deleted() {
        let (dir, repo) = init_repo();
        write_file(dir.path(), "a.txt", "x\n");
        commit_all(&repo, "add");
        fs::remove_file(dir.path().join("a.txt")).unwrap();
        let oid = commit_all(&repo, "delete");

        let result = get_diff(&repo, &oid.to_string()).unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].status, FileStatusKind::Deleted);
    }

    #[test]
    fn test_get_diff_binary_file_marks_binary_true_no_hunks() {
        let (dir, repo) = init_repo();
        // 先 init 文字 commit（給 binary heuristic 一個 old blob 對比）
        write_file(dir.path(), "blob.bin", "placeholder\n");
        commit_all(&repo, "init");
        // 改成 binary content：NUL byte + 任意 256 byte → libgit2 NUL heuristic 標 BINARY
        let binary_content: Vec<u8> = (0..256u32).map(|n| (n % 256) as u8).collect();
        fs::write(dir.path().join("blob.bin"), &binary_content).unwrap();
        let oid = commit_all(&repo, "make binary");

        let result = get_diff(&repo, &oid.to_string()).unwrap();
        assert_eq!(result.files.len(), 1);
        let f = &result.files[0];
        assert_eq!(f.path, "blob.bin");
        assert!(f.binary, "binary heuristic should mark .bin as binary");
        assert!(!f.too_large, "256-byte file is not too large");
        assert!(f.hunks.is_empty(), "binary diff should have no hunks");
    }

    #[test]
    fn test_get_diff_too_large_blob_marks_too_large_priority_over_binary() {
        let (dir, repo) = init_repo();
        // 先 small commit 給 old blob 對比
        write_file(dir.path(), "big.txt", "small\n");
        commit_all(&repo, "init");
        // > MAX_BLOB_SIZE (10MB) → libgit2 set BINARY flag，前端應看到 too_large=true / binary=false
        let oversize: Vec<u8> = vec![b'a'; (MAX_BLOB_SIZE as usize) + 1];
        fs::write(dir.path().join("big.txt"), &oversize).unwrap();
        let oid = commit_all(&repo, "grow oversize");

        let result = get_diff(&repo, &oid.to_string()).unwrap();
        assert_eq!(result.files.len(), 1);
        let f = &result.files[0];
        assert!(f.too_large, "size > MAX_BLOB_SIZE must set too_large");
        assert!(
            !f.binary,
            "too_large takes priority — binary must be false even if libgit2 set BINARY flag"
        );
        assert!(f.hunks.is_empty(), "too-large diff should have no hunks");
    }

    #[test]
    fn test_strip_eol_handles_lf_crlf_and_no_eol() {
        assert_eq!(strip_eol(b"hello\n"), b"hello");
        assert_eq!(strip_eol(b"hello\r\n"), b"hello");
        assert_eq!(strip_eol(b"hello"), b"hello");
        assert_eq!(strip_eol(b""), b"");
        // 只剝末尾一個——多重 \n 是檔案內容不該破壞
        assert_eq!(strip_eol(b"hello\n\n"), b"hello\n");
    }

    #[test]
    fn test_get_diff_line_content_does_not_carry_trailing_newline() {
        // 防 regression：DiffLine.content 末尾若帶 \n / \r\n 會在 UI 渲染時多吃一行，
        // 讓 old/new line number 跟內容對不齊
        let (dir, repo) = init_repo();
        write_file(dir.path(), "a.txt", "alpha\nbeta\ngamma\n");
        let oid = commit_all(&repo, "init");
        let result = get_diff(&repo, &oid.to_string()).unwrap();
        let lines: Vec<_> = result.files[0]
            .hunks
            .iter()
            .flat_map(|h| h.lines.iter())
            .collect();
        assert!(!lines.is_empty());
        for line in &lines {
            assert!(
                !line.content.ends_with('\n'),
                "DiffLine.content must not retain trailing \\n: {:?}",
                line.content
            );
            assert!(
                !line.content.ends_with('\r'),
                "DiffLine.content must not retain trailing \\r: {:?}",
                line.content
            );
        }
    }

    #[test]
    fn test_get_diff_no_newline_note_is_its_own_line_after_the_line_it_belongs_to() {
        // libgit2 的「\ No newline at end of file」是獨立一行（Phase 5 Q-N，前端照這個形狀畫成註記、fidelity 的
        // fixture 也照它）：origin 看缺換行的那一側（`-` 之後 `>`、`+` 之後 `<`、context 之後 `=`）、內容開頭帶
        // 換行（strip_eol 只剝尾端）、行號沿用上一行、不算進 hunk 的行數。只補檔尾換行的 commit 實跑（2026-10-11），
        // 釘在這裡：libgit2 升版改了形狀，這裡先紅，不用等截圖比對
        let (dir, repo) = init_repo();
        write_file(dir.path(), "t.txt", "alpha\nbeta");
        commit_all(&repo, "chore: without the newline");
        write_file(dir.path(), "t.txt", "alpha\nbeta\n");
        let oid = commit_all(&repo, "chore: add the newline");
        let result = get_diff(&repo, &oid.to_string()).unwrap();
        let hunk = &result.files[0].hunks[0];
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_lines,
                hunk.new_start,
                hunk.new_lines
            ),
            (1, 2, 1, 2)
        );
        let got: Vec<(char, &str, Option<u32>, Option<u32>)> = hunk
            .lines
            .iter()
            .map(|l| (l.origin, l.content.as_str(), l.old_lineno, l.new_lineno))
            .collect();
        assert_eq!(
            got,
            vec![
                (' ', "alpha", Some(1), Some(1)),
                ('-', "beta", Some(2), None),
                ('>', "\n\\ No newline at end of file", Some(2), None),
                ('+', "beta", None, Some(2)),
            ]
        );
    }

    // 另外兩種形狀也釘住（第二輪審查 2026-10-12：前面只釘了 `>`，`<` 與 `=` 只有前端 fixture 在猜）：
    // 拿掉檔尾換行 → `+` 之後 `<`，行號沿用新側；兩側都沒有、最後一行是 context → `=`，兩側行號都沿用
    #[test]
    fn test_get_diff_no_newline_note_after_an_added_line_and_after_context() {
        let (dir, repo) = init_repo();
        write_file(dir.path(), "t.txt", "alpha\nbeta\n");
        commit_all(&repo, "chore: with the newline");
        write_file(dir.path(), "t.txt", "alpha\nbeta");
        let oid = commit_all(&repo, "chore: drop the newline");
        let result = get_diff(&repo, &oid.to_string()).unwrap();
        let hunk = &result.files[0].hunks[0];
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_lines,
                hunk.new_start,
                hunk.new_lines
            ),
            (1, 2, 1, 2)
        );
        let got: Vec<(char, &str, Option<u32>, Option<u32>)> = hunk
            .lines
            .iter()
            .map(|l| (l.origin, l.content.as_str(), l.old_lineno, l.new_lineno))
            .collect();
        assert_eq!(
            got,
            vec![
                (' ', "alpha", Some(1), Some(1)),
                ('-', "beta", Some(2), None),
                ('+', "beta", None, Some(2)),
                ('<', "\n\\ No newline at end of file", None, Some(2)),
            ]
        );

        write_file(dir.path(), "t.txt", "alpha2\nbeta");
        let oid = commit_all(&repo, "chore: change the first line, still no newline");
        let result = get_diff(&repo, &oid.to_string()).unwrap();
        let hunk = &result.files[0].hunks[0];
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_lines,
                hunk.new_start,
                hunk.new_lines
            ),
            (1, 2, 1, 2)
        );
        let got: Vec<(char, &str, Option<u32>, Option<u32>)> = hunk
            .lines
            .iter()
            .map(|l| (l.origin, l.content.as_str(), l.old_lineno, l.new_lineno))
            .collect();
        assert_eq!(
            got,
            vec![
                ('-', "alpha", Some(1), None),
                ('+', "alpha2", None, Some(1)),
                (' ', "beta", Some(2), Some(2)),
                ('=', "\n\\ No newline at end of file", Some(2), Some(2)),
            ]
        );
    }

    #[test]
    fn test_get_diff_truncates_when_file_count_exceeds_cap() {
        let (dir, repo) = init_repo();
        let total = MAX_FILES_PER_DIFF + 5;
        for i in 0..total {
            write_file(dir.path(), &format!("f{i}.txt"), "x\n");
        }
        let oid = commit_all(&repo, "many files");
        let result = get_diff(&repo, &oid.to_string()).unwrap();
        assert_eq!(result.files.len(), MAX_FILES_PER_DIFF);
        assert!(
            result.truncated,
            "expected truncated=true when total ({total}) > cap ({MAX_FILES_PER_DIFF})"
        );
    }

    #[test]
    fn test_get_diff_not_truncated_within_cap() {
        let (dir, repo) = init_repo();
        for i in 0..3 {
            write_file(dir.path(), &format!("f{i}.txt"), "x\n");
        }
        let oid = commit_all(&repo, "few files");
        let result = get_diff(&repo, &oid.to_string()).unwrap();
        assert_eq!(result.files.len(), 3);
        assert!(!result.truncated);
    }

    // ---- 顯示預算：超過的檔整檔收合，其他照送 ----

    /// n 行、每行 `width` 個字元（不含換行）
    fn lines_of(n: usize, width: usize) -> String {
        format!("{}\n", "x".repeat(width)).repeat(n)
    }

    /// n 行、每行 `width` 個中文字（UTF-8 一個字 3 bytes）
    fn cjk_lines_of(n: usize, width: usize) -> String {
        format!("{}\n", "字".repeat(width)).repeat(n)
    }

    /// 測試自己的計數（不借用實作）：送出的行數、每行「內容長度 + 1」的加總
    fn sent_cost(f: &FileDiff) -> (usize, usize) {
        let lines = f.hunks.iter().flat_map(|h| h.lines.iter());
        lines.fold((0, 0), |(n, b), l| (n + 1, b + l.content.len() + 1))
    }

    fn diff_of(dir: &TempDir, repo: &Repository, files: &[(&str, String)]) -> DiffResult {
        for (name, content) in files {
            write_file(dir.path(), name, content);
        }
        let oid = commit_all(repo, "budget");
        get_diff(repo, &oid.to_string()).unwrap()
    }

    fn file<'a>(r: &'a DiffResult, path: &str) -> &'a FileDiff {
        r.files.iter().find(|f| f.path == path).unwrap()
    }

    #[test]
    fn test_budget_file_at_line_cap_is_sent_whole() {
        let (dir, repo) = init_repo();
        let r = diff_of(&dir, &repo, &[("a.txt", lines_of(MAX_FILE_DIFF_LINES, 3))]);
        let f = file(&r, "a.txt");
        assert_eq!(f.omitted, None);
        assert_eq!(sent_cost(f), (MAX_FILE_DIFF_LINES, MAX_FILE_DIFF_LINES * 4));
    }

    #[test]
    fn test_budget_file_over_line_cap_is_omitted_with_its_size() {
        let (dir, repo) = init_repo();
        let n = MAX_FILE_DIFF_LINES + 1;
        let r = diff_of(&dir, &repo, &[("a.txt", lines_of(n, 3))]);
        let f = file(&r, "a.txt");
        let expected = Omitted {
            reason: OmitReason::File,
            lines: n,
            bytes: n * 4,
        };
        assert_eq!(f.omitted, Some(expected));
        assert!(f.hunks.is_empty(), "an omitted file must not carry hunks");
    }

    #[test]
    fn test_budget_single_line_at_char_cap_is_sent() {
        let (dir, repo) = init_repo();
        let r = diff_of(
            &dir,
            &repo,
            &[("min.js", lines_of(1, MAX_FILE_DIFF_CHARS - 1))],
        );
        let f = file(&r, "min.js");
        assert_eq!(f.omitted, None);
        let sent = &f.hunks[0].lines;
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].content.chars().count() + 1, MAX_FILE_DIFF_CHARS);
    }

    #[test]
    fn test_budget_single_line_over_char_cap_is_omitted() {
        // 壓縮檔：一行就超過單檔字元上限
        let (dir, repo) = init_repo();
        let r = diff_of(&dir, &repo, &[("min.js", lines_of(1, MAX_FILE_DIFF_CHARS))]);
        let f = file(&r, "min.js");
        let expected = Omitted {
            reason: OmitReason::File,
            lines: 1,
            bytes: MAX_FILE_DIFF_CHARS + 1,
        };
        assert_eq!(f.omitted, Some(expected));
        assert!(f.hunks.is_empty());
    }

    #[test]
    fn test_budget_total_skips_the_overflowing_file_but_sends_later_files_that_fit() {
        // 鎖檔排在程式碼前面：a、b 用掉 4,000 行，c（1,001 行）放不下 → Total；
        // d（1,000 行）剛好填到 5,000 → 照送
        let (dir, repo) = init_repo();
        let full = MAX_FILE_DIFF_LINES;
        let rest = MAX_TOTAL_DIFF_LINES - 2 * full;
        let r = diff_of(
            &dir,
            &repo,
            &[
                ("a.lock", lines_of(full, 3)),
                ("b.lock", lines_of(full, 3)),
                ("c.ts", lines_of(rest + 1, 3)),
                ("d.ts", lines_of(rest, 3)),
            ],
        );
        assert_eq!(file(&r, "a.lock").omitted, None);
        assert_eq!(file(&r, "b.lock").omitted, None);
        let expected = Omitted {
            reason: OmitReason::Total,
            lines: rest + 1,
            bytes: (rest + 1) * 4,
        };
        assert_eq!(file(&r, "c.ts").omitted, Some(expected));
        assert!(file(&r, "c.ts").hunks.is_empty());
        assert_eq!(file(&r, "d.ts").omitted, None);
        assert_eq!(sent_cost(file(&r, "d.ts")).0, rest);
    }

    #[test]
    fn test_budget_total_char_cap() {
        // 兩個檔各一行、各剛好單檔上限 → 合計剛好總量，照送；第三個檔再多 2 個字元就放不下
        assert_eq!(
            MAX_TOTAL_DIFF_CHARS,
            2 * MAX_FILE_DIFF_CHARS,
            "this test assumes the total equals two full files"
        );
        let (dir, repo) = init_repo();
        let w = MAX_FILE_DIFF_CHARS - 1;
        let r = diff_of(
            &dir,
            &repo,
            &[
                ("a.js", lines_of(1, w)),
                ("b.js", lines_of(1, w)),
                ("c.js", lines_of(1, 1)),
            ],
        );
        assert_eq!(file(&r, "a.js").omitted, None);
        assert_eq!(file(&r, "b.js").omitted, None);
        let expected = Omitted {
            reason: OmitReason::Total,
            lines: 1,
            bytes: 2,
        };
        assert_eq!(file(&r, "c.js").omitted, Some(expected));
    }

    #[test]
    fn test_budget_binary_file_costs_nothing() {
        // 回歸保護：binary 沒有內容，不吃預算——夾在中間也不會讓後面剛好填滿總量的檔被收合
        let (dir, repo) = init_repo();
        let binary: Vec<u8> = (0..256u32).map(|n| (n % 256) as u8).collect();
        fs::write(dir.path().join("b.bin"), &binary).unwrap();
        let full = MAX_FILE_DIFF_LINES;
        let rest = MAX_TOTAL_DIFF_LINES - 2 * full;
        let r = diff_of(
            &dir,
            &repo,
            &[
                ("a.txt", lines_of(full, 3)),
                ("c.txt", lines_of(full, 3)),
                ("d.txt", lines_of(rest, 3)),
            ],
        );
        let b = file(&r, "b.bin");
        assert!(b.binary);
        assert_eq!(b.omitted, None);
        for path in ["a.txt", "c.txt", "d.txt"] {
            assert_eq!(file(&r, path).omitted, None, "{path}");
        }
    }

    #[test]
    fn test_budget_counts_characters_not_utf8_bytes() {
        // 渲染成本跟字元數走：release 實測同樣 60,300 字，中文（180KB）只比英文（60KB）慢約 15%。
        // 10 萬個中文字（約 300KB）在單檔字元上限內，整份送出
        let (dir, repo) = init_repo();
        let r = diff_of(&dir, &repo, &[("chapter.md", cjk_lines_of(100, 1_000))]);
        let f = file(&r, "chapter.md");
        assert_eq!(f.omitted, None);
        assert_eq!(f.hunks.iter().map(|h| h.lines.len()).sum::<usize>(), 100);
    }

    #[test]
    fn test_budget_cjk_file_over_the_char_cap_reports_its_utf8_size() {
        // 回歸保護：上限算字元，收合訊息顯示的大小仍是 UTF-8
        let (dir, repo) = init_repo();
        let r = diff_of(
            &dir,
            &repo,
            &[("chapter.md", cjk_lines_of(1, MAX_FILE_DIFF_CHARS))],
        );
        let expected = Omitted {
            reason: OmitReason::File,
            lines: 1,
            bytes: 3 * MAX_FILE_DIFF_CHARS + 1,
        };
        assert_eq!(file(&r, "chapter.md").omitted, Some(expected));
    }

    #[test]
    fn test_budget_counts_invalid_utf8_as_it_is_sent() {
        // 單獨的 0x80–0xBF 送出時每個都變成一個 U+FFFD。只數 UTF-8 開頭位元組的話它們一個都不算，
        // 整行 0x80（沒有 NUL，libgit2 不當成 binary）不管多長都只算 1 個字，整檔繞過上限
        let (dir, repo) = init_repo();
        let mut stray = vec![0x80u8; MAX_FILE_DIFF_CHARS];
        stray.push(b'\n');
        fs::write(dir.path().join("stray.txt"), &stray).unwrap();
        let r = diff_of(&dir, &repo, &[]);
        let f = file(&r, "stray.txt");
        assert!(
            !f.binary,
            "the premise: libgit2 treats NUL-free bytes as text"
        );
        let expected = Omitted {
            reason: OmitReason::File,
            lines: 1,
            bytes: MAX_FILE_DIFF_CHARS + 1,
        };
        assert_eq!(f.omitted, Some(expected));
    }

    #[test]
    fn test_budget_invalid_utf8_at_the_char_cap_is_sent() {
        // 回歸保護：不合法的位元組照送出的字數算，不多算——剛好填滿單檔上限的照送
        let (dir, repo) = init_repo();
        let mut stray = vec![0x80u8; MAX_FILE_DIFF_CHARS - 1];
        stray.push(b'\n');
        fs::write(dir.path().join("stray.txt"), &stray).unwrap();
        let r = diff_of(&dir, &repo, &[]);
        let f = file(&r, "stray.txt");
        assert_eq!(f.omitted, None);
        let sent = &f.hunks[0].lines[0].content;
        assert_eq!(sent.chars().count() + 1, MAX_FILE_DIFF_CHARS);
    }

    #[test]
    fn test_budget_git_and_pr_paths_count_the_same() {
        // 同一個 commit：git 路徑直接算、PR 路徑吃同一份變更的 unified diff 文字（git2 印出），
        // 行數、字元、位元組、收合結果都要一樣（含中文）。檔案都以換行結尾：沒有換行結尾時 libgit2
        // 多一行「\ No newline」標記，PR 解析器略過它（每檔最多差兩行）。
        // notes.md 是 50,050 個中文字：在單檔字元上限內、UTF-8 位元組卻超過——任一條路徑改成算
        // 位元組，它就被收合，兩邊對不上；兩邊一起改錯則被最後那條「沒收合」抓到
        let (dir, repo) = init_repo();
        let base: String = (0..300).map(|i| format!("line {i}\n")).collect();
        write_file(dir.path(), "mid.txt", &base);
        write_file(dir.path(), "big.txt", &lines_of(10, 3));
        commit_all(&repo, "base");
        // big：每行都改、超過單檔上限；mid：相隔很遠的兩處修改 → 兩個帶 context 的 hunk；small：新增
        let mid = base
            .replace("line 10\n", "LINE 10\n")
            .replace("line 250\n", "LINE 250\n");
        let r_git = diff_of(
            &dir,
            &repo,
            &[
                ("big.txt", lines_of(MAX_FILE_DIFF_LINES + 5, 4)),
                ("mid.txt", mid),
                ("notes.md", cjk_lines_of(50, 1_000)),
                ("small.txt", lines_of(10, 7)),
            ],
        );
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let r_pr =
            crate::github::patch_parser::parse_unified_diff(&patch_text(&repo, &head)).unwrap();

        assert_eq!(r_git.files.len(), 4);
        assert_eq!(r_pr.files.len(), 4);
        for (g, p) in r_git.files.iter().zip(&r_pr.files) {
            assert_eq!(g.path, p.path);
            assert_eq!(g.omitted, p.omitted, "{}", g.path);
            assert_eq!(sent_cost(g), sent_cost(p), "{}", g.path);
        }
        let big = file(&r_git, "big.txt").omitted.as_ref().map(|o| o.reason);
        assert_eq!(big, Some(OmitReason::File));
        assert_eq!(file(&r_git, "mid.txt").hunks.len(), 2);
        assert_eq!(file(&r_git, "notes.md").omitted, None);
    }

    /// 這個 commit 對第一個 parent 的 unified diff 文字（同 `git diff`），給 PR 解析路徑吃
    fn patch_text(repo: &Repository, commit: &git2::Commit) -> String {
        let new_tree = commit.tree().unwrap();
        let old_tree = commit.parent(0).unwrap().tree().unwrap();
        let mut opts = git2::DiffOptions::new();
        opts.context_lines(3);
        let diff = repo
            .diff_tree_to_tree(Some(&old_tree), Some(&new_tree), Some(&mut opts))
            .unwrap();
        let mut text = String::new();
        diff.print(git2::DiffFormat::Patch, |_, _, line| {
            if matches!(line.origin(), '+' | '-' | ' ') {
                text.push(line.origin());
            }
            text.push_str(std::str::from_utf8(line.content()).unwrap());
            true
        })
        .unwrap();
        text
    }

    #[test]
    fn test_get_status_clean_repo_returns_empty() {
        let (dir, repo) = init_repo();
        write_file(dir.path(), "a.txt", "x\n");
        commit_all(&repo, "init");

        let status = get_status(&repo).unwrap();
        assert!(status.staged.is_empty());
        assert!(status.unstaged.is_empty());
    }

    #[test]
    fn test_get_status_untracked_appears_in_unstaged_as_new() {
        let (dir, repo) = init_repo();
        write_file(dir.path(), "a.txt", "x\n");

        let status = get_status(&repo).unwrap();
        assert!(status.staged.is_empty());
        assert_eq!(status.unstaged.len(), 1);
        assert_eq!(status.unstaged[0].path, "a.txt");
        assert_eq!(status.unstaged[0].status, WorktreeStatusKind::New);
    }

    #[test]
    fn test_get_status_staged_new_file() {
        let (dir, repo) = init_repo();
        write_file(dir.path(), "a.txt", "x\n");
        stage_all(&repo);

        let status = get_status(&repo).unwrap();
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].path, "a.txt");
        assert_eq!(status.staged[0].status, WorktreeStatusKind::New);
        assert!(status.unstaged.is_empty());
    }

    #[test]
    fn test_get_status_modified_after_commit_appears_in_unstaged() {
        let (dir, repo) = init_repo();
        write_file(dir.path(), "a.txt", "x\n");
        commit_all(&repo, "init");
        write_file(dir.path(), "a.txt", "y\n");

        let status = get_status(&repo).unwrap();
        assert!(status.staged.is_empty());
        assert_eq!(status.unstaged.len(), 1);
        assert_eq!(status.unstaged[0].status, WorktreeStatusKind::Modified);
    }

    #[test]
    fn test_get_status_staged_then_modified_appears_in_both() {
        let (dir, repo) = init_repo();
        write_file(dir.path(), "a.txt", "x\n");
        commit_all(&repo, "init");
        write_file(dir.path(), "a.txt", "y\n");
        stage_all(&repo);
        write_file(dir.path(), "a.txt", "z\n");

        let status = get_status(&repo).unwrap();
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].status, WorktreeStatusKind::Modified);
        assert_eq!(status.unstaged.len(), 1);
        assert_eq!(status.unstaged[0].status, WorktreeStatusKind::Modified);
    }

    // ==== T10 conflict tests ====

    /// Set up a repo with two branches diverging from a common base.
    /// Returns the feature branch tip OID so the caller can drive a merge.
    fn setup_diverged(
        dir: &TempDir,
        repo: &Repository,
        base_files: &[(&str, &str)],
        feature_changes: &dyn Fn(&Path),
        main_changes: &dyn Fn(&Path),
    ) -> Oid {
        for (name, content) in base_files {
            write_file(dir.path(), name, content);
        }
        commit_all(repo, "base");
        let base_head = repo.head().unwrap().target().unwrap();
        let base_commit = repo.find_commit(base_head).unwrap();
        repo.branch("feature", &base_commit, false).unwrap();

        // feature edits
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        feature_changes(dir.path());
        let feature_tip = commit_all(repo, "feature");

        // Switch back to the default branch — name varies by libgit2's
        // init.defaultBranch (main on newer builds, master on older), so we
        // find the non-feature local branch and use it.
        let original_branch = repo
            .branches(Some(BranchType::Local))
            .unwrap()
            .filter_map(|b| b.ok())
            .find_map(|(b, _)| match b.name().ok().flatten() {
                Some("feature") => None,
                Some(name) => Some(name.to_string()),
                None => None,
            })
            .expect("expected a default branch alongside feature");
        repo.set_head(&format!("refs/heads/{original_branch}"))
            .unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        main_changes(dir.path());
        commit_all(repo, "main");

        feature_tip
    }

    fn trigger_merge(repo: &Repository, feature_tip: Oid) {
        let annotated = repo.find_annotated_commit(feature_tip).unwrap();
        // merge ignores returned Err only signals fast-forward / up-to-date.
        // Conflicts populate Index::conflicts() rather than returning Err.
        let _ = repo.merge(&[&annotated], None, None);
    }

    #[test]
    fn test_get_status_no_conflict_returns_empty_conflicted_section() {
        let (dir, repo) = init_repo();
        write_file(dir.path(), "a.txt", "x\n");
        commit_all(&repo, "init");

        let status = get_status(&repo).unwrap();
        assert!(status.conflicted.is_empty());
    }

    #[test]
    fn test_get_status_both_modified_conflict() {
        let (dir, repo) = init_repo();
        let feature_tip = setup_diverged(
            &dir,
            &repo,
            &[("a.txt", "base\n")],
            &|path| write_file(path, "a.txt", "feature change\n"),
            &|path| write_file(path, "a.txt", "main change\n"),
        );
        trigger_merge(&repo, feature_tip);

        let status = get_status(&repo).unwrap();
        assert_eq!(status.conflicted.len(), 1);
        assert_eq!(status.conflicted[0].path, "a.txt");
        assert_eq!(
            status.conflicted[0].conflict_type,
            ConflictType::BothModified
        );
    }

    #[test]
    fn test_get_status_both_added_conflict() {
        let (dir, repo) = init_repo();
        let feature_tip = setup_diverged(
            &dir,
            &repo,
            // Base commit holds an unrelated file so neither branch is empty.
            &[("anchor.txt", "anchor\n")],
            &|path| write_file(path, "newcomer.txt", "feature flavor\n"),
            &|path| write_file(path, "newcomer.txt", "main flavor\n"),
        );
        trigger_merge(&repo, feature_tip);

        let status = get_status(&repo).unwrap();
        let entry = status
            .conflicted
            .iter()
            .find(|c| c.path == "newcomer.txt")
            .expect("newcomer.txt should be conflicted");
        assert_eq!(entry.conflict_type, ConflictType::BothAdded);
    }

    #[test]
    fn test_get_status_deleted_by_them_conflict() {
        // "ours" modifies the file, "theirs" (feature) deletes it.
        let (dir, repo) = init_repo();
        let feature_tip = setup_diverged(
            &dir,
            &repo,
            &[("doomed.txt", "alive\n")],
            &|path| {
                // feature: delete doomed.txt
                std::fs::remove_file(path.join("doomed.txt")).unwrap();
            },
            &|path| write_file(path, "doomed.txt", "main keeps editing\n"),
        );
        trigger_merge(&repo, feature_tip);

        let status = get_status(&repo).unwrap();
        let entry = status
            .conflicted
            .iter()
            .find(|c| c.path == "doomed.txt")
            .expect("doomed.txt should be conflicted");
        assert_eq!(entry.conflict_type, ConflictType::DeletedByThem);
    }

    #[test]
    fn test_get_status_deleted_by_us_conflict() {
        // "ours" deletes the file, "theirs" (feature) modifies it.
        let (dir, repo) = init_repo();
        let feature_tip = setup_diverged(
            &dir,
            &repo,
            &[("doomed.txt", "alive\n")],
            &|path| write_file(path, "doomed.txt", "feature keeps editing\n"),
            &|path| {
                std::fs::remove_file(path.join("doomed.txt")).unwrap();
            },
        );
        trigger_merge(&repo, feature_tip);

        let status = get_status(&repo).unwrap();
        let entry = status
            .conflicted
            .iter()
            .find(|c| c.path == "doomed.txt")
            .expect("doomed.txt should be conflicted");
        assert_eq!(entry.conflict_type, ConflictType::DeletedByUs);
    }

    // ---- hunk 標頭的函式名（Phase 5 B2）----

    /// 先 commit `before`，再把它改成 `after` commit，回第二個 commit 的第一個 hunk 的 context
    fn context_of_change(name: &str, before: &str, after: &str) -> String {
        let (dir, repo) = init_repo();
        write_file(dir.path(), name, before);
        commit_all(&repo, "before");
        write_file(dir.path(), name, after);
        let oid = commit_all(&repo, "after");
        let r = get_diff(&repo, &oid.to_string()).unwrap();
        r.files[0].hunks[0].context.clone()
    }

    const BODY: [&str; 8] = [
        "fn alpha() {",
        "    let a = 1;",
        "    let b = 2;",
        "    let c = 3;",
        "    let d = 4;",
        "    let e = 5;",
        "    let f = 6;",
        "}",
    ];

    fn joined(lines: &[&str], eol: &str) -> String {
        lines.iter().map(|l| format!("{l}{eol}")).collect()
    }

    #[test]
    fn test_hunk_context_names_the_line_above_the_hunk() {
        let after = BODY.map(|l| {
            if l.contains("e = 5") {
                "    let e = 50;"
            } else {
                l
            }
        });
        let ctx = context_of_change("a.rs", &joined(&BODY, "\n"), &joined(&after, "\n"));
        assert_eq!(ctx, "fn alpha() {");
    }

    #[test]
    fn test_hunk_context_is_empty_at_the_top_of_a_file() {
        let after = BODY.map(|l| {
            if l.starts_with("fn alpha") {
                "fn beta() {"
            } else {
                l
            }
        });
        let ctx = context_of_change("a.rs", &joined(&BODY, "\n"), &joined(&after, "\n"));
        assert_eq!(ctx, "");
    }

    #[test]
    fn test_hunk_context_drops_the_carriage_return_of_a_crlf_file() {
        let after = BODY.map(|l| {
            if l.contains("e = 5") {
                "    let e = 50;"
            } else {
                l
            }
        });
        let ctx = context_of_change("a.rs", &joined(&BODY, "\r\n"), &joined(&after, "\r\n"));
        assert_eq!(ctx, "fn alpha() {");
    }

    #[test]
    fn test_hunk_context_turns_control_characters_into_spaces() {
        // 函式名那一行是 repo 的內容：跳脫序列不能原樣送到畫面
        let mut before = BODY;
        before[0] = "fn alpha() { // \x1b[31mred\x1b[0m";
        let mut after = before;
        after[5] = "    let e = 50;";
        let ctx = context_of_change("a.rs", &joined(&before, "\n"), &joined(&after, "\n"));
        assert_eq!(ctx, "fn alpha() { //  [31mred [0m");
    }

    #[test]
    fn test_hunk_context_of_a_long_line_is_what_libgit2_keeps() {
        // libgit2 截在 80 位元組內、不切開字："fn " 之後每個中文字 3 位元組，第 26 個字會跨過 80，留 25 個
        // （前綴 1–6 個字元實測留 79 / 80 / 78 / 79 / 80 / 78 位元組，都是完整的字）
        let name = format!("fn {}() {{", "字".repeat(40));
        let mut before = BODY;
        before[0] = &name;
        let mut after = before;
        after[5] = "    let e = 50;";
        let ctx = context_of_change("a.rs", &joined(&before, "\n"), &joined(&after, "\n"));
        assert_eq!(ctx, format!("fn {}", "字".repeat(25)));
    }

    #[test]
    fn test_hunk_context_cleanup() {
        assert_eq!(hunk_context(b" fn main() {\n"), "fn main() {");
        assert_eq!(hunk_context(b""), "");
        // 不合法的位元組（例：Latin-1 的檔）換成 U+FFFD
        assert_eq!(hunk_context(b"fn caf\xe9() {"), "fn caf\u{fffd}() {");
        // 最多 80 字元，截完不留結尾空白
        assert_eq!(hunk_context("字".repeat(100).as_bytes()), "字".repeat(80));
        let spaced = format!("{} b", "a".repeat(79));
        assert_eq!(hunk_context(spaced.as_bytes()), "a".repeat(79));
    }

    #[test]
    fn test_header_tail_is_what_follows_the_closing_marker() {
        assert_eq!(
            header_tail(b"@@ -1,3 +1,4 @@ fn a() { @@ x\n"),
            b" fn a() { @@ x\n"
        );
        assert_eq!(header_tail(b"@@ -1 +1 @@\n"), b"\n");
        assert_eq!(header_tail(b"no markers"), b"");
    }
}
