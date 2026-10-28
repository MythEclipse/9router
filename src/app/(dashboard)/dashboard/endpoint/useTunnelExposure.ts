"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clientPingUrl, clientPingAny } from "./endpointPing";
import { ServerSentFrameReader } from "@/shared/utils/sseFrames";
import { applyProbe, initialReachability, type ReachabilityState } from "./reachability";
import {
  CLIENT_PING_FAST_MS,
  REACHABLE_MISS_THRESHOLD,
  STATUS_POLL_FAST_MS,
  TUNNEL_PING_INTERVAL_MS,
  TUNNEL_PING_MAX_MS,
} from "./endpointConstants";

/**
 * A status banner. The page renders `error` in red, `success`/`warning` through the
 * existing alert styles; keeping the tones the handlers already emit means this
 * module does not silently reclassify them.
 */
export interface ExposureStatus {
  type: "error" | "success" | "warning" | "info";
  message: string;
}

/** The tailscale-installed probe result. */
interface TailscaleCheck {
  installed?: boolean;
  hasCachedPassword?: boolean;
  loggedIn?: boolean;
}

/** Everything the endpoint page needs to render and drive the two exposures. */
export interface TunnelExposure {
  // tunnel
  tunnelChecking: boolean;
  tunnelEnabled: boolean;
  tunnelReachable: boolean;
  tunnelUrl: string;
  tunnelPublicUrl: string;
  tunnelLoading: boolean;
  tunnelProgress: string;
  tunnelStatus: ExposureStatus | null;
  tunnelEverReachable: boolean;
  showEnableTunnelModal: boolean;
  showDisableTunnelModal: boolean;
  setShowEnableTunnelModal: (value: boolean) => void;
  setShowDisableTunnelModal: (value: boolean) => void;
  setTunnelChecking: (value: boolean) => void;
  setTunnelLoading: (value: boolean) => void;
  setTunnelProgress: (value: string) => void;
  setTunnelStatus: (value: ExposureStatus | null) => void;
  handleEnableTunnel: () => Promise<void>;
  handleDisableTunnel: () => Promise<void>;

  // tailscale
  tsEnabled: boolean;
  tsReachable: boolean;
  tsUrl: string;
  tsLoading: boolean;
  tsProgress: string;
  tsStatus: ExposureStatus | null;
  tsAuthUrl: string;
  tsAuthLabel: string;
  tsInstalled: boolean | null;
  tsInstalling: boolean;
  tsInstallLog: string[];
  tsSudoPassword: string;
  tsConnecting: boolean;
  showTsModal: boolean;
  showDisableTsModal: boolean;
  tsEverReachable: boolean;
  tsLogRef: React.RefObject<HTMLDivElement | null>;
  setShowTsModal: (value: boolean) => void;
  setShowDisableTsModal: (value: boolean) => void;
  setTsStatus: (value: ExposureStatus | null) => void;
  setTsSudoPassword: (value: string) => void;
  /** Used by the Stop button, which cancels an in-flight connect. */
  setTsLoading: (value: boolean) => void;
  setTsConnecting: (value: boolean) => void;
  setTsProgress: (value: string) => void;
  handleInstallTailscale: () => Promise<void>;
  handleConnectTailscale: () => Promise<void>;
  handleDisableTailscale: () => Promise<void>;
  handleOpenTsModal: () => Promise<void>;
  clearUserAuth: () => void;

  // shared
  syncTunnelStatus: () => Promise<void>;
  loadSettings: () => Promise<void>;
}

/** How the hook reports settings back to the page that owns the toggles. */
export interface ExposureSettings {
  requireApiKey: boolean;
  tunnelDashboardAccess: boolean;
}

/** Read a JSON body without letting a non-JSON error page throw. */
async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => null);
}

