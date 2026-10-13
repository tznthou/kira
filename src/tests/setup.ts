// Vitest 全域測試環境設定
//
// jsdom 沒有 scrollIntoView：graph 換選取時把那列捲進視野。要斷言捲動的測試用
// vi.spyOn(Element.prototype, "scrollIntoView")
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// jsdom 也沒有 matchMedia；ThemeSwitcher 用它判斷減少動態。預設 matches: false（沒開減少動態），
// 個別測試要別的結果時用 vi.spyOn(window, "matchMedia") 覆寫。
if (typeof window !== "undefined" && typeof window.matchMedia === "undefined") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
