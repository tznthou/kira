use crate::error::{KiraError, Result};
use crate::git::diff::{
    hunk_context, hunks_cost, DiffBudget, DiffLine, DiffResult, FileDiff, FileStatusKind, Hunk,
};

const MAX_DIFF_TEXT_SIZE: usize = 1_048_576; // 1 MB
const MAX_FILES_PER_DIFF: usize = 500;

pub fn parse_unified_diff(text: &str) -> Result<DiffResult> {
    if text.is_empty() {
        return Ok(DiffResult {
            files: Vec::new(),
            truncated: false,
        });
    }
    // 下載那道（pr::fetch_pr_diff_at）已經擋過；這裡同一個上限、同一個碼（太大，不是格式壞了）
    if text.len() > MAX_DIFF_TEXT_SIZE {
        return Err(KiraError::PrDiffTooLarge);
    }
    if !text.contains("diff --git ") {
        return Err(KiraError::PatchParseFailed);
    }

    let mut files: Vec<FileDiff> = Vec::new();
    let mut truncated = false;
    // 顯示預算跟 commit diff 同一套；PR 的文字已經整份收下（≤ 1MB），這裡省的是前端渲染
    let mut budget = DiffBudget::default();

    let chunks = split_file_diffs(text);
    for chunk in chunks {
        if files.len() >= MAX_FILES_PER_DIFF {
            truncated = true;
            break;
        }
        match parse_single_file(chunk) {
            Some(mut file) => {
                file.omitted = budget.admit(hunks_cost(&file.hunks));
                if file.omitted.is_some() {
                    file.hunks = Vec::new();
                }
                files.push(file);
            }
            None => return Err(KiraError::PatchParseFailed),
        }
    }

    Ok(DiffResult { files, truncated })
}

fn split_file_diffs(text: &str) -> Vec<&str> {
    const MARKER: &str = "\ndiff --git ";
    let mut chunks = Vec::new();
    // Find the first "diff --git " — it may be at byte 0 (no preceding newline).
    let Some(first) = text.find("diff --git ") else {
        return chunks;
    };
    let mut start = first;
    // Subsequent markers must follow a newline.
    let mut search_from = start + 1;
    while let Some(rel) = text[search_from..].find(MARKER) {
        let split_at = search_from + rel + 1; // +1 to skip the leading '\n'
        chunks.push(&text[start..split_at]);
        start = split_at;
        search_from = split_at + 1;
    }
    chunks.push(&text[start..]);
    chunks
}

fn parse_single_file(chunk: &str) -> Option<FileDiff> {
    let lines: Vec<&str> = chunk.lines().collect();
    if lines.is_empty() || !lines[0].starts_with("diff --git ") {
        return None;
    }

    let mut path = parse_path_from_diff_header(lines[0])?;
    let mut status = FileStatusKind::Modified;
    let mut binary = false;
    let mut hunks = Vec::new();
    let mut i = 1;

    while i < lines.len() {
        let line = lines[i];
        if line.starts_with("new file mode") {
            status = FileStatusKind::Added;
        } else if line.starts_with("deleted file mode") {
            status = FileStatusKind::Deleted;
        } else if line.starts_with("rename to ") {
            status = FileStatusKind::Renamed;
            path = line.strip_prefix("rename to ")?.to_string();
        } else if line.starts_with("Binary files ") && line.ends_with(" differ") {
            binary = true;
        } else if line.starts_with("@@ ") {
            break;
        }
        i += 1;
    }

    while i < lines.len() {
        if lines[i].starts_with("@@ ") {
            let (hunk, consumed) = parse_hunk(&lines[i..])?;
            hunks.push(hunk);
            i += consumed;
        } else {
            i += 1;
        }
    }

    Some(FileDiff {
        path,
        status,
        hunks,
        binary,
        too_large: false,
        omitted: None,
    })
}

fn parse_path_from_diff_header(header: &str) -> Option<String> {
    // "diff --git a/path/to/file b/path/to/file"
    let rest = header.strip_prefix("diff --git ")?;
    let b_idx = rest.find(" b/")?;
    let b_path = &rest[b_idx + 3..];
    Some(b_path.to_string())
}

