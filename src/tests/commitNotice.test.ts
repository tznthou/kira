import { describe, it, expect } from "vitest";
import { commitNotice } from "@/lib/tauri";

// commit 失敗的站牌文案（0b P5 規格 §3）：GIT_IDENTITY_MISSING 多一句下一步，其他只有結論
describe("commitNotice", () => {
  it("test_commitNotice_identityMissing_saysToSetNameAndEmail", () => {
    expect(commitNotice({ code: "GIT_IDENTITY_MISSING" })).toEqual({
      title: "Commit failed.",
      detail: "Set your git name and email.",
    });
  });

  it("test_commitNotice_otherCodes_verdictOnly", () => {
    expect(commitNotice({ code: "GIT_ERROR" })).toEqual({ title: "Commit failed.", detail: "" });
    expect(commitNotice(null)).toEqual({ title: "Commit failed.", detail: "" });
    expect(commitNotice(undefined)).toEqual({ title: "Commit failed.", detail: "" });
  });
});
