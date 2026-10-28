// Cloudflare service
export {
  enableTunnel,
  disableTunnel,
  getTunnelStatus,
  isTunnelManuallyDisabled,
  isTunnelReconnecting,
  getTunnelService,
  setTunnelUnexpectedExitCallback,
} from "./cloudflare/manager.ts";
export {
  killCloudflared,
  isCloudflaredRunning,
  ensureCloudflared,
  getDownloadStatus,
} from "./cloudflare/cloudflared.ts";
export { probeUrlAlive as probeCloudflareAlive } from "./cloudflare/healthCheck.ts";

// Tailscale service
export {
  enableTailscale,
  disableTailscale,
  getTailscaleStatus,
  isTailscaleReconnecting,
  getTailscaleService,
} from "./tailscale/manager.ts";
export {
  isTailscaleInstalled,
  isTailscaleRunning,
  isTailscaleRunningStrict,
  isTailscaleLoggedIn,
  isTailscaleLoggedInStrict,
  isSystemDaemonRunning,
  isDaemonAlive,
  startFunnel,
  getTailscaleBin,
  installTailscale,
  startLogin,
  startDaemonWithPassword,
  TAILSCALE_SOCKET,
} from "./tailscale/tailscale.ts";
export { probeUrlAlive as probeTailscaleAlive } from "./tailscale/healthCheck.ts";

// Shared
export { loadState, generateShortId } from "./shared/state.ts";
export { checkInternet } from "./shared/internetCheck.ts";
export {
  RESTART_COOLDOWN_MS,
  NETWORK_SETTLE_MS,
  WATCHDOG_INTERVAL_MS,
  NETWORK_CHECK_INTERVAL_MS,
  VIRTUAL_IFACE_REGEX,
} from "./shared/watchdogConfig.ts";
