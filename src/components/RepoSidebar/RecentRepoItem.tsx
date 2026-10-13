import { repoName } from "@/lib/displayPath";

interface RecentRepoItemProps {
  path: string;
  lastOpened: number;
  onOpen: () => void;
  disabled?: boolean;
}

export function RecentRepoItem({
  path,
  lastOpened,
  onOpen,
  disabled,
}: RecentRepoItemProps) {
  const basename = repoName(path);
  const lastOpenedDate = new Date(lastOpened * 1000);
  const lastOpenedLabel = isNaN(lastOpenedDate.getTime())
    ? ""
    : lastOpenedDate.toLocaleDateString();

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      title={path}
      className="w-full text-left px-3 py-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 rounded text-sm transition-colors"
    >
      <div className="truncate font-medium text-text-primary">{basename}</div>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-text-muted text-xs flex-1 min-w-0">
          {path}
        </span>
        {lastOpenedLabel && (
          <span className="text-text-muted text-xs shrink-0">
            {lastOpenedLabel}
          </span>
        )}
      </div>
    </button>
  );
}
