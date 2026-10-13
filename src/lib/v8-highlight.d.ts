/**
 * v8-highlight.js 的型別（手寫）。那個檔是基準 highlight 區塊的逐字副本（mockup/tools/sync_v8_css.py 產生、
 * 禁止手改），這裡只描述它 export 的三個函式；export 改了這裡要跟著改（v8Highlight.test.ts 比對 export 清單）
 */

/** 上色的語言，由副檔名決定；null = 不上色、照原樣顯示（Markdown、純文字、不認得的副檔名） */
export type Lang = "js" | "rs" | "json" | "css";

/** 檔案的行用哪個語言上色：看最後一個副檔名、不分大小寫；不上色回 null */
export function langOf(path: string): Lang | null;

/**
 * 一行程式碼 → HTML（給 innerHTML）：跳脫、雙向控制字元換成看得見的標記（Phase 5 Q-T）；lang 有值、
 * 這行不超過 2,000 字元才上色，JS / TS 的 JSX 文案照原樣（Q-H3）
 */
export function highlight(src: string, lang: Lang | null): string;

/** 程式碼（hunk 標頭、檔頭的路徑）→ HTML（給 innerHTML）：跳脫、雙向控制字元換成看得見的標記（Q-T） */
export function escCode(s: string): string;
