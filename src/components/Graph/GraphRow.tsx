import { memo } from "react";
import type { CommitNode } from "@/lib/tauri";
import type { RefLabel, RowRefs } from "@/lib/rowRefs";
import { Roundel } from "@/components/ui/Roundel";

/**
 * 進 DOM 的訊息最多幾個 UTF-16 單位。畫面上看得到的遠比這少（列尾省略號、站牌最多 4 行），上限只為了不讓 repo 裡的
 * 超長訊息整段進 DOM——每列三份（文字、aria-label、站牌），舊 graph 截在 50 字
 */
const SUBJECT_CAP = 1000;

/** commit 訊息的第一行，最多 SUBJECT_CAP 個單位、不切開代理對（後端 build_graph 已經只回第一行；這裡再切一次，資料帶多行時也只顯示第一行） */
export const subjectOf = (message: string) => {
  const line = message.split("\n", 1)[0];
  if (line.length <= SUBJECT_CAP) return line;
  const cut = line.slice(0, SUBJECT_CAP);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};

const MERGE_PR = /^Merge pull request (#\d+) from (\S+)$/;
const CONVENTIONAL = /^([a-z]+(?:\([^)]*\))?!?:)\s(.*)$/;

/** 訊息的兩種標記（基準 subjectHTML）：GitHub 的 merge PR（編號與來源分支）、conventional commit 的前綴 */
function Subject({ text }: { text: string }) {
  const merge = text.match(MERGE_PR);
  if (merge) {
    return (
      <>
        Merge pull request <span className="prn">{merge[1]}</span> from <span className="from">{merge[2]}</span>
      </>
    );
  }
  const cc = text.match(CONVENTIONAL);
  if (cc) {
    return (
      <>
        <span className="pfx">{cc[1]}</span>
        {" "}
        {cc[2]}
      </>
    );
  }
  return <>{text}</>;
}

/** 一個 ref 標籤（基準 refHTML）：截短或只寫遠端名時，title 是全名 */
function Ref({ r }: { r: RefLabel }) {
  const name = r.label === r.name ? <span>{r.label}</span> : <span title={r.name}>{r.label}</span>;
  if (r.color === null) {
    return (
      <span className="ref tag">
        <svg aria-hidden="true">
          <use href="#i-diamond" />
        </svg>
        {name}
      </span>
    );
  }
  return (
    <span className={`ref ${r.kind}`}>
      <Roundel color={r.color} letter={r.letter} hollow={r.hollow} lodge={r.lodge} />
      {name}
    </span>
  );
}

/** 一站一列（基準 renderRows）：listbox 的 option，roving tabindex 由 GraphPane 決定 */
export const GraphRow = memo(function GraphRow({
  commit,
  refs,
  selected,
  tabStop,
}: {
  commit: CommitNode;
  refs: RowRefs;
  selected: boolean;
  tabStop: boolean;
}) {
  const subject = subjectOf(commit.message);
  const spoken = refs.spoken.length > 0 ? `. Refs: ${refs.spoken.join(", ")}` : "";
  return (
    <div
      className={commit.parents.length > 1 ? "row merge" : "row"}
      role="option"
      data-oid={commit.full_oid}
      tabIndex={tabStop ? 0 : -1}
      aria-selected={selected}
      aria-label={`Commit ${commit.oid}: ${subject}${spoken}`}
    >
      <span className="hash">{commit.oid}</span>
      <span className="subject">
        <Subject text={subject} />
      </span>
      <span className="refs">
        {/* 本機分支可以叫 origin/main，與遠端同名：key 要帶種類 */}
        {refs.shown.map((r) => (
          <Ref key={`${r.kind} ${r.name}`} r={r} />
        ))}
        {refs.folded.length > 0 && (
          <span className="ref more" title={refs.folded.join("\n")}>
            +{refs.folded.length}
          </span>
        )}
      </span>
    </div>
  );
});
