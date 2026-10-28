"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { getStatusVariant as getConnectionStatusVariant } from "@/shared/utils/connectionStatus";
import { Badge, Toggle, Tooltip } from "@/shared/components";
import { BadgeVariant } from "@/shared/components/Badge";
import CooldownTimer from "./CooldownTimer.tsx";

interface ConnectionRowProps {
  connection: {
    id?: string
    name?: string
    email?: string
    displayName?: string
    modelLockUntil?: string
    testStatus?: string
    isActive?: boolean
    lastError?: string | number | true
    priority?: number
    globalPriority?: number
    authType?: string
    providerSpecificData?: Record<string, unknown> | null
    [key: string]: unknown
  }
  proxyPools?: {
    id?: string
    name?: string
    proxyUrl?: string
    noProxy?: string
    isActive?: boolean
  }[]
  isOAuth: boolean
  isFirst: boolean
  isLast: boolean
  onMoveUp(...args: unknown[]): unknown
  onMoveDown(...args: unknown[]): unknown
  onToggleActive(isActive: boolean): void
  onUpdateProxy?(poolId: string | null): void
  onEdit(...args: unknown[]): unknown
  onDelete(...args: unknown[]): unknown
  oneByOneStatus?: {
    state?: string
    error?: string
  }
  autoPing?: {
    isActive?: boolean
    provider?: string
    reactiveOn?: boolean
    scheduleOn?: boolean
    scheduleSummary?: string
    onConfigure?(...args: unknown[]): unknown
  }
}

type SpecificData = Record<string, unknown> | null;