fn parse_hunk(lines: &[&str]) -> Option<(Hunk, usize)> {
    let header = lines.first()?;
    let (old_start, old_lines, new_start, new_lines, tail) = parse_hunk_header(header)?;

    let mut diff_lines = Vec::new();
    let mut old_lineno = old_start;
    let mut new_lineno = new_start;
    let mut consumed = 1;

    for &line in lines.iter().skip(1) {
        if line.starts_with("@@ ") || line.starts_with("diff --git ") {
            break;
        }
        consumed += 1;
        if let Some(rest) = line.strip_prefix('+') {
            diff_lines.push(DiffLine {
                origin: '+',
                content: rest.to_string(),
                old_lineno: None,
                new_lineno: Some(new_lineno),
            });
            new_lineno += 1;
        } else if let Some(rest) = line.strip_prefix('-') {
            diff_lines.push(DiffLine {
                origin: '-',
                content: rest.to_string(),
                old_lineno: Some(old_lineno),
                new_lineno: None,
            });
            old_lineno += 1;
        } else if line.is_empty() || line.starts_with(' ') {
            let content = if let Some(rest) = line.strip_prefix(' ') {
                rest.to_string()
            } else {
                String::new()
            };
            diff_lines.push(DiffLine {
                origin: ' ',
                content,
                old_lineno: Some(old_lineno),
                new_lineno: Some(new_lineno),
            });
            old_lineno += 1;
            new_lineno += 1;
        } else if line.starts_with('\\') {
            // "\ No newline at end of file" — skip
        }
    }

    Some((
        Hunk {
            old_start,
            old_lines,
            new_start,
            new_lines,
            context: hunk_context(tail.as_bytes()),
            lines: diff_lines,
        },
        consumed,
    ))
}

/// "@@ -old_start,old_lines +new_start,new_lines @@ 函式名"：範圍與收尾 `@@` 之後那段（GitHub 的 patch 跟 git 一樣帶函式名）
fn parse_hunk_header(header: &str) -> Option<(u32, u32, u32, u32, &str)> {
    let at_stripped = header.strip_prefix("@@ ")?;
    let end = at_stripped.find(" @@")?;
    let range_str = &at_stripped[..end];

    let mut parts = range_str.split(' ');
    let old_range = parts.next()?.strip_prefix('-')?;
    let new_range = parts.next()?.strip_prefix('+')?;

    let (old_start, old_lines) = parse_range(old_range);
    let (new_start, new_lines) = parse_range(new_range);
    Some((
        old_start,
        old_lines,
        new_start,
        new_lines,
        &at_stripped[end + 3..],
    ))
}

