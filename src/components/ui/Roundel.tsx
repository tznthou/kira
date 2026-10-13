import type { CSSProperties } from "react";
import type { LineColor } from "@/lib/routeMap";

/**
 * 路線的字母圓標（v8 `.rd`，基準 `roundel()`）：remote 空心；寄宿（沒有自己的線）空心無字，`--l` 是它停靠
 * 那條線的色；tip 不在載入的視窗內 = 虛線圈、不上色（決策 C）。只是裝飾，名字由旁邊的文字講
 */
export function Roundel({
  color,
  letter,
  hollow = false,
  lodge = false,
  beyond = false,
}: {
  color: LineColor;
  letter: string;
  hollow?: boolean;
  lodge?: boolean;
  beyond?: boolean;
}) {
  if (beyond) {
    return (
      <span className="rd beyond" aria-hidden="true">
        <svg viewBox="0 0 18 18">
          <circle cx="9" cy="9" r="8.25" />
        </svg>
      </span>
    );
  }
  const style = { "--l": `var(--l-${color})` } as CSSProperties;
  return (
    <span className={`rd${hollow ? " hollow" : ""}${lodge ? " lodge" : ""}`} style={style} aria-hidden="true">
      {lodge ? "" : letter}
    </span>
  );
}

/** 路線圖還沒回來時圓標的位置（Phase 5 Q-L，基準 `SK_ROUNDEL`）：骨架圓點，同 `.rd` 尺寸 */
export function RoundelSkeleton() {
  return (
    <span className="sk sk-rd" aria-hidden="true">
      <i />
    </span>
  );
}
