"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";

const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "smart", label: "Smart (switch only on limit/error)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
];

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotateStrategy, setRotateStrategy] = useState("none");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, settingsData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
      setRotateStrategy(override.rotateStrategy || "none");
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const save = useCallback(async (poolId, strategy) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (poolId === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = poolId;
      if (strategy === "none") delete override.rotateStrategy;
      else override.rotateStrategy = strategy;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxy config error:", e);
    } finally {
      setSaving(false);
    }
  }, [providerId]);

  const handlePoolChange = (newPoolId) => {
    setProxyPoolId(newPoolId);
    save(newPoolId, rotateStrategy);
  };

  const handleStrategyChange = (newStrategy) => {
    setRotateStrategy(newStrategy);
    save(proxyPoolId, newStrategy);
  };

  const canRotate = proxyPools.length >= 2;
  const isRotation = rotateStrategy !== "none";

  if (providerId === "opencode-v2") {
    return (
      <div className="relative overflow-hidden rounded-[var(--r-card)] border border-primary/30 bg-surface shadow-[var(--elev-1)] transition-all">
        {/* Animated moving gradient shine beam */}
        <div
          aria-hidden="true"
          className="proxy-shimmer-beam pointer-events-none absolute -inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-primary/15 to-transparent blur-sm"
        />

        {/* Content */}
        <div className="relative z-10 flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5">
          <div className="flex items-start sm:items-center gap-3.5">
            {/* Glowing animated proxy route icon (lan) */}
            <div className="relative flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/25 shadow-[0_0_16px_rgba(229,106,74,0.2)]">
              <span className="material-symbols-outlined text-[22px]">lan</span>
              <span className="absolute -top-1 -right-1 flex size-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex size-3 rounded-full bg-emerald-500" />
              </span>
            </div>

            <div className="flex flex-col">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-wider font-semibold text-text-muted">
                  Dedicated Routing
                </span>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/25">
                  <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  ACTIVE
                </span>
              </div>

              {/* Main title: proxy by: t.me/abcseren */}
              <a
                href="https://t.me/abcseren"
                target="_blank"
                rel="noopener noreferrer"
                className="group mt-0.5 inline-flex items-center gap-1.5 text-base sm:text-lg font-bold text-text-main transition-colors hover:text-primary"
              >
                <span>proxy by:</span>
                <span className="proxy-text-gradient bg-gradient-to-r from-primary via-amber-400 to-primary bg-clip-text text-transparent font-mono">
                  t.me/abcseren
                </span>
                <span className="material-symbols-outlined text-[18px] text-text-muted group-hover:text-primary group-hover:translate-x-0.5 transition-all">
                  open_in_new
                </span>
              </a>

              <p className="text-xs text-text-muted mt-0.5">
                Residential broadband proxy locked automatically for OpenCode Free V2.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">Ready to use as-is, or route it through a proxy pool to bypass IP-based limits.</p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>

      <Select
        label="Proxy Pool"
        value={proxyPoolId}
        onChange={(e) => handlePoolChange(e.target.value)}
        disabled={saving || isRotation}
        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
        ]}
        hint={isRotation ? "Rotation is on, so it uses every active pool. The pool selector is ignored." : undefined}
      />

      <div className="flex flex-col gap-2 mt-4">
        <label className="text-sm font-medium text-text-main">Rotation Strategy</label>
        <select
          value={rotateStrategy}
          onChange={(e) => handleStrategyChange(e.target.value)}
          disabled={saving}
          className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all disabled:opacity-50"
        >
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value} disabled={s.value !== "none" && !canRotate}>
              {s.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">
          {!canRotate
            ? `Need at least 2 active proxy pools for rotation.`
            : isRotation
              ? rotateStrategy === "smart"
                ? `Sticks to one of the ${proxyPools.length} active pools and only switches when that pool returns a limit or error — a working proxy is never rotated away. State is in-memory (resets on restart).`
                : rotateStrategy === "round-robin"
                  ? `Rotating through all ${proxyPools.length} active pools in order. State is in-memory (resets on restart).`
                  : `Picking a random pool from ${proxyPools.length} active pools each request.`
              : `Uses the selected pool above. Set to Smart to switch only on limit/error, or Round-robin / Random to rotate on every request.`}
        </p>
      </div>
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
