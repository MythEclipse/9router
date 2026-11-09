import { exec } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { disableAutoStart, enableAutoStart, isAutoStartEnabled } from "../autostart.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const trayState = { instance: null, isWin: false }

// How long to wait for systray2's Go child to write its stdout handshake before
// treating the tray as failed.
const TRAY_READY_TIMEOUT_MS = 3000

/**
 * Get icon base64 from file - used for systray (mac/linux)
 */
function getIconBase64() {
	const isWin = process.platform === "win32"
	const iconFile = isWin ? "icon.ico" : "icon.png"
	try {
		const iconPath = path.join(__dirname, iconFile)
		if (fs.existsSync(iconPath)) {
			return fs.readFileSync(iconPath).toString("base64")
		}
	} catch (_e) {}
	// Fallback: minimal green dot icon (PNG)
	return "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAALEwAACxMBAJqcGAAAAHpJREFUOE9jYBgFgwEwMjIy/Gdg+P8fyP4PxP8ZGBgEcBnGyMjIsICBgSEAhyH/gfgBUNN8XJoZsdkCVL8Ah+b/QPwbqvkBMvk/AwMDAzYX/GdgYAhAN+A/SICRWAMYGfFEJSMjzriEiwDR/xmIa2RkZCSqnZERb3QCAAo3KxzxbKe1AAAAAElFTkSuQmCC"
}

/**
 * Check if system tray is supported on current OS
 * Supported: macOS, Windows, Linux (with GUI)
 */
function isTraySupported() {
	const platform = process.platform
	if (!["darwin", "win32", "linux"].includes(platform)) {
		return false
	}
	if (platform === "linux" && !process.env.DISPLAY) {
		return false
	}
	return true
}

/**
 * Build menu items array shared between platforms
 */
function buildMenuItems(port, autostartEnabled) {
	return [
		{ title: `9Router (Port ${port})`, tooltip: "Server is running", enabled: false },
		{ title: "Open Dashboard", tooltip: "Open in browser", enabled: true },
		{
			title: autostartEnabled ? "✓ Auto-start Enabled" : "Enable Auto-start",
			tooltip: "Run on OS startup",
			enabled: true,
		},
		{ title: "Quit", tooltip: "Stop server and exit", enabled: true },
	]
}

// Menu item indexes
const MENU_INDEX = { STATUS: 0, DASHBOARD: 1, AUTOSTART: 2, QUIT: 3 }

/**
 * Get current autostart state
 */
function getAutostartEnabled() {
	try {
		return isAutoStartEnabled()
	} catch (_e) {
		return false
	}
}

/**
 * Handle menu item click (shared logic)
 */
function handleClick(index, options, onAutostartToggle) {
	const { onQuit, onOpenDashboard, port } = options
	if (index === MENU_INDEX.DASHBOARD) {
		if (onOpenDashboard) onOpenDashboard()
		else openBrowser(`http://localhost:${port}/dashboard`)
	} else if (index === MENU_INDEX.AUTOSTART) {
		const enabled = getAutostartEnabled()
		try {
			if (enabled) disableAutoStart()
			else enableAutoStart()
			onAutostartToggle(!enabled)
		} catch (_e) {}
	} else if (index === MENU_INDEX.QUIT) {
		console.log("\n👋 Shutting down...")
		if (onQuit) onQuit()
		killTray()
		setTimeout(() => process.exit(0), 500)
	}
}

/**
 * Open browser
 */
function openBrowser(url) {
	const platform = process.platform
	let cmd

	if (platform === "darwin") {
		cmd = `open "${url}"`
	} else if (platform === "win32") {
		cmd = `start "" "${url}"`
	} else {
		cmd = `xdg-open "${url}"`
	}

	exec(cmd)
}

/**
 * Kill tray, wait Go binary fully exit (returns Promise).
 * Critical for hide-to-tray: macOS must release NSStatusItem before bgProcess
 * spawns a new tray, otherwise the new icon silently fails to register.
 */
function killTray() {
	const instance = trayState.instance
	const wasWin = trayState.isWin
	trayState.instance = null
	if (!instance) return Promise.resolve()

	if (wasWin) {
		try {
			instance.kill()
		} catch (_e) {}
		return Promise.resolve()
	}

	// Unix: get the Go tray child process handle.
	let proc = null
	try {
		proc = instance._process || (typeof instance.process === "function" ? instance.process() : null)
	} catch (_e) {}

	// Graceful shutdown: send {type:"exit"} via IPC so the Go binary can call
	// systray.Quit() and release NSStatusItem. SIGKILL leaves a ghost icon on
	// the macOS menubar until logout, causing duplicate icons after re-spawn.
	const gracefulQuit = () => {
		try {
			instance.kill(true)
		} catch (_e) {}
	}
	const closeIpc = () => {
		try {
			instance.kill(false)
		} catch (_e) {}
	}

	if (!proc || !proc.pid) {
		gracefulQuit()
		closeIpc()
		return Promise.resolve()
	}

	return new Promise((resolve) => {
		let done = false
		const finish = () => {
			if (done) return
			done = true
			closeIpc()
			resolve()
		}

		proc.once("exit", finish)
		gracefulQuit()

		// Escalate: SIGTERM after 800ms, SIGKILL after 1600ms if still alive.
		setTimeout(() => {
			try {
				process.kill(proc.pid, 0)
				proc.kill("SIGTERM")
			} catch (_e) {}
		}, 800)
		setTimeout(() => {
			try {
				process.kill(proc.pid, 0)
				proc.kill("SIGKILL")
			} catch (_e) {}
		}, 1600)

		// Fallback poll in case "exit" never fires (detached child, pipe closed)
		const deadline = Date.now() + 3000
		const poll = setInterval(() => {
			try {
				process.kill(proc.pid, 0)
			} catch {
				clearInterval(poll)
				finish()
				return
			}
			if (Date.now() > deadline) {
				clearInterval(poll)
				finish()
			}
		}, 50)
	})
}

export {
	buildMenuItems,
	getAutostartEnabled,
	getIconBase64,
	handleClick,
	isTraySupported,
	killTray,
	MENU_INDEX,
	openBrowser,
	TRAY_READY_TIMEOUT_MS,
}