export default function ConnectionRow({ connection, proxyPools, isOAuth, isFirst, isLast, onMoveUp, onMoveDown, onToggleActive, onUpdateProxy, onEdit, onDelete, oneByOneStatus = null, autoPing = null }: ConnectionRowProps) {
  const [showProxyDropdown, setShowProxyDropdown] = useState(false);
  const [updatingProxy, setUpdatingProxy] = useState(false);
  const proxyDropdownRef = useRef<HTMLDivElement | null>(null);
  const proxyBtnRef = useRef<HTMLButtonElement | null>(null);
  const [proxyDropdownStyle, setProxyDropdownStyle] = useState<React.CSSProperties | null>(null);

  const proxyPoolMap = new Map((proxyPools || []).map((pool) => [String(pool.id), pool]));
  const spec = connection.providerSpecificData as SpecificData;
  const boundProxyPoolId = spec?.proxyPoolId ? String(spec.proxyPoolId) : null;
  const boundProxyPool = boundProxyPoolId ? proxyPoolMap.get(boundProxyPoolId) : null;
  const hasLegacyProxy = spec?.connectionProxyEnabled === true && !!spec?.connectionProxyUrl;
  const hasAnyProxy = !!boundProxyPoolId || hasLegacyProxy;
  const proxyDisplayText = boundProxyPool
    ? `Pool: ${String(boundProxyPool.name)}`
    : boundProxyPoolId
      ? `Pool: ${boundProxyPoolId} (inactive/missing)`
      : hasLegacyProxy
        ? `Legacy: ${String(spec?.connectionProxyUrl)}`
        : "";
  const autoPingTooltip = (() => {
    if (!autoPing) return "";
    const activeModes = [] as string[];
    if (autoPing.reactiveOn) activeModes.push("On reset");
    if (autoPing.scheduleOn) activeModes.push(`Scheduled (${String(autoPing.scheduleSummary || "active")})`);
    if (activeModes.length > 0) {
      return `Auto-ping active: ${activeModes.join(" + ")}. Click to configure.`;
    }
    return autoPing.provider === "codex"
      ? "Auto-starts the next 5h Codex window after reset or on schedule. Click to configure."
      : "Auto-starts a new window on quota reset or fixed schedule. Click to configure.";
  })();

  let maskedProxyUrl = "";
  const rawProxyUrl = boundProxyPool?.proxyUrl || spec?.connectionProxyUrl;
  if (boundProxyPool?.proxyUrl || spec?.connectionProxyUrl) {
    try {
      const parsed = new URL(String(rawProxyUrl));
      maskedProxyUrl = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      maskedProxyUrl = String(rawProxyUrl);
    }
  }

  const noProxyText = boundProxyPool?.noProxy || spec?.connectionNoProxy || "";

  let proxyBadgeVariant: BadgeVariant = "default";
  if (boundProxyPool?.isActive === true) {
    proxyBadgeVariant = "success";
  } else if (boundProxyPoolId || hasLegacyProxy) {
    proxyBadgeVariant = "error";
  }

  // Render via portal + fixed positioning so ancestor overflow (scrollable
  // connections list) can't clip the dropdown
  const toggleProxyDropdown = () => {
    if (showProxyDropdown) {
      setShowProxyDropdown(false);
      return;
    }
    const rect = proxyBtnRef.current?.getBoundingClientRect();
    if (!rect) {
      setShowProxyDropdown(true);
      return;
    }
    const estimatedHeight = ((proxyPools?.length || 0) + 1) * 34 + 8;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < estimatedHeight && rect.top > spaceBelow;
    setProxyDropdownStyle({
      position: "fixed",
      right: window.innerWidth - rect.right,
      ...(flipUp
        ? { bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(rect.top - 8, 120) }
        : { top: rect.bottom + 4, maxHeight: Math.max(spaceBelow - 8, 120) }),
    });
    setShowProxyDropdown(true);
  };

  // Close dropdown when clicking outside, scrolling, or resizing
  useEffect(() => {
    if (!showProxyDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (
        proxyDropdownRef.current?.contains(e.target as Node) ||
        proxyBtnRef.current?.contains(e.target as Node)
      ) return;
      setShowProxyDropdown(false);
    };
    const close = () => setShowProxyDropdown(false);
    document.addEventListener("mousedown", handleClick);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [showProxyDropdown]);

  const handleSelectProxy = async (poolId: string | "__none__") => {
    setUpdatingProxy(true);
    try {
      await onUpdateProxy?.(poolId === "__none__" ? null : poolId);
    } finally {
      setUpdatingProxy(false);
      setShowProxyDropdown(false);
    }
  };

  const rowAuthType = String(connection.authType || (isOAuth ? "oauth" : "apikey"));
  const isOAuthConnection = rowAuthType === "oauth";
  const isCookieConnection = rowAuthType === "cookie";
  const authIcon = isCookieConnection ? "cookie" : isOAuthConnection ? "lock" : "key";
  const authLabel = isOAuthConnection ? "OAuth" : isCookieConnection ? "Cookie" : "API Key";
  const displayName = connection.name?.trim()
    || connection.email?.trim()
    || connection.displayName?.trim()
    || (isOAuthConnection ? "OAuth Account" : isCookieConnection ? "Cookie Account" : "API Key");
  const secondaryDisplayName = connection.name?.trim() && connection.email?.trim() && String(connection.name).trim() !== String(connection.email).trim()
    ? String(connection.email).trim()
    : connection.name?.trim() && connection.displayName?.trim() && String(connection.name).trim() !== String(connection.displayName).trim()
      ? String(connection.displayName).trim()
      : null;

  // Use useState + useEffect for impure Date.now() to avoid calling during render
  const [isCooldown, setIsCooldown] = useState(false);

  // Get earliest model lock timestamp (useEffect handles the Date.now() comparison)
  const modelLockUntil = Object.entries(connection)
    .filter(([k]) => k.startsWith("modelLock_"))
    .map(([, v]) => v)
    .filter((v): v is string => typeof v === "string" && !!v)
    .sort()[0] || null;

  useEffect(() => {
    const checkCooldown = () => {
      const until = Object.entries(connection)
        .filter(([k]) => k.startsWith("modelLock_"))
        .map(([, v]) => v)
        .filter((v): v is string => typeof v === "string" && v && new Date(v).getTime() > Date.now())
        .sort()[0] || null;
      setIsCooldown(!!until);
    };

    checkCooldown();
    const interval = modelLockUntil ? setInterval(checkCooldown, 1000) : null;
    return () => {
      if (interval) clearInterval(interval);
    };
    // The body only reads the connection's modelLock_* entries, and
    // modelLockUntil already summarises those into a primitive. Depending on the
    // connection object itself would restart the timer on every parent render.
  }, [modelLockUntil, connection]);

  // Determine effective status (override unavailable if cooldown expired)
  const effectiveStatus = (connection.testStatus === "unavailable" && !isCooldown)
    ? "active"  // Cooldown expired → treat as active
    : (typeof connection.testStatus === "string" ? connection.testStatus : undefined);

  const getStatusVariant = () => {
    const variant = getConnectionStatusVariant(connection.isActive, effectiveStatus);
    return variant as BadgeVariant;
  };

  const getOneByOneVariant = (): BadgeVariant => {
    if (!oneByOneStatus) return "default";
    if (oneByOneStatus.state === "success") return "success";
    if (oneByOneStatus.state === "failed") return "error";
    if (oneByOneStatus.state === "testing") return "primary";
    return "default";
  };

  const getOneByOneLabel = () => {
    if (!oneByOneStatus) return null;
    if (oneByOneStatus.state === "queued") return "queued";
    if (oneByOneStatus.state === "testing") return "testing";
    if (oneByOneStatus.state === "success") return "success";
    if (oneByOneStatus.state === "failed") return oneByOneStatus.error ? `failed: ${oneByOneStatus.error}` : "failed";
    return null;
  };

  return (
    <div className={`group flex min-w-0 flex-col gap-3 rounded-lg p-2 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between ${connection.isActive === false ? "opacity-60" : ""}`}>
      <div className="flex min-w-0 flex-1 items-start gap-2 sm:items-center sm:gap-3">
        {/* Priority arrows */}
        <div className="flex shrink-0 flex-col">
          <button
            onClick={onMoveUp}
            disabled={isFirst}
            className={`p-0.5 rounded ${isFirst ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}
          >
            <span className="material-symbols-outlined text-sm">keyboard_arrow_up</span>
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast}
            className={`p-0.5 rounded ${isLast ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}
          >
            <span className="material-symbols-outlined text-sm">keyboard_arrow_down</span>
          </button>
        </div>
        <span className="material-symbols-outlined shrink-0 text-base text-text-muted">
          {authIcon}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{displayName}</p>
          {secondaryDisplayName && (
            <p className="text-xs text-text-muted truncate">{secondaryDisplayName}</p>
          )}
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 sm:gap-2">
            <Badge variant={getStatusVariant()} size="sm" dot>
              {connection.isActive === false ? "disabled" : (effectiveStatus || "Unknown")}
            </Badge>
            <Badge variant="default" size="sm">
              {authLabel}
            </Badge>
            {hasAnyProxy && (
              <Badge variant={proxyBadgeVariant} size="sm">
                Proxy
              </Badge>
            )}
            {isCooldown && connection.isActive !== false && modelLockUntil && <CooldownTimer until={modelLockUntil} />}
            {connection.lastError && connection.isActive !== false && (
              <span className="max-w-full truncate text-xs text-red-500 sm:max-w-[300px]" title={String(connection.lastError)}>
                {String(connection.lastError)}
              </span>
            )}
            <span className="text-xs text-text-muted">#{String(connection.priority)}</span>
            {connection.globalPriority && (
              <span className="text-xs text-text-muted">Auto: {String(connection.globalPriority)}</span>
            )}
            {getOneByOneLabel() && (
              <Badge variant={getOneByOneVariant()} size="sm">
                {getOneByOneLabel()}
              </Badge>
            )}
          </div>
          {hasAnyProxy && (
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              <span className="max-w-full truncate text-[11px] text-text-muted sm:max-w-[420px]" title={proxyDisplayText}>
                {proxyDisplayText}
              </span>
              {maskedProxyUrl && (
                <code className="max-w-full truncate rounded bg-black/5 px-1 py-0.5 font-mono text-[10px] text-text-muted dark:bg-white/5 sm:max-w-[260px]">
                  {maskedProxyUrl}
                </code>
              )}
              {noProxyText && (
                <span className="max-w-full truncate text-[11px] text-text-muted sm:max-w-[320px]" title={String(noProxyText)}>
                  no_proxy: {String(noProxyText)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
        <div className="grid flex-1 grid-cols-3 gap-1 sm:flex sm:flex-none">
          {/* Proxy button with inline dropdown */}
          {(proxyPools || []).length > 0 && (
            <div>
              <button
                ref={proxyBtnRef}
                onClick={toggleProxyDropdown}
                className={`flex w-full flex-col items-center rounded px-2 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${hasAnyProxy ? "text-primary" : "text-text-muted hover:text-primary"}`}
                disabled={updatingProxy}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {updatingProxy ? "progress_activity" : "lan"}
                </span>
                <span className="text-[10px] leading-tight">Proxy</span>
              </button>
              {showProxyDropdown && createPortal(
                <div
                  ref={proxyDropdownRef}
                  style={proxyDropdownStyle}
                  className="z-50 max-w-[78vw] min-w-[160px] overflow-y-auto rounded-lg border border-border bg-bg py-1 shadow-lg"
                >
                  <button
                    onClick={() => handleSelectProxy("__none__")}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5 ${!boundProxyPoolId ? "text-primary font-medium" : "text-text-main"}`}
                  >
                    None
                  </button>
                  {(proxyPools || []).map((pool) => (
                    <button
                      key={String(pool.id)}
                      onClick={() => handleSelectProxy(String(pool.id))}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5 ${boundProxyPoolId === String(pool.id) ? "text-primary font-medium" : "text-text-main"}`}
                    >
                      {String(pool.name)}
                    </button>
                  ))}
                </div>,
                document.body
              )}
            </div>
          )}
          {autoPing && (
            <Tooltip text={autoPingTooltip}>
              <button
                onClick={autoPing.onConfigure}
                className={`flex w-full flex-col items-center rounded px-2 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${autoPing.isActive ? "text-primary" : "text-text-muted hover:text-primary"}`}
              >
                <span className="material-symbols-outlined text-[18px]">bolt</span>
                <span className="text-[10px] leading-tight">Auto-ping</span>
              </button>
            </Tooltip>
          )}
          <button onClick={onEdit} className="flex flex-col items-center rounded px-2 py-1 text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5">
            <span className="material-symbols-outlined text-[18px]">edit</span>
            <span className="text-[10px] leading-tight">Edit</span>
          </button>
          <button onClick={onDelete} className="flex flex-col items-center rounded px-2 py-1 text-red-500 hover:bg-red-500/10">
            <span className="material-symbols-outlined text-[18px]">delete</span>
            <span className="text-[10px] leading-tight">Delete</span>
          </button>
        </div>
        <Toggle
          size="sm"
          checked={connection.isActive ?? true}
          onChange={onToggleActive}
        />
      </div>
    </div>
  );
}
