/**
 * 收合的檔在終端機怎麼看（0b P5 Q3：收合的檔不能原地展開，格內給這行指令；照搬基準 `showCommand()`，
 * 規則與實測在 `.claude/pi-plans/v8-0b-panel-states.md` §3.1，git 2.55）：
 * - 跟 Kira 算 diff 一樣對第一個 parent：merge 加 `-m --first-parent`（直接 `git show` 對一邊原樣帶進來的檔
 *   一行都不印）；根 commit 與一個 parent 的照常
 * - oid 取 12 碼：7 碼在 kernel 那麼大的 repo 會 ambiguous
 * - 路徑只有英數與 `. _ / -` 照寫，其他整段單引號（POSIX sh、bash、zsh 都適用，`'` 寫成 `'\''`；`=` `~` 開頭
 *   在 zsh 會展開，所以不在照寫的那組裡）；git 會當成 pathspec 萬用字元或 magic 的（含 `* ? [ \`、`:` 開頭）
 *   加 `:(literal)`——引號只擋得住 shell，`app/[id]` 在 git 那邊會比對到 `app/i` 與 `app/d`
 * - 含控制字元或雙向控制字元的路徑不給指令（null）：前者貼進終端機會斷行；後者照原樣顯示，指令會讀成別的檔，
 *   換成看得見的標記又不能貼（Phase 5 Q-T2）
 */
export function showCommand(oid: string, parentCount: number, path: string): string | null {
  // eslint-disable-next-line no-control-regex -- 找的就是控制字元（與雙向控制字元）
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/.test(path)) return null;
  const spec = /[*?[\\]/.test(path) || path.startsWith(":") ? `:(literal)${path}` : path;
  const arg = /^[A-Za-z0-9._/-]+$/.test(spec) ? spec : `'${spec.replace(/'/g, "'\\''")}'`;
  return `git show ${parentCount > 1 ? "-m --first-parent " : ""}${oid.slice(0, 12)} -- ${arg}`;
}