/**
 * Owns the Cloudflare Tunnel and Tailscale lifecycle for the endpoint page.
 *
 * Every handler below is the previous page-level handler moved verbatim: the
 * polling loops, the 40×3s login wait, the funnel-enable retry, the health pings
 * and the exact status messages are unchanged, because those sequences encode
 * upstream behaviour that is not obvious from the happy path. What changed is only
 * placement (one module instead of the page body) and typing.
 *
 * `requireApiKey` is read through a ref: the enable path needs its value at click
 * time, and taking it as a dependency would re-create every callback on each
 * settings toggle.
 */
export function useTunnelExposure(
  requireApiKey: boolean,
  onSettingsLoaded?: (settings: ExposureSettings) => void
): TunnelExposure {
  const [tunnelChecking, setTunnelChecking] = useState(true);
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelReachable, setTunnelReachable] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tunnelPublicUrl, setTunnelPublicUrl] = useState("");
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelProgress, setTunnelProgress] = useState("");
  const [tunnelStatus, setTunnelStatus] = useState<ExposureStatus | null>(null);
  const [showEnableTunnelModal, setShowEnableTunnelModal] = useState(false);
  const [showDisableTunnelModal, setShowDisableTunnelModal] = useState(false);
  const [tunnelEverReachable, setTunnelEverReachable] = useState(false);

  const [tsEnabled, setTsEnabled] = useState(false);
  const [tsReachable, setTsReachable] = useState(false);
  const [tsUrl, setTsUrl] = useState("");
  const [tsLoading, setTsLoading] = useState(false);
  const [tsProgress, setTsProgress] = useState("");
  const [tsStatus, setTsStatus] = useState<ExposureStatus | null>(null);
  const [tsAuthUrl, setTsAuthUrl] = useState("");
  const [tsAuthLabel, setTsAuthLabel] = useState("");
  const [tsInstalled, setTsInstalled] = useState<boolean | null>(null);
  const [tsInstalling, setTsInstalling] = useState(false);
  const [tsInstallLog, setTsInstallLog] = useState<string[]>([]);
  const [tsSudoPassword, setTsSudoPassword] = useState("");
  const [tsConnecting, setTsConnecting] = useState(false);
  const [showTsModal, setShowTsModal] = useState(false);
  const [showDisableTsModal, setShowDisableTsModal] = useState(false);
  const [tsEverReachable, setTsEverReachable] = useState(false);
  const tsLogRef = useRef<HTMLDivElement | null>(null);

  const tunnelClientReachableRef = useRef(false);
  const tsClientReachableRef = useRef(false);
  const tunnelReachState = useRef<ReachabilityState>(initialReachability());
  const tsReachState = useRef<ReachabilityState>(initialReachability());
  const tunnelReachableRef = useRef(false);
  const tsReachableRef = useRef(false);
  const requireApiKeyRef = useRef(requireApiKey);

  useEffect(() => {
    requireApiKeyRef.current = requireApiKey;
  }, [requireApiKey]);
  useEffect(() => {
    tunnelReachableRef.current = tunnelReachable;
  }, [tunnelReachable]);
  useEffect(() => {
    tsReachableRef.current = tsReachable;
  }, [tsReachable]);

  /** Folds one probe into the shared debounce rule (see ./reachability). */
  const applyReachability = useCallback(
    (
      state: { current: ReachabilityState },
      ok: boolean,
      setReachable: (value: boolean) => void,
      setEver: (value: boolean) => void,
      wasReachable: boolean
    ) => {
      const result = applyProbe(state.current, ok, REACHABLE_MISS_THRESHOLD, wasReachable);
      state.current = result.state;
      setReachable(result.reachable);
      if (result.recovered) setEver(true);
      return result;
    },
    []
  );

  /**
   * Applies a `/api/tunnel/status` body to both exposures. Shared by the poll and
   * the initial load, which previously duplicated this block line for line.
   */
  const applyStatusBody = useCallback(
    (data: any) => {
      setTunnelUrl(data.tunnel?.tunnelUrl || "");
      setTunnelPublicUrl(data.tunnel?.publicUrl || "");
      setTunnelEnabled(data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false);
      applyReachability(
        tunnelReachState,
        tunnelClientReachableRef.current,
        setTunnelReachable,
        setTunnelEverReachable,
        tunnelReachableRef.current
      );

      setTsUrl(data.tailscale?.tunnelUrl || "");
      setTsEnabled(data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false);
      applyReachability(
        tsReachState,
        tsClientReachableRef.current,
        setTsReachable,
        setTsEverReachable,
        tsReachableRef.current
      );
    },
    [applyReachability]
  );

  // Reads only setters and tracker refs, never a state value, so it stays memoizable.
  const syncTunnelStatus = useCallback(async () => {
    try {
      const statusRes = await fetch("/api/tunnel/status", { cache: "no-store" });
      if (!statusRes.ok) return;
      applyStatusBody(await statusRes.json());
    } catch {
      /* ignore poll errors */
    }
  }, [applyStatusBody]);

  const loadSettings = useCallback(async () => {
    setTunnelChecking(true);
    try {
      const [settingsData, statusRes] = await Promise.all([
        // The settings store is owned by the page (it also drives the toggles), so
        // this hook reports the values back instead of keeping a second copy.
        import("@/store/settingsStore").then((m) => m.default.getState().fetchSettings()),
        fetch("/api/tunnel/status", { cache: "no-store" }),
      ]);
      if (settingsData && onSettingsLoaded) {
        const settings = settingsData as { requireApiKey?: boolean; tunnelDashboardAccess?: boolean };
        onSettingsLoaded({
          requireApiKey: settings.requireApiKey || false,
          tunnelDashboardAccess: settings.tunnelDashboardAccess || false,
        });
      }
      if (statusRes.ok) applyStatusBody(await statusRes.json());
    } catch (error) {
      console.error("Error loading settings:", error);
    } finally {
      setTunnelChecking(false);
    }
  }, [applyStatusBody, onSettingsLoaded]);

  // The pollers below must not depend on reachability: they write it, so taking it as
  // an input makes the effect re-trigger itself on its own output. They depend on
  // this boolean instead, and it only flips when the *verdict* changes.
  const degraded = (tunnelEnabled && !tunnelReachable) || (tsEnabled && !tsReachable);

  /** Probes every enabled exposure once and folds the outcome into its tracker. */
  const probeBoth = useCallback(async () => {
    if (document.hidden) return;
    if (tunnelEnabled && (tunnelUrl || tunnelPublicUrl)) {
      const ok = await clientPingAny(tunnelPublicUrl, tunnelUrl);
      tunnelClientReachableRef.current = ok;
      applyReachability(
        tunnelReachState,
        ok,
        setTunnelReachable,
        setTunnelEverReachable,
        tunnelReachableRef.current
      );
    } else {
      tunnelClientReachableRef.current = false;
    }
    if (tsEnabled && tsUrl) {
      const ok = await clientPingUrl(tsUrl);
      tsClientReachableRef.current = ok;
      applyReachability(tsReachState, ok, setTsReachable, setTsEverReachable, tsReachableRef.current);
    } else {
      tsClientReachableRef.current = false;
    }
  }, [tunnelEnabled, tunnelUrl, tunnelPublicUrl, tsEnabled, tsUrl, applyReachability]);

  // Status poll while degraded, plus a one-shot refresh when the tab reappears.
  //
  // Health enters through `degraded`, which only changes when the verdict does — not
  // through the reachability state the poll itself writes.
  useEffect(() => {
    if (!tunnelEnabled && !tsEnabled) return;
    const onVisible = () => {
      if (!document.hidden) syncTunnelStatus();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => {
      if (!document.hidden) syncTunnelStatus();
    }, STATUS_POLL_FAST_MS);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tunnelEnabled, tsEnabled, syncTunnelStatus]);

  // Browser-side ping: probes the URLs directly so the UI stays reachable even when
  // backend DNS hiccups on *.ts.net or *.trycloudflare.com. Adaptive: fast while
  // degraded, a single probe while healthy, paused when hidden.
  //
  // `probeBoth` writes reachability, so this effect must key off `degraded` rather
  // than off the state it produces. The healthy path still probes once per mount so a
  // recovery is visible, which is what the unconditional first call was for.
  useEffect(() => {
    const anyEnabled = (tunnelEnabled && (tunnelUrl || tunnelPublicUrl)) || (tsEnabled && tsUrl);
    if (!anyEnabled) return;
    probeBoth();
    if (!degraded) return;
    const id = setInterval(probeBoth, CLIENT_PING_FAST_MS);
    return () => clearInterval(id);
  }, [
    tunnelEnabled, tunnelUrl, tunnelPublicUrl, tsEnabled, tsUrl,
    degraded, probeBoth,
  ]);

  useEffect(() => {
    if (tsLogRef.current) tsLogRef.current.scrollTop = tsLogRef.current.scrollHeight;
  }, [tsInstallLog]);

  // ── tunnel ────────────────────────────────────────────────────────────────

  /**
   * Polls the public URL until it answers, bailing out early if the backend process
   * died. Mirrors the previous `pingTunnelHealth` exactly, including the ~10s
   * liveness check and the two distinct failure messages.
   */
  const pingTunnelHealth = async (...urls: Array<string | undefined>): Promise<boolean> => {
    setTunnelLoading(true);
    setTunnelProgress("Waiting for tunnel ready...");
    const targets = urls.filter(Boolean).map((u) => `${u}/api/health`);
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      const ok = await Promise.any(
        targets.map(async (h) => {
          const p = await fetch(h, { mode: "cors", cache: "no-store" });
          if (p.ok) return true;
          throw new Error("not ready");
        })
      ).catch(() => false);
      if (ok) {
        setTunnelEnabled(true);
        setTunnelLoading(false);
        setTunnelProgress("");
        return true;
      }
      // Every 5 pings (~10s), check whether the backend process is still alive.
      if ((Date.now() - start) % 10000 < TUNNEL_PING_INTERVAL_MS) {
        try {
          const statusRes = await fetch("/api/tunnel/status");
          if (statusRes.ok) {
            const status = await statusRes.json();
            if (!status.tunnel?.enabled) {
              setTunnelStatus({ type: "error", message: "Tunnel process stopped unexpectedly." });
              setTunnelLoading(false);
              setTunnelProgress("");
              return false;
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
    setTunnelStatus({
      type: "error",
      message: "Tunnel created but not reachable. Please try again.",
    });
    setTunnelLoading(false);
    setTunnelProgress("");
    return false;
  };

  const handleEnableTunnel = async () => {
    setShowEnableTunnelModal(false);
    setTunnelLoading(true);
    setTunnelStatus(null);
    setTunnelProgress("Creating tunnel...");

    // Poll download progress while the enable request is pending.
    let polling = true;
    const pollProgress = async () => {
      while (polling) {
        try {
          const r = await fetch("/api/tunnel/status");
          if (r.ok) {
            const s = await r.json();
            if (s.download?.downloading) {
              setTunnelProgress(`Downloading cloudflared... ${s.download.progress}%`);
            } else if (polling) {
              setTunnelProgress("Creating tunnel...");
            }
          }
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    pollProgress();

    try {
      const res = await fetch("/api/tunnel/enable", { method: "POST" });
      polling = false;
      const data = await readJson(res);
      if (!res.ok) {
        setTunnelStatus({ type: "error", message: data?.error || "Failed to enable tunnel" });
        return;
      }

      const url = data?.tunnelUrl;
      if (!url) {
        setTunnelStatus({ type: "error", message: "No tunnel URL returned" });
        return;
      }

      setTunnelUrl(url);
      setTunnelPublicUrl(data?.publicUrl || "");
      await pingTunnelHealth(data?.publicUrl, url);
    } catch (error) {
      setTunnelStatus({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to enable tunnel",
      });
    } finally {
      polling = false;
      setTunnelLoading(false);
      setTunnelProgress("");
    }
  };

  const handleDisableTunnel = async () => {
    setTunnelLoading(true);
    setTunnelStatus(null);
    try {
      const res = await fetch("/api/tunnel/disable", { method: "POST" });
      const data = await readJson(res);
      if (res.ok) {
        setTunnelEnabled(false);
        setTunnelUrl("");
        setShowDisableTunnelModal(false);
        setTunnelStatus({ type: "success", message: "Tunnel disabled" });
      } else {
        setTunnelStatus({ type: "error", message: data?.error || "Failed to disable tunnel" });
      }
    } catch (error) {
      setTunnelStatus({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to disable tunnel",
      });
    } finally {
      setTunnelLoading(false);
    }
  };

  // ── tailscale ─────────────────────────────────────────────────────────────

  const checkTailscaleInstalled = async (): Promise<TailscaleCheck> => {
    setTsInstalled(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-check");
      if (res.ok) {
        const data = await res.json();
        setTsInstalled(data.installed);
        return data;
      }
    } catch {
      /* ignore */
    }
    setTsInstalled(false);
    return { installed: false };
  };

  const handleInstallTailscale = async () => {
    setTsInstalling(true);
    setTsStatus(null);
    setTsInstallLog([]);
    try {
      const res = await fetch("/api/tunnel/tailscale-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sudoPassword: tsSudoPassword }),
      });
      setTsSudoPassword("");
      if (!res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const frames = new ServerSentFrameReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const { event, data } of frames.push(decoder.decode(value, { stream: true }))) {
            if (!data) continue;
            if (event === "progress") {
              setTsInstallLog((prev) => [...prev.slice(-50), String(data.message ?? "")]);
            } else if (event === "done") {
              setTsInstalled(true);
              setTsInstalling(false);
              setShowTsModal(false);
              handleConnectTailscale();
              return;
            } else if (event === "error") {
              setTsStatus({ type: "error", message: String(data.error || "Install failed") });
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      setTsStatus({
        type: "error",
        message: error instanceof Error ? error.message : "Install failed",
      });
    } finally {
      setTsInstalling(false);
    }
  };

  // Ping the tailscale health endpoint until it answers or the wait budget is spent.
  const pingTsHealth = async (url: string): Promise<boolean> => {
    setTsProgress("Waiting for Tailscale ready...");
    const healthUrl = `${url}/api/health`;
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      try {
        const ping = await fetch(healthUrl, { mode: "no-cors", cache: "no-store" });
        if (ping.ok || ping.type === "opaque") return true;
      } catch {
        /* not ready yet */
      }
    }
    return false;
  };

  // Show an inline login button instead of auto-opening a popup: browsers block
  // popups opened after async work because the user gesture is lost.
  const requestUserAuth = (url: string, label: string) => {
    setTsAuthUrl(url);
    setTsAuthLabel(label);
  };

  const clearUserAuth = useCallback(() => {
    setTsAuthUrl("");
    setTsAuthLabel("");
  }, []);

  const pollFunnelEnable = async (enableUrl: string) => {
    requestUserAuth(enableUrl, "Open Funnel Settings");
    setTsProgress('Click "Open Funnel Settings" to enable Funnel...');
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
        const data = await res.json();
        if (res.ok && data.success) {
          clearUserAuth();
          setTsUrl(data.tunnelUrl || "");
          const ok3 = await pingTsHealth(data.tunnelUrl);
          setTsEnabled(true);
          setTsStatus(
            ok3 ? null : { type: "warning", message: "Connected but not reachable yet." }
          );
          return;
        }
        if (data.funnelNotEnabled) continue;
        if (data.error) {
          clearUserAuth();
          setTsStatus({ type: "error", message: data.error });
          return;
        }
      } catch {
        /* retry */
      }
    }
    clearUserAuth();
    setTsStatus({ type: "error", message: "Timed out waiting for Funnel to be enabled." });
  };

  const handleConnectTailscale = async () => {
    setShowTsModal(false);
    setTsConnecting(true);
    setTsLoading(true);
    setTsStatus(null);
    setTsProgress("Connecting...");
    clearUserAuth();
    try {
      const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
      const data = await res.json();

      if (res.ok && data.success) {
        setTsUrl(data.tunnelUrl || "");
        const reachable = await pingTsHealth(data.tunnelUrl);
        setTsEnabled(true);
        setTsStatus(
          reachable ? null : { type: "warning", message: "Connected but not reachable yet." }
        );
        return;
      }

      if (data.needsLogin && data.authUrl) {
        requestUserAuth(data.authUrl, "Open Login Page");
        setTsProgress('Login required - click "Open Login Page" to continue');
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const r2 = await fetch("/api/tunnel/tailscale-check");
            if (r2.ok) {
              const check = await r2.json();
              if (check.loggedIn) {
                clearUserAuth();
                setTsProgress("Starting funnel...");
                const res2 = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
                const data2 = await res2.json();
                if (res2.ok && data2.success) {
                  setTsUrl(data2.tunnelUrl || "");
                  const ok2 = await pingTsHealth(data2.tunnelUrl);
                  setTsEnabled(true);
                  setTsStatus(
                    ok2 ? null : { type: "warning", message: "Connected but not reachable yet." }
                  );
                } else if (data2.funnelNotEnabled && data2.enableUrl) {
                  await pollFunnelEnable(data2.enableUrl);
                } else {
                  setTsStatus({ type: "error", message: data2.error || "Failed to start funnel" });
                }
                return;
              }
            }
          } catch {
            /* retry */
          }
        }
        clearUserAuth();
        setTsStatus({ type: "error", message: "Login timed out. Please try again." });
        return;
      }

      if (data.funnelNotEnabled && data.enableUrl) {
        await pollFunnelEnable(data.enableUrl);
        return;
      }

      setTsStatus({ type: "error", message: data.error || "Failed to connect" });
    } catch (error) {
      setTsStatus({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to connect",
      });
    } finally {
      setTsLoading(false);
      setTsConnecting(false);
      setTsProgress("");
      clearUserAuth();
    }
  };

  const handleDisableTailscale = async () => {
    setTsLoading(true);
    setTsStatus(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-disable", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setTsEnabled(false);
        setTsUrl("");
        setShowDisableTsModal(false);
        setTsStatus({ type: "success", message: "Tailscale disabled" });
      } else {
        setTsStatus({ type: "error", message: data.error || "Failed to disable Tailscale" });
      }
    } catch (e) {
      setTsStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed to disable Tailscale",
      });
    } finally {
      setTsLoading(false);
    }
  };

  const handleOpenTsModal = async () => {
    setTsStatus(null);
    setTsInstallLog([]);
    const data = await checkTailscaleInstalled();
    if (data?.installed && data?.hasCachedPassword) {
      handleConnectTailscale();
    } else {
      setShowTsModal(true);
    }
  };

  return {
    tunnelChecking, tunnelEnabled, tunnelReachable, tunnelUrl, tunnelPublicUrl,
    tunnelLoading, tunnelProgress, tunnelStatus, tunnelEverReachable,
    showEnableTunnelModal, showDisableTunnelModal,
    setShowEnableTunnelModal, setShowDisableTunnelModal, setTunnelChecking,
    setTunnelLoading, setTunnelProgress, setTunnelStatus,
    handleEnableTunnel, handleDisableTunnel,

    tsEnabled, tsReachable, tsUrl, tsLoading, tsProgress, tsStatus,
    tsAuthUrl, tsAuthLabel, tsInstalled, tsInstalling, tsInstallLog, tsSudoPassword,
    tsConnecting, showTsModal, showDisableTsModal, tsEverReachable, tsLogRef,
    setShowTsModal, setShowDisableTsModal, setTsStatus, setTsSudoPassword,
    setTsLoading, setTsConnecting, setTsProgress,
    handleInstallTailscale, handleConnectTailscale, handleDisableTailscale,
    handleOpenTsModal, clearUserAuth,

    syncTunnelStatus, loadSettings,
  };
}
