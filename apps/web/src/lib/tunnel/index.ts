// Cloudflare service

export {
	ensureCloudflared,
	getDownloadStatus,
	isCloudflaredRunning,
	killCloudflared,
} from "./cloudflare/cloudflared.ts"
export { probeUrlAlive as probeCloudflareAlive } from "./cloudflare/healthCheck.ts"
export {
	disableTunnel,
	enableTunnel,
	getTunnelService,
	getTunnelStatus,
	isTunnelManuallyDisabled,
	isTunnelReconnecting,
	setTunnelUnexpectedExitCallback,
} from "./cloudflare/manager.ts"
export { checkInternet } from "./shared/internetCheck.ts"
// Shared
export { generateShortId, loadState } from "./shared/state.ts"
export {
	NETWORK_CHECK_INTERVAL_MS,
	NETWORK_SETTLE_MS,
	RESTART_COOLDOWN_MS,
	VIRTUAL_IFACE_REGEX,
	WATCHDOG_INTERVAL_MS,
} from "./shared/watchdogConfig.ts"
export { probeUrlAlive as probeTailscaleAlive } from "./tailscale/healthCheck.ts"
// Tailscale service
export {
	disableTailscale,
	enableTailscale,
	getTailscaleService,
	getTailscaleStatus,
	isTailscaleReconnecting,
} from "./tailscale/manager.ts"
export {
	getTailscaleBin,
	installTailscale,
	isDaemonAlive,
	isSystemDaemonRunning,
	isTailscaleInstalled,
	isTailscaleLoggedIn,
	isTailscaleLoggedInStrict,
	isTailscaleRunning,
	isTailscaleRunningStrict,
	startDaemonWithPassword,
	startFunnel,
	startLogin,
	TAILSCALE_SOCKET,
} from "./tailscale/tailscale.ts"
