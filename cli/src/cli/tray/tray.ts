import { isTraySupported } from "./tray/state.js"
import { initUnixTray } from "./tray/unix.js"
import { initWindowsTray } from "./tray/windows.js"

export { killTray } from "./tray/state.js"
export { initTray }

/**
 * Initialize system tray with menu
 *
 * `onReady`/`onError` are optional and fire once the tray is actually usable, or
 * provably is not. Callers must not announce a tray icon before `onReady`: the
 * systray2 child can die before it ever registers one, and a caller that prints
 * "running in system tray" up front turns every such failure into a lie.
 *
 * @param options - { port, onQuit, onOpenDashboard, onReady, onError }
 * @returns tray instance, or null if not supported/failed
 */
function initTray(options) {
	if (!isTraySupported()) {
		options.onError?.(new Error("no graphical session (DISPLAY unset)"))
		return null
	}

	// Windows uses PowerShell NotifyIcon (AV-safe), others use systray
	if (process.platform === "win32") {
		return initWindowsTray(options)
	}
	return initUnixTray(options)
}
