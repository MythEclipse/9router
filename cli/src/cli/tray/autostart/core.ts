import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
	disableLinux,
	disableMacOS,
	disableWindows,
	enableLinux,
	enableMacOS,
	enableWindows,
} from "./platform.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const APP_NAME = "9router"
const APP_LABEL = "com.9router.autostart"

/**
 * Resolve the absolute path to this package's cli.js.
 *
 * Order of preference:
 *   1. Explicit `cliPath` argument - cleanest, used when called from running
 *      cli.js with `__filename`.
 *   2. `process.argv[1]` if it's our cli.js - true when 9router is currently
 *      running and the tray menu fires this code path.
 *   3. Compute relative to this file's own location. autostart.js lives at
 *      `<pkg>/src/cli/tray/autostart.js`, so cli.js is three levels up.
 *      This works for any global install layout (nvm, Volta, asdf, Homebrew,
 *      /usr/local, etc.) without depending on `npm bin -g` (removed in npm 9)
 *      or a hardcoded `/usr/local/...` path.
 *
 * Returns null if no candidate exists - callers should not write an autostart
 * entry pointing at a non-existent script.
 */
function getCliJsPath(cliPath) {
	if (cliPath) {
		const resolved = path.resolve(cliPath)
		if (fs.existsSync(resolved)) return resolved
	}
	if (process.argv[1]) {
		const resolved = path.resolve(process.argv[1])
		if (path.basename(resolved) === "cli" && fs.existsSync(resolved)) {
			return resolved
		}
	}
	const computed = path.resolve(__dirname, "..", "..", "..", "cli")
	if (fs.existsSync(computed)) return computed
	return null
}

/**
 * Enable auto startup on OS boot
 * @param {string} cliPath - Optional path to cli.js (defaults to auto-detect)
 * @returns {boolean} success
 */
function enableAutoStart(cliPath) {
	const platform = process.platform

	if (!["darwin", "win32", "linux"].includes(platform)) return false
	if (platform === "linux" && !process.env.DISPLAY) return false

	try {
		if (platform === "darwin") return enableMacOS(cliPath)
		if (platform === "win32") return enableWindows(cliPath)
		if (platform === "linux") return enableLinux(cliPath)
	} catch (_err) {
		// Silent fail - autostart is optional
	}
	return false
}

/**
 * Disable auto startup
 * @returns {boolean} success
 */
function disableAutoStart() {
	const platform = process.platform
	try {
		if (platform === "darwin") return disableMacOS()
		if (platform === "win32") return disableWindows()
		if (platform === "linux") return disableLinux()
	} catch (_err) {}
	return false
}

/**
 * Check if autostart is enabled.
 *
 * On macOS, both the plist file and the launchd registration must be present -
 * otherwise the tray menu would lie about the state (showing "✓ Enabled" even
 * when launchd has the agent in a failed state or hasn't loaded it).
 */
function isAutoStartEnabled() {
	const platform = process.platform

	try {
		if (platform === "darwin") {
			const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${APP_LABEL}.plist`)
			if (!fs.existsSync(plistPath)) return false
			try {
				execSync(`launchctl list ${APP_LABEL}`, {
					stdio: ["ignore", "ignore", "ignore"],
					timeout: 3000,
				})
				return true
			} catch (_e) {
				return false
			}
		} else if (platform === "win32") {
			const startupPath = path.join(
				process.env.APPDATA || "",
				"Microsoft",
				"Windows",
				"Start Menu",
				"Programs",
				"Startup",
				`${APP_NAME}.vbs`,
			)
			return fs.existsSync(startupPath)
		} else if (platform === "linux") {
			const desktopPath = path.join(os.homedir(), ".config", "autostart", `${APP_NAME}.desktop`)
			return fs.existsSync(desktopPath)
		}
	} catch (_e) {}
	return false
}

export { APP_LABEL, APP_NAME, disableAutoStart, enableAutoStart, getCliJsPath, isAutoStartEnabled }
