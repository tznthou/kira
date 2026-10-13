import { describe, it, expect } from "vitest";
import { repoName, tildePath } from "@/lib/displayPath";

describe("displayPath", () => {
  it("test_repoName_isTheLastSegment", () => {
    expect(repoName("/Users/kira/Documents/kira")).toBe("kira");
    expect(repoName("/Users/kira/Documents/kira/")).toBe("kira");
    expect(repoName("C:\\work\\repo")).toBe("repo");
  });

  it("test_tildePath_abbreviatesUnderHome", () => {
    expect(tildePath("/Users/kira/Documents/kira", "/Users/kira")).toBe("~/Documents/kira");
    expect(tildePath("/Users/kira", "/Users/kira")).toBe("~");
    expect(tildePath("/Users/kira/Documents/kira", "/Users/kira/")).toBe("~/Documents/kira");
  });

  it("test_tildePath_leavesOtherPathsWhole", () => {
    // 前綴相同但不是同一個目錄
    expect(tildePath("/Users/kira2/repo", "/Users/kira")).toBe("/Users/kira2/repo");
    expect(tildePath("/opt/repo", "/Users/kira")).toBe("/opt/repo");
    // 查不到家目錄：照完整路徑
    expect(tildePath("/Users/kira/repo", null)).toBe("/Users/kira/repo");
    // 家目錄是根目錄時不縮（否則每個路徑都變成 ~）
    expect(tildePath("/repo", "/")).toBe("/repo");
  });
});
