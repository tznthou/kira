import { describe, it, expect } from "vitest";
import { transportErrorNotice } from "@/lib/tauri";

// v8 0b §3 的文案表：粗體結論 + 一句下一步；Publish 時把 Push 換成 Publish
describe("transportErrorNotice", () => {
  const n = (verb: "Push" | "Publish" | "Pull", code: unknown) => transportErrorNotice(verb, code);

  it("test_transportErrorNotice_followsTheCopyTable", () => {
    expect(n("Push", { code: "AUTH_FAILED" })).toEqual({ title: "Push failed.", detail: "Authentication required." });
    expect(n("Pull", { code: "NETWORK_ERROR" })).toEqual({ title: "Pull failed.", detail: "Network error." });
    expect(n("Push", { code: "REJECTED" })).toEqual({ title: "Push rejected.", detail: "Pull first." });
    expect(n("Pull", { code: "CONFLICT" })).toEqual({ title: "Can't fast-forward.", detail: "Merge manually." });
    expect(n("Pull", { code: "REPOSITORY_NOT_CLEAN" })).toEqual({
      title: "Pull failed.",
      detail: "Commit your changes first.",
    });
    expect(n("Push", { code: "INVALID_REMOTE" })).toEqual({ title: "Push failed.", detail: "Remote not found." });
    expect(n("Push", { code: "INVALID_BRANCH_NAME" })).toEqual({
      title: "Push failed.",
      detail: "Branch name not allowed.",
    });
  });

  it("test_transportErrorNotice_publishSaysPublish", () => {
    expect(n("Publish", { code: "AUTH_FAILED" })).toEqual({ title: "Publish failed.", detail: "Authentication required." });
    expect(n("Publish", { code: "REJECTED" })).toEqual({ title: "Publish rejected.", detail: "Pull first." });
  });

  // 不認得的錯誤只說結論，不猜原因
  it("test_transportErrorNotice_unknownErrorsSayTheVerdictOnly", () => {
    expect(n("Push", { code: "GIT_ERROR" })).toEqual({ title: "Push failed.", detail: "" });
    expect(n("Pull", new Error("boom"))).toEqual({ title: "Pull failed.", detail: "" });
    expect(n("Push", null)).toEqual({ title: "Push failed.", detail: "" });
    expect(n("Push", undefined)).toEqual({ title: "Push failed.", detail: "" });
  });
});
