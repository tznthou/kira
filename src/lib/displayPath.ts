// 路徑的顯示形式（站牌的站名與路徑；基準：「kira」+「~/Documents/kira」，完整路徑放 title）

/** repo 名 = 路徑最後一段（站牌與近期清單共用） */
export function repoName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** 家目錄底下的路徑縮成 `~/…`；不知道家目錄（null）或不在底下就照完整路徑 */
export function tildePath(path: string, home: string | null): string {
  if (!home) return path;
  const base = home.replace(/\/+$/, "");
  if (base === "") return path;
  if (path === base) return "~";
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}
