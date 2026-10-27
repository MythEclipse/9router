"use client";

import { Button, Input } from "@/shared/components";
import type { ReactNode } from "react";

/**
 * The status line for one exposure option (Cloudflare Tunnel or Tailscale).
 *
 * Both options walk the same five states in the same order, and the original JSX
 * spelled each of them out twice — once per option — with only the labels and the
 * icon differing. That is how the two drifted: the Tailscale copy grew an auth
 * button the tunnel copy never got, and the "checking" state was wired to a
 * different flag in each. This component owns the state chart; the option prop
 * supplies the words.
 *
 * The states, in the order they are tested:
 *
 *   ready      → the URL is live, offer copy + disable
 *   degraded   → enabled but not answering yet; keep disable, show progress
 *   connecting → a command is running; offer auth (if any) + stop
 *   error      → the last attempt failed; offer retry
 *   checking   → the first status probe has not returned; offer stop
 *   idle       → not enabled; offer enable
 */
export type ExposureState = "ready" | "degraded" | "connecting" | "error" | "checking" | "idle";

/** Derive the state chart above from the flags the page already tracks. */
export function exposureStateOf(flags: {
  enabled: boolean;
  loading: boolean;
  reachable: boolean;
  connecting?: boolean;
  checking?: boolean;
  hasError?: boolean;
}): ExposureState {
  if (flags.enabled && !flags.loading && flags.reachable) return "ready";
  if (flags.enabled && !flags.loading && !flags.reachable) return "degraded";
  if (flags.loading || flags.connecting) return "connecting";
  if (flags.hasError) return "error";
  if (flags.checking) return "checking";
  return "idle";
}

export interface ExposureControlProps {
  label: string;
  state: ExposureState;
  /** The public URL, shown read-only when ready. */
  url: string;
  /** Copy target id, compared against the page's `copied` value. */
  copyId: string;
  copied: string | null;
  onCopy: (url: string, id: string) => void;

  /** Progress text while connecting, e.g. "Creating tunnel...". */
  progress: string;
  /** Progress text while degraded; already includes the ellipsis. */
  degradedText: string;
  /** Error text for the error state. */
  errorMessage: string;
  /** Set when a login URL is waiting for the user. */
  authUrl?: string;
  authLabel?: string;

  /** Icon for the enable button. */
  enableIcon: string;
  /** Gradient class for the enable button; omit for the plain style. */
  enableClassName?: string;
  /** Warning shown when enabling is blocked (e.g. require-api-key is off). */
  blockedReason?: string;

  onEnable: () => void;
  onDisable: () => void;
  onStop: () => void;
  /** Called instead of onEnable when `blockedReason` is set. */
  onBlocked: (reason: string) => void;
}

/** A disabled-power button shared by every state that offers a way out. */
function StopButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
      title={title}
    >
      <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
    </button>
  );
}

/** The inline status strip used by degraded, connecting and checking. */
function StatusStrip({ tone, children }: { tone: "muted" | "warn" | "error"; children: ReactNode }) {
  const tones = {
    muted: "border-border bg-input text-text-muted",
    warn: "border-amber-300 dark:border-amber-800 bg-amber-500/5 text-amber-600 dark:text-amber-400",
    error: "border-red-300 dark:border-red-800 bg-red-500/5 text-red-600 dark:text-red-400",
  };
  const icon = tone === "error" ? "error" : "progress_activity";
  return (
    <div className={`min-w-0 flex-1 flex items-center gap-2 px-3 py-1.5 rounded border text-sm ${tones[tone]}`}>
      <span className={`material-symbols-outlined text-sm ${tone === "error" ? "" : "animate-spin"}`}>{icon}</span>
      {children}
    </div>
  );
}

export default function ExposureControl(props: ExposureControlProps) {
  const {
    label, state, url, copyId, copied, onCopy, progress, degradedText, errorMessage,
    authUrl, authLabel, enableIcon, enableClassName, blockedReason,
    onEnable, onDisable, onStop, onBlocked,
  } = props;

  const badge = state === "ready" || state === "degraded" || state === "connecting"
    ? "bg-primary/10 text-primary"
    : "bg-surface-2 text-text-muted";

  const requestEnable = () => {
    if (blockedReason) {
      onBlocked(blockedReason);
      return;
    }
    onEnable();
  };

  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <span className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 min-w-[88px] max-w-[140px] truncate text-center ${badge}`}>
        {label}
      </span>

      {state === "ready" && (
        <>
          <Input value={`${url}/v1`} readOnly className="flex-1 min-w-0 font-mono text-sm" inputClassName="truncate" />
          <button
            onClick={() => onCopy(`${url}/v1`, copyId)}
            className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-colors shrink-0"
          >
            <span className="material-symbols-outlined text-[18px]">
              {copied === copyId ? "check" : "content_copy"}
            </span>
          </button>
          <StopButton title={`Disable ${label}`} onClick={onDisable} />
        </>
      )}

      {state === "degraded" && (
        <>
          <StatusStrip tone="warn">{degradedText}</StatusStrip>
          <StopButton title={`Disable ${label}`} onClick={onDisable} />
        </>
      )}

      {state === "connecting" && (
        <>
          <StatusStrip tone="muted">{progress}</StatusStrip>
          {authUrl && (
            <Button size="sm" icon="open_in_new" onClick={() => window.open(authUrl, `${copyId}_auth`, "width=600,height=700,noopener,noreferrer")}>
              {authLabel || "Open"}
            </Button>
          )}
          <StopButton title="Stop" onClick={onStop} />
        </>
      )}

      {state === "error" && (
        <>
          <StatusStrip tone="error">{errorMessage}</StatusStrip>
          <Button size="sm" icon={enableIcon} onClick={requestEnable}>
            Enable
          </Button>
        </>
      )}

      {state === "checking" && (
        <>
          <StatusStrip tone="muted">Checking...</StatusStrip>
          <StopButton title="Stop" onClick={onStop} />
        </>
      )}

      {state === "idle" && (
        <Button size="sm" icon={enableIcon} onClick={requestEnable} className={enableClassName}>
          Enable
        </Button>
      )}
    </div>
  );
}
