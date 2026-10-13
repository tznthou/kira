import { describe, expect, it } from "vitest";
import { branchOpNotice } from "@/components/BranchList/branchOpNotice";

// 分支操作失敗的文案 = 0b P5 規格 §3 的表（粗體結論 + 一句下一步）；表外的碼、或碼對不上操作，只寫結論
describe("branchOpNotice", () => {
  it.each([
    ["checkout", "DIRTY_TREE", "Checkout failed.", "Commit or stash first."],
    ["checkout", "REPOSITORY_NOT_CLEAN", "Checkout failed.", "Finish the merge first."],
    ["checkout", "BRANCH_NOT_FOUND", "Checkout failed.", "Branch not found."],
    ["delete", "BRANCH_UNMERGED", "Delete failed.", "It has unmerged commits."],
    ["delete", "CANNOT_DELETE_CURRENT", "Delete failed.", "Switch branches first."],
    ["create", "BRANCH_EXISTS", "Create failed.", "Name already taken."],
    ["create", "BRANCH_NAME_CONFLICT_CASE", "Create failed.", "Name already taken."],
    ["create", "INVALID_BRANCH_NAME", "Create failed.", "Invalid name."],
    ["create", "UNBORN_HEAD", "Create failed.", "Commit something first."],
  ] as const)("test_branchOpNotice_%s_%s_matchesTheSpec", (op, code, title, detail) => {
    expect(branchOpNotice(op, { code, message: "x" })).toEqual({ title, detail });
  });

  it("test_branchOpNotice_otherCodesOrNoCode_giveTheVerdictAlone", () => {
    expect(branchOpNotice("checkout", { code: "GIT_ERROR", message: "git operation failed" })).toEqual({
      title: "Checkout failed.",
    });
    // 刪除時分支不見了：規格表只給 checkout 這一句，刪除照「其他」只寫結論
    expect(branchOpNotice("delete", { code: "BRANCH_NOT_FOUND" })).toEqual({ title: "Delete failed." });
    expect(branchOpNotice("create", new Error("boom"))).toEqual({ title: "Create failed." });
    expect(branchOpNotice("create", null)).toEqual({ title: "Create failed." });
  });
});
