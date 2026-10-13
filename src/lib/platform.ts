// macOS 才有紅綠燈與 Overlay 標題列。平台用 UA 判斷（不引 plugin-os）。
// index.html 的首繪 inline script 用同一條規則（那裡不能 import）：改這裡要一起改，
// themeFirstPaint.test.ts 拿兩邊對同一組 UA 比對
export const MAC_UA = /Macintosh|Mac OS X/;

export function isMacOS(): boolean {
  return MAC_UA.test(navigator.userAgent);
}
