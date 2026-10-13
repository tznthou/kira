import { useEffect, useState } from "react";
import { useAuthStore, type AuthFlowStatus, type DeviceFlowState } from "@/stores/authStore";
import { githubPollToken, githubGetAuthStatus, openExternalUrl } from "@/lib/tauri";
import { Button } from "@/components/ui/Button";
import { TitleBarDragStrip } from "@/components/ui/TitleBarDragStrip";

interface DeviceCodeModalProps {
  flow: DeviceFlowState;
}

// Locked to the canonical GitHub OAuth device-flow URL. The Tauri capability
// allowlist (capabilities/default.json) is also pinned to this exact URL — if
// the backend ever returns a different verification_uri (compromised IPC,
// MITM, schema drift), we surface a UI error and refuse to navigate, instead
// of rendering the attacker-controlled URL as an anchor or passing it to the
// opener (which would reject anyway, but only after the URL was visible).
const EXPECTED_VERIFICATION_URL = "https://github.com/login/device";

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/// 終結態 (error / expired / denied) 用同一張卡片版面，差別只在文案
function terminalCopy(
  status: AuthFlowStatus,
  errorMessage: string | null,
): { title: string; body: string } | null {
  switch (status) {
    case "error":
      return {
        title: "Authorization failed",
        body: errorMessage ?? "Something went wrong. Please retry.",
      };
    case "expired":
      return {
        title: "Code expired",
        body: "The login code expired. Try connecting again.",
      };
    case "denied":
      return {
        title: "Authorization denied",
        body: "You declined the GitHub authorization request.",
      };
    default:
      return null;
  }
}

export function DeviceCodeModal({ flow }: DeviceCodeModalProps) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const status = useAuthStore((s) => s.status);
  const errorMessage = useAuthStore((s) => s.errorMessage);
  const setStatus = useAuthStore((s) => s.setStatus);
  const setAuthenticated = useAuthStore((s) => s.setAuthenticated);
  const reset = useAuthStore((s) => s.reset);
  const setError = useAuthStore((s) => s.setError);

  // 1Hz 倒數
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Polling loop：每 interval 秒 call github_poll_token
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let currentInterval = flow.interval;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() >= flow.expires_at) {
        setStatus("expired");
        return;
      }
      try {
        const outcome = await githubPollToken(flow.device_code);
        if (cancelled) return;
        switch (outcome.kind) {
          case "success": {
            try {
              const status = await githubGetAuthStatus();
              if (cancelled) return;
              setAuthenticated(status.username);
            } catch {
              if (cancelled) return;
              // Token 已寫入 keyring；username fetch 失敗（網路不穩 / GitHub /user 暫時不可達）
              // 不能讓 UI 退回 unauthenticated——會跟 keyring 實際狀態脫鉤，後續 push/pull
              // 仍用該 token 但 UI 沒 logout button。用 placeholder username 標 authenticated
              setAuthenticated("github");
            }
            return;
          }
          case "expired_token":
            setStatus("expired");
            return;
          case "access_denied":
            setStatus("denied");
            return;
          case "unexpected":
            // schema drift / incorrect_device_code → 停止 polling，否則藏 error 持續打 endpoint
            setError("GitHub returned an unexpected response. Please retry.");
            return;
          case "slow_down":
            // 累加退避：取「目前 interval + 5s」跟「server 給的 new_interval」較大者，
            // 避免連續 slow_down 用同樣間隔導致 rate-limit cascade
            currentInterval = Math.max(currentInterval + 5, outcome.new_interval);
            break;
          case "authorization_pending":
            break;
        }
        timer = setTimeout(() => void tick(), currentInterval * 1000);
      } catch (err) {
        if (cancelled) return;
        console.error("[kira] poll token failed:", err);
        setError("Failed to check authorization. Please retry.");
      }
    };

    timer = setTimeout(() => void tick(), currentInterval * 1000);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [flow.device_code, flow.expires_at, flow.interval, setStatus, setAuthenticated, setError]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(flow.user_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("[kira] copy failed:", err);
    }
  };

  const verificationUrlMismatch =
    flow.verification_uri !== EXPECTED_VERIFICATION_URL;

  const handleOpenVerificationUrl = (e: React.MouseEvent) => {
    e.preventDefault();
    setOpenError(null);
    if (verificationUrlMismatch) {
      setOpenError(
        "Unexpected verification URL from GitHub. Authentication aborted — please retry.",
      );
      return;
    }
    void openExternalUrl(EXPECTED_VERIFICATION_URL).catch((err) => {
      console.error("[kira] open verification URL failed:", err);
      setOpenError(
        "Could not open browser. Copy the URL above and paste it manually.",
      );
    });
  };

  const remaining = flow.expires_at - now;

  const terminal = terminalCopy(status, errorMessage);
  if (terminal) {
    return (
      <Backdrop>
        <Card>
          <h2 className="text-lg font-semibold mb-2">{terminal.title}</h2>
          <p className="text-text-secondary text-sm mb-4">{terminal.body}</p>
          <Button variant="primary" onClick={reset}>Close</Button>
        </Card>
      </Backdrop>
    );
  }

  return (
    <Backdrop>
      <Card>
        <h2 className="text-lg font-semibold mb-2">Connect to GitHub</h2>
        <ol className="text-sm text-text-secondary space-y-2 mb-4">
          <li>1. Open the verification URL in your browser.</li>
          <li>2. Enter the code below.</li>
          <li>3. Authorize Kira.</li>
        </ol>

        <div className="bg-app-bg rounded p-3 mb-3">
          <div className="text-xs text-text-tertiary mb-1">
            Verification URL
          </div>
          <a
            href={EXPECTED_VERIFICATION_URL}
            onClick={handleOpenVerificationUrl}
            className="text-link hover:underline break-all"
          >
            {EXPECTED_VERIFICATION_URL}
          </a>
          {openError && (
            <div className="text-warning-fg text-xs mt-2">{openError}</div>
          )}
        </div>

        <div className="bg-app-bg rounded p-3 mb-4">
          <div className="text-xs text-text-tertiary mb-1">Code</div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-2xl font-bold tracking-widest text-app-fg select-all">
              {flow.user_code}
            </span>
            <Button size="sm" onClick={() => void handleCopy()}>
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
        </div>

        <div className="text-xs text-text-tertiary mb-4">
          Waiting for authorization · expires in {formatRemaining(remaining)}
        </div>

        <div className="flex justify-end">
          <Button onClick={reset}>Cancel</Button>
        </div>
      </Card>
    </Backdrop>
  );
}

function Backdrop({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      {/* Overlay 標題列下遮罩蓋住了站牌的拖曳區：頂端一條同站牌高的拖曳帶，畫在卡片下（卡片要 relative） */}
      <TitleBarDragStrip />
      {children}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative bg-surface-1 border border-border rounded-lg p-5 w-full max-w-md text-app-fg">
      {children}
    </div>
  );
}

