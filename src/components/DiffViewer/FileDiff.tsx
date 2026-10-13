import { memo, useMemo } from "react";
import type { DiffFile, DiffFileStatusType, DiffHunk, DiffLine } from "@/lib/tauri";
import { formatBytes } from "@/lib/cloneProgress";
import { showCommand } from "@/lib/showCommand";
import { escCode, highlight, langOf, type Lang } from "@/lib/v8-highlight";

/** 收合的檔給的指令要知道是哪個 commit：完整 oid 與 parent 數。PR 的檔不在本機，沒有指令（null） */
export interface ShowAt {
  oid: string;
  parentCount: number;
}

const LETTER: Record<DiffFileStatusType, string> = { Added: "A", Modified: "M", Deleted: "D", Renamed: "R" };

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/** 檔頭的路徑：目錄淡色、檔名照常，雙向控制字元換成看得見的標記（Phase 5 Q-T）。照基準 pathHTML() */
function pathHTML(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? escCode(path) : `<span class="dir">${escCode(path.slice(0, i + 1))}</span>${escCode(path.slice(i + 1))}`;
}

/** hunk 標頭：行數照後端（git 的數字），`@@` 後面接 libgit2 往上找到的函式名（B2，後端已清理） */
const hunkHead = (h: DiffHunk) =>
  `@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@${h.context ? ` ${h.context}` : ""}`;

/** libgit2 的「\ No newline at end of file」：origin `=` `>` `<`（context / 新增 / 刪除那一側沒有換行） */
const NO_NEWLINE = new Set(["=", ">", "<"]);

/**
 * 一個 hunk 的行，整段組成一個 HTML 字串交給 innerHTML（跟基準 fileHTML() 同一份 DOM，一個 hunk 一個 React 節點）。
 * 行號照後端，沒有就空白；內容經過 highlight（跳脫 + 雙向字元標記）。git 的「\ No newline at end of file」是上一行的
 * 註記、不是哪一側的行（Phase 5 Q-N）：淡色、不帶行號與標記、不上色，文字去掉 libgit2 放在開頭的換行
 */
function linesHTML(lines: DiffLine[], lang: Lang | null): string {
  return lines
    .map((l) => {
      if (NO_NEWLINE.has(l.origin)) {
        return `<div class="dl eof"><span class="ln"></span><span class="ln"></span><span class="og"></span><code>${escCode(l.content.replace(/^\n/, ""))}</code></div>`;
      }
      const [cls, mark] = l.origin === "+" ? ["add", "+"] : l.origin === "-" ? ["del", "−"] : ["ctx", ""];
      return `<div class="dl ${cls}"><span class="ln">${l.old_lineno ?? ""}</span><span class="ln">${l.new_lineno ?? ""}</span><span class="og">${mark}</span><code>${highlight(l.content, lang)}</code></div>`;
    })
    .join("");
}

function Hunk({ hunk, lang }: { hunk: DiffHunk; lang: Lang | null }) {
  // 一個 hunk 的 HTML 算一次就好：hunk 物件來自同一份 state、身分穩定；App 重畫（切 tab、對話框、refresh）不該
  // 把整個 diff 重新上色（審查：每行 146µs，上限內的 diff 一次要幾百 ms）
  const head = useMemo(() => escCode(hunkHead(hunk)), [hunk]);
  const body = useMemo(() => linesHTML(hunk.lines, lang), [hunk, lang]);
  return (
    <>
      <div className="hunk-head" dangerouslySetInnerHTML={{ __html: head }} />
      <div className="hunk-body">
        <div className="hunk-inner" dangerouslySetInnerHTML={{ __html: body }} />
      </div>
    </>
  );
}

/** 檔的內容，依序：超過 10 MB → 二進位 → 收合（B1）→ 沒有文字變更 → hunks */
function FileBody({ file, at }: { file: DiffFile; at: ShowAt | null }) {
  if (file.too_large) {
    return (
      <div className="dcell warn">
        <b>Over 10 MB.</b> Diff skipped.
      </div>
    );
  }
  if (file.binary) return <div className="dcell">Binary file</div>;
  if (file.omitted) {
    // 被顯示上限收合：自己就太大，或前面的檔把上限用完了。不能原地展開（0b P5 Q3），本機 commit 給一行指令。
    // 改名的檔不給：pathspec 只有新路徑時 git 配不出 rename，`git show … -- <新路徑>` 印的是整檔新增（審查實跑；
    // 正解是帶 old path，記已知後續）。基準 fileHTML() 同規則
    const { reason, lines, bytes } = file.omitted;
    const cmd = at && file.status !== "Renamed" ? showCommand(at.oid, at.parentCount, file.path) : null;
    return (
      <div className="dcell warn">
        <div>
          {reason === "File" ? (
            <b>Too large to show.</b>
          ) : (
            <>
              <b>Not shown.</b> The files before it used up the display limit.
            </>
          )}{" "}
          <span className="size">{`${plural(lines, "line")} · ${formatBytes(bytes)}`}</span>
        </div>
        {cmd && (
          <div className="how">
            In a terminal: <code>{cmd}</code>
          </div>
        )}
      </div>
    );
  }
  if (file.hunks.length === 0) return <div className="dcell">No text changes</div>;
  const lang = langOf(file.path);
  return (
    <>
      {file.hunks.map((hunk, i) => (
        <Hunk key={i} hunk={hunk} lang={lang} />
      ))}
    </>
  );
}

/**
 * diff 裡的一個檔（v8 基準 fileHTML()，Phase 5 5b）：檔頭（狀態字母 + 路徑）+ 內容。commit 的 diff 與 PR 展開
 * 共用；`at` 是 commit 的 oid 與 parent 數，給收合的檔那行指令，PR 的檔傳 null。memo：props 沒變就不重畫
 * （呼叫端的 `at` 要是同一個物件）
 */
export const FileDiff = memo(function FileDiff({ file, at }: { file: DiffFile; at: ShowAt | null }) {
  const letter = LETTER[file.status];
  return (
    <article className="dfile">
      <header className="dfile-head">
        <span className={`badge ${letter}`} title={file.status}>
          {letter}
        </span>
        <span className="dpath" dangerouslySetInnerHTML={{ __html: pathHTML(file.path) }} />
      </header>
      <FileBody file={file} at={at} />
    </article>
  );
});
