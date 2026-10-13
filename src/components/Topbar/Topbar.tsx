import type { CSSProperties, ReactNode } from "react";
import { useRepoStore } from "@/stores/repoStore";
import { useNoticeStore } from "@/stores/noticeStore";
import { useHomeDir } from "@/hooks/useHomeDir";
import type { HeadInfo } from "@/lib/tauri";
import { repoName, tildePath } from "@/lib/displayPath";
import { focusBack } from "@/lib/focusBack";
import type { RouteMap } from "@/lib/routeMap";

// v8 基準的站牌（.topbar）：品牌、站名與路徑、你在哪條線、失敗提示、工具列、你的線。
// DOM 與 class、id 照基準（v8.css 用 #push / #refresh / #theme 定寬與鏡像）；工具列內容由 App 組。
interface TopbarProps {
  /** 與 head 同一份 graphData 算出的路線；null = 載入中或算不出來 */
  routes: RouteMap | null;
  head: HeadInfo | null;
  children: ReactNode;
}

export function Topbar({ routes, head, children }: TopbarProps) {
  const hasNotice = useNoticeStore((s) => s.notice !== null);
  // Overlay 標題列下整條站牌就是標題列：deep = 子樹裡非互動的地方都能拖視窗、雙擊 zoom
  // （按鈕等互動元素不拖；帳號選單自己設 false）
  return (
    <header className={hasNotice ? "topbar has-notice" : "topbar"} data-tauri-drag-region="deep">
      <div className="brand">
        <svg className="flake" aria-hidden="true">
          <use href="#flake" />
        </svg>
        Kira
      </div>
      <span className="vr" aria-hidden="true" />
      <Station />
      <YouAre routes={routes} head={head} />
      <NoticeSign />
      <div className="tools">{children}</div>
      <div className="your-line" aria-hidden="true">
        {/* 推送時沿線前進的小金箔屬 Phase 6，這裡先靜置（.run 才顯示） */}
        <svg className="carriage" id="carriage">
          <use href="#flake" />
        </svg>
      </div>
    </header>
  );
}

function Station() {
  const path = useRepoStore((s) => s.repoInfo?.path ?? null);
  const home = useHomeDir();
  if (path === null) return null;
  return (
    <div className="station">
      <span className="st-name">{repoName(path)}</span>
      <span className="st-path" title={path}>
        {home === undefined ? "" : tildePath(path, home)}
      </span>
    </div>
  );
}

// 「你在這裡」：路線算得出 HEAD 才畫。載入中（graphData 先清空）、讀不到 HEAD、detached 在視窗外、
// computeRoutes 丟錯 → 只留站名。unborn（HEAD 指向還沒有 commit 的分支）照樣寫分支，後面加
// 「No commits yet」。圓標顏色 = 強調色 = 你所在的線
function YouAre({ routes, head }: { routes: RouteMap | null; head: HeadInfo | null }) {
  if (!routes || !head || routes.head.letter === null) return null;
  const unborn = head.oid === null;
  if (unborn && head.branch === null) return null;
  const detached = head.branch === null;
  const short = head.oid?.slice(0, 7) ?? "";
  const line = { "--l": `var(--l-${routes.accent})` } as CSSProperties;
  const title = unborn
    ? `${head.branch} has no commits yet`
    : detached
      ? `HEAD is detached at ${short} — no branch is checked out`
      : "Current branch";
  return (
    <div className="youare" id="youare" title={title}>
      <span className="lbl" id="you-lbl">
        {detached ? "Detached at" : "You are on"}
      </span>
      <span className="rd lg" id="you-rd" style={line} aria-hidden="true">
        {routes.head.letter}
      </span>
      <span className={detached ? "bn mono" : "bn"} id="you-bn">
        {detached ? short : head.branch}
      </span>
      {unborn && (
        <span className="note" id="you-note">
          No commits yet
        </span>
      )}
    </div>
  );
}

// 失敗提示：佔站名與 youare 的位置（.has-notice），× 關掉後焦點回到出錯的元素（看不見就退回它的分頁）。
// key 跟著每次 show 換：同一句再出現也重播進場（.enter）
function NoticeSign() {
  const notice = useNoticeStore((s) => s.notice);
  const clear = useNoticeStore((s) => s.clear);
  const dismiss = () => {
    const from = notice?.from;
    clear();
    if (from) focusBack(typeof from === "function" ? from() : document.getElementById(from));
  };
  return (
    <div
      className="notice enter"
      id="notice"
      role="alert"
      key={notice?.seq ?? 0}
      title={notice ? (notice.detail ? `${notice.title} ${notice.detail}` : notice.title) : undefined}
    >
      <svg className="notice-mark" aria-hidden="true">
        <use href="#i-bad" />
      </svg>
      <span className="notice-text" id="notice-text">
        {notice && (
          <>
            <b>{notice.title}</b>
            {notice.detail ? ` ${notice.detail}` : null}
          </>
        )}
      </span>
      <button className="notice-x" id="notice-x" type="button" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
        <svg aria-hidden="true">
          <use href="#i-x" />
        </svg>
      </button>
    </div>
  );
}
