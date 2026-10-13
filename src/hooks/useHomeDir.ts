import { useEffect, useState } from "react";
import { homeDir } from "@/lib/tauri";

/** 家目錄（站牌與側欄近期清單的 `~` 縮寫用，同一個來源）。undefined = 還在查：路徑先留空，免得完整路徑
 *  閃一下才縮成 ~；null = 查不到 */
export function useHomeDir(): string | null | undefined {
  const [home, setHome] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void homeDir().then((h) => {
      if (!cancelled) setHome(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return home;
}
