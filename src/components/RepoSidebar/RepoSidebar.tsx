import { useRecentReposStore } from "@/stores/recentReposStore";
import { BranchList } from "@/components/BranchList";
import { Button } from "@/components/ui/Button";
import { TitleBarDragStrip } from "@/components/ui/TitleBarDragStrip";
import { useHomeDir } from "@/hooks/useHomeDir";
import { repoName, tildePath } from "@/lib/displayPath";
import type { RouteMap } from "@/lib/routeMap";
import type { HeadInfo } from "@/lib/tauri";
import { RecentRepoItem } from "./RecentRepoItem";

// Dual-mode container：
// - "landing"  → no repo open；大標題 + Open + Clone + recent list
// - "panel"    → repo open；主畫面左側 sidebar，recent + BranchList + Open/Clone
//
// recent.length === 0 在 landing mode 自然 fallback（空 list 不渲染），不另開
// GuideScreen 元件。
//
// Clone button: landing + panel 兩 mode 都啟用
interface RepoSidebarProps {
  mode: "landing" | "panel";
  onPickAndOpen: () => void;
  onOpenRecent: (path: string) => void;
  onClickClone: () => void;
  busy?: boolean;
  error?: string | null;
  /** panel mode：分支圓標照路線圖（graph 還沒回來是 null，畫骨架圓點），HEAD 跟路線圖同一份 graph */
  routes?: RouteMap | null;
  head?: HeadInfo | null;
}

export function RepoSidebar({
  mode,
  onPickAndOpen,
  onOpenRecent,
  onClickClone,
  busy,
  error,
  routes,
  head,
}: RepoSidebarProps) {
  const recent = useRecentReposStore((s) => s.recent);
  // 同站牌的來源；首頁不用（RecentRepoItem 寫完整路徑），hook 照常呼叫
  const home = useHomeDir();

  if (mode === "landing") {
    // 疊到 App root 的雲母地（.ground：fixed、z-index 0、不透明）上面，底色交給它。
    // 不疊的話雲母地會蓋住整個首頁；它 pointer-events none，點擊照樣穿過，
    // 程式化的 click 與 vitest 都測不出來
    return (
      <div className="relative z-[1] h-screen overflow-hidden flex flex-col items-center text-app-fg">
        {/* Overlay 標題列下首頁沒有站牌，不給拖曳區視窗就拖不動：頂端一條同站牌高（60px）；
            內容從 96px 開始，不重疊。放在根節點內——它滿版又疊在上層，放外面會被蓋住 */}
        <TitleBarDragStrip />
        <div className="flex flex-col items-center gap-8 pt-24 pb-12 w-full max-w-2xl px-8">
          <h1 className="text-5xl font-light tracking-wide">Kira</h1>
          <div className="flex gap-3">
            <Button
              variant="primary"
              onClick={onPickAndOpen}
              disabled={busy}
              className="px-6 py-2"
            >
              {busy ? "Opening..." : "Open Repository"}
            </Button>
            <Button
              onClick={onClickClone}
              disabled={busy}
              className="px-6 py-2"
            >
              Clone Repository
            </Button>
          </div>
          {error && <div className="text-danger-fg text-sm">{error}</div>}
        </div>
        {recent.length > 0 && (
          <div className="flex-1 overflow-auto w-full max-w-2xl px-8 pb-12">
            <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3">
              Recent repositories
            </h2>
            <ul className="space-y-1">
              {recent.map((r) => (
                <li key={r.path}>
                  <RecentRepoItem
                    path={r.path}
                    lastOpened={r.last_opened}
                    onOpen={() => onOpenRecent(r.path)}
                    disabled={busy}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // panel mode（v8 基準的側欄，Phase 5 5a）：直接是 App 的 aside.sheet.sidebar 的子節點——近期清單、
  // 分支區、底部 Open / Clone。開 repo 進行中（bootLoading）近期清單與底部按鈕停用
  return (
    <>
      <section className="side-sec">
        <div className="sec-head">
          <h2 className="sec-title">Recent</h2>
          <span className="rule" />
        </div>
        <ul className="side-list">
          {recent.length > 0 ? (
            recent.map((r) => (
              <li key={r.path}>
                <SideRepoItem
                  path={r.path}
                  lastOpened={r.last_opened}
                  home={home}
                  onOpen={() => onOpenRecent(r.path)}
                  disabled={busy}
                />
              </li>
            ))
          ) : (
            <li className="empty-line">No recent repositories</li>
          )}
        </ul>
      </section>
      <section className="side-sec branches">
        <BranchList routes={routes ?? null} head={head ?? null} />
      </section>
      <footer className="side-foot">
        <button className="btn" type="button" onClick={onPickAndOpen} disabled={busy}>
          Open
        </button>
        <button className="btn" type="button" onClick={onClickClone} disabled={busy}>
          Clone
        </button>
      </footer>
    </>
  );
}

/** 側欄近期清單的一筆（基準 `.repo-item`）：名稱、`~` 縮寫的路徑、最後開啟的日期（本地時間 y/m/d 不補零）。
 *  完整路徑放 title。首頁那份（RecentRepoItem）照舊，P6 再換 */
function SideRepoItem({
  path,
  lastOpened,
  home,
  onOpen,
  disabled,
}: {
  path: string;
  lastOpened: number;
  home: string | null | undefined;
  onOpen: () => void;
  disabled?: boolean;
}) {
  const d = new Date(lastOpened * 1000);
  const date = isNaN(d.getTime()) ? "" : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  return (
    <button className="repo-item" type="button" title={path} onClick={onOpen} disabled={disabled}>
      <span className="ri-name">{repoName(path)}</span>
      <span className="ri-meta">
        <span className="ri-path">{home === undefined ? "" : tildePath(path, home)}</span>
        <span className="ri-date">{date}</span>
      </span>
    </button>
  );
}