fn parse_range(range: &str) -> (u32, u32) {
    if let Some((start, lines)) = range.split_once(',') {
        (start.parse().unwrap_or(1), lines.parse().unwrap_or(0))
    } else {
        (range.parse().unwrap_or(1), 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE_DIFF: &str = "\
diff --git a/hello.txt b/hello.txt
index abc1234..def5678 100644
--- a/hello.txt
+++ b/hello.txt
@@ -1,3 +1,4 @@
 line1
-line2
+line2a
+line2b
 line3
";

    #[test]
    fn test_parse_simple_modified_file() {
        let result = parse_unified_diff(SIMPLE_DIFF).unwrap();
        assert_eq!(result.files.len(), 1);
        let f = &result.files[0];
        assert_eq!(f.path, "hello.txt");
        assert_eq!(f.status, FileStatusKind::Modified);
        assert!(!f.binary);
        assert!(!f.too_large);
        assert_eq!(f.hunks.len(), 1);
        let h = &f.hunks[0];
        assert_eq!(h.old_start, 1);
        assert_eq!(h.old_lines, 3);
        assert_eq!(h.new_start, 1);
        assert_eq!(h.new_lines, 4);
        assert_eq!(h.lines.len(), 5);
    }

    #[test]
    fn test_parse_added_file() {
        let diff = "\
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
";
        let result = parse_unified_diff(diff).unwrap();
        assert_eq!(result.files[0].status, FileStatusKind::Added);
        assert_eq!(result.files[0].hunks[0].lines.len(), 2);
    }

    #[test]
    fn test_parse_deleted_file() {
        let diff = "\
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index abc1234..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-hello
-world
";
        let result = parse_unified_diff(diff).unwrap();
        assert_eq!(result.files[0].status, FileStatusKind::Deleted);
    }

    #[test]
    fn test_parse_renamed_file() {
        let diff = "\
diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
";
        let result = parse_unified_diff(diff).unwrap();
        assert_eq!(result.files[0].status, FileStatusKind::Renamed);
        assert_eq!(result.files[0].path, "new.txt");
    }

    #[test]
    fn test_parse_binary_file() {
        let diff = "\
diff --git a/image.png b/image.png
new file mode 100644
index 0000000..abc1234
Binary files /dev/null and b/image.png differ
";
        let result = parse_unified_diff(diff).unwrap();
        assert!(result.files[0].binary);
        assert!(result.files[0].hunks.is_empty());
    }

    #[test]
    fn test_parse_multiple_files() {
        let diff = "\
diff --git a/a.txt b/a.txt
index abc..def 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
diff --git a/b.txt b/b.txt
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/b.txt
@@ -0,0 +1 @@
+added
";
        let result = parse_unified_diff(diff).unwrap();
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.files[0].path, "a.txt");
        assert_eq!(result.files[1].path, "b.txt");
    }

    #[test]
    fn test_parse_empty_diff() {
        let result = parse_unified_diff("").unwrap();
        assert!(result.files.is_empty());
        assert!(!result.truncated);
    }

    #[test]
    fn test_parse_non_diff_body_returns_error() {
        let body = r#"{"message": "Not Found"}"#;
        assert!(parse_unified_diff(body).is_err());
    }

    /// 解析這一道跟下載那道（`pr::fetch_pr_diff_at`）同一個上限、同一個碼：太大，再試也拿不到（Phase 5c）
    #[test]
    fn test_parse_too_large_diff_returns_error() {
        let big = "x".repeat(MAX_DIFF_TEXT_SIZE + 1);
        assert_eq!(
            parse_unified_diff(&big).unwrap_err().code(),
            "PR_DIFF_TOO_LARGE"
        );
    }

    #[test]
    fn test_parse_hunk_line_numbers() {
        let result = parse_unified_diff(SIMPLE_DIFF).unwrap();
        let lines = &result.files[0].hunks[0].lines;
        // " line1" → context
        assert_eq!(lines[0].origin, ' ');
        assert_eq!(lines[0].old_lineno, Some(1));
        assert_eq!(lines[0].new_lineno, Some(1));
        // "-line2" → removed
        assert_eq!(lines[1].origin, '-');
        assert_eq!(lines[1].old_lineno, Some(2));
        assert!(lines[1].new_lineno.is_none());
        // "+line2a" → added
        assert_eq!(lines[2].origin, '+');
        assert!(lines[2].old_lineno.is_none());
        assert_eq!(lines[2].new_lineno, Some(2));
        // "+line2b" → added
        assert_eq!(lines[3].origin, '+');
        assert_eq!(lines[3].new_lineno, Some(3));
    }

    #[test]
    fn test_parse_no_newline_marker_skipped() {
        let diff = "\
diff --git a/f.txt b/f.txt
index abc..def 100644
--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
";
        let result = parse_unified_diff(diff).unwrap();
        let lines = &result.files[0].hunks[0].lines;
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].content, "old");
        assert_eq!(lines[1].content, "new");
    }

    #[test]
    fn test_parse_multiple_hunks() {
        let diff = "\
diff --git a/f.txt b/f.txt
index abc..def 100644
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
-a
+A
 b
@@ -10,2 +10,2 @@
-c
+C
 d
";
        let result = parse_unified_diff(diff).unwrap();
        assert_eq!(result.files[0].hunks.len(), 2);
        assert_eq!(result.files[0].hunks[0].old_start, 1);
        assert_eq!(result.files[0].hunks[1].old_start, 10);
    }

    // ---- hunk 標頭的函式名（Phase 5 B2）：跟 git 路徑同一套清理 ----

    #[test]
    fn test_parse_hunk_context() {
        let diff = "\
diff --git a/a.rs b/a.rs
index abc..def 100644
--- a/a.rs
+++ b/a.rs
@@ -1 +1 @@
-use a;
+use b;
@@ -10,2 +10,2 @@ fn alpha() {
-    let c = 3;
+    let c = 30;
     let d = 4;
";
        let hunks = &parse_unified_diff(diff).unwrap().files[0].hunks;
        assert_eq!(hunks[0].context, "");
        assert_eq!(hunks[1].context, "fn alpha() {");
    }

    #[test]
    fn test_parse_hunk_context_is_cleaned_like_the_git_path() {
        // GitHub 的 patch 不截函式名（V4：88 行裡 4 行超過 100 字元）：最多 80 字元，控制字元換成空白
        let name = format!("fn \x1b[1m{}() {{", "字".repeat(100));
        let diff = format!(
            "diff --git a/a.rs b/a.rs\nindex abc..def 100644\n--- a/a.rs\n+++ b/a.rs\n@@ -10 +10 @@ {name}\n-x\n+y\n"
        );
        let ctx = &parse_unified_diff(&diff).unwrap().files[0].hunks[0].context;
        // "fn " + ESC（換成空白）+ "[1m" 是 7 個字元，剩 73 個字
        assert_eq!(*ctx, format!("fn  [1m{}", "字".repeat(73)));
    }

    // ---- 顯示預算：跟 commit diff 同一套（git/diff.rs 有兩條路徑一致的測試） ----

    use crate::git::diff::{OmitReason, Omitted, MAX_FILE_DIFF_LINES, MAX_TOTAL_DIFF_LINES};

    /// 新增檔的 unified diff：n 行、每行 `width` 個字元
    fn added_file(path: &str, n: usize, width: usize) -> String {
        added_file_of(path, n, &"x".repeat(width))
    }

    /// 新增檔的 unified diff：n 行、每行都是 `line`
    fn added_file_of(path: &str, n: usize, line: &str) -> String {
        let header = format!(
            "diff --git a/{path} b/{path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{n} @@\n"
        );
        header + &format!("+{line}\n").repeat(n)
    }

    #[test]
    fn test_parse_counts_characters_not_utf8_bytes() {
        // 10 萬個中文字（約 300KB）在單檔字元上限內，整份送出（同 commit diff）
        let result =
            parse_unified_diff(&added_file_of("chapter.md", 100, &"字".repeat(1_000))).unwrap();
        let f = &result.files[0];
        assert_eq!(f.omitted, None);
        assert_eq!(f.hunks[0].lines.len(), 100);
    }

    #[test]
    fn test_parse_file_over_line_cap_is_omitted_with_its_size() {
        let n = MAX_FILE_DIFF_LINES + 1;
        let result = parse_unified_diff(&added_file("a.txt", n, 3)).unwrap();
        let f = &result.files[0];
        let expected = Omitted {
            reason: OmitReason::File,
            lines: n,
            bytes: n * 4,
        };
        assert_eq!(f.omitted, Some(expected));
        assert!(f.hunks.is_empty(), "an omitted file must not carry hunks");
    }

    #[test]
    fn test_parse_total_cap_skips_the_overflowing_file_but_sends_later_files_that_fit() {
        let full = MAX_FILE_DIFF_LINES;
        let rest = MAX_TOTAL_DIFF_LINES - 2 * full;
        let text = [
            added_file("a.lock", full, 3),
            added_file("b.lock", full, 3),
            added_file("c.ts", rest + 1, 3),
            added_file("d.ts", rest, 3),
        ]
        .concat();
        let result = parse_unified_diff(&text).unwrap();
        let reasons: Vec<_> = result
            .files
            .iter()
            .map(|f| f.omitted.as_ref().map(|o| o.reason))
            .collect();
        assert_eq!(reasons, [None, None, Some(OmitReason::Total), None]);
        assert!(result.files[2].hunks.is_empty());
        assert_eq!(result.files[3].hunks[0].lines.len(), rest);
    }
}
