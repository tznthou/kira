import { describe, it, expect, afterEach } from "vitest";
import { focusBack } from "@/lib/focusBack";

// 站牌提示 × 之後的焦點（Phase 5 5a step 4）：看得見就給它、藏在分頁裡退回那個 tab、都不行就不動。
// jsdom 會讓藏起來的按鈕照樣拿到焦點，所以「退回 tab」與直接 focus() 分得出來
describe("focusBack", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const setup = () => {
    document.body.innerHTML = `
      <button id="outside">outside</button>
      <div role="tablist">
        <button role="tab" id="tab-changes" aria-controls="panel-changes">Changes</button>
        <button role="tab" id="tab-prs" aria-controls="panel-prs">Pull Requests</button>
      </div>
      <div role="tabpanel" id="panel-changes"><button id="stage-all">Stage all</button></div>
      <div role="tabpanel" id="panel-prs" hidden><button id="prs-retry">Retry</button></div>
      <div hidden><button id="orphan">orphan</button></div>`;
    document.getElementById("outside")!.focus();
  };
  const byId = (id: string) => document.getElementById(id);

  it("test_focusBack_visibleElement_getsFocus", () => {
    setup();
    focusBack(byId("stage-all"));
    expect(document.activeElement?.id).toBe("stage-all");
  });

  it("test_focusBack_elementInAHiddenTab_fallsBackToItsTab", () => {
    setup();
    focusBack(byId("prs-retry"));
    expect(document.activeElement?.id).toBe("tab-prs");
  });

  it("test_focusBack_hiddenWithoutATab_leavesFocusAlone", () => {
    setup();
    focusBack(byId("orphan"));
    expect(document.activeElement?.id).toBe("outside");
  });

  it("test_focusBack_goneOrNull_leavesFocusAlone", () => {
    setup();
    const gone = byId("stage-all")!;
    gone.remove();
    focusBack(gone);
    focusBack(null);
    expect(document.activeElement?.id).toBe("outside");
  });
});
