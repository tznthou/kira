import type { NoticeInput } from "@/stores/noticeStore";

export type BranchOp = "checkout" | "delete" | "create";

const VERDICT: Record<BranchOp, string> = {
  checkout: "Checkout failed.",
  delete: "Delete failed.",
  create: "Create failed.",
};

// 錯誤碼 → 一句下一步（0b P5 規格 §3 的表；預算同殼層批：1200px、未登入的站牌放得下）。只有對得上操作
// 的碼才給，其他只寫結論（同殼層）
const NEXT: Record<BranchOp, Record<string, string>> = {
  checkout: {
    DIRTY_TREE: "Commit or stash first.",
    REPOSITORY_NOT_CLEAN: "Finish the merge first.",
    BRANCH_NOT_FOUND: "Branch not found.",
  },
  delete: {
    BRANCH_UNMERGED: "It has unmerged commits.",
    CANNOT_DELETE_CURRENT: "Switch branches first.",
  },
  create: {
    BRANCH_EXISTS: "Name already taken.",
    BRANCH_NAME_CONFLICT_CASE: "Name already taken.",
    INVALID_BRANCH_NAME: "Invalid name.",
    UNBORN_HEAD: "Commit something first.",
  },
};

/** 分支操作失敗的文案：粗體結論 + 一句下一步。checkout / 刪除進站牌提示，建立留在對話框裡（Phase 5 Q-C） */
export function branchOpNotice(op: BranchOp, err: unknown): Pick<NoticeInput, "title" | "detail"> {
  const code = (err as { code?: unknown } | null)?.code;
  const detail = typeof code === "string" ? NEXT[op][code] : undefined;
  return detail ? { title: VERDICT[op], detail } : { title: VERDICT[op] };
}
