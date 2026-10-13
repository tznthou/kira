import type { ReactNode } from "react";
import type { DiffFile } from "@/lib/tauri";

/** 「3 files」：千分位 + 單複數（基準 plural） */
export const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/** 區裡的警告條（基準 strip）：不能關，粗體結論 + 一句說明（0b P5 §2）。diff 區、PR 展開、Changes 區段共用 */
export function Strip({ title, detail }: { title: string; detail: ReactNode }) {
  return (
    <div className="strip">
      <svg aria-hidden="true">
        <use href="#i-warn" />
      </svg>
      <span>
        <b>{title}</b> {detail}
      </span>
    </div>
  );
}

/**
 * 檔案清單上面的條（基準 limitStrips）：後端只送前 500 個檔（E3；PR 走不到——GitHub 的 diff 超過 300 檔就回
 * 406）與被顯示上限收合的檔（E4，只數 File / Total，每個檔自己的格也會說）。whole：這些檔屬於什麼
 */
export function LimitStrips({ files, cut, whole }: { files: DiffFile[]; cut: boolean; whole: "commit" | "pull request" }) {
  const kept = files.filter((f) => f.omitted !== null);
  const big = kept.filter((f) => f.omitted?.reason === "File").length;
  const why = [big > 0 && `${big} too large`, kept.length - big > 0 && `${kept.length - big} over the display limit`]
    .filter((s) => s !== false)
    .join(", ");
  return (
    <>
      {cut && <Strip title={`Showing the first ${files.length} files.`} detail={`This ${whole} changes more.`} />}
      {kept.length > 0 && <Strip title={`${kept.length} of ${plural(files.length, "file")} not shown.`} detail={`${why}.`} />}
    </>
  );
}
