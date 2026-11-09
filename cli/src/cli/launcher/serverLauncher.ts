import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildEnvWithRuntime } from "../../../hooks/sqliteRuntime.js"
import { buildServerEnv } from "../serverEnv.js"
import { startTerminalUI } from "../terminalUI.js"
import { initTray, killTray } from "../tray/tray.js"
import { pause } from "../utils/input.js"
import { removePidRecordIfOwner, writePidRecord } from "../utils/launcherProcess.js"
import { hideToTray } from "./hideToTray.js"
import { killProxyByPidFile, killTunnelByPidFile, openBrowser } from "./pidKill.js"
import { createSpinner, waitServerReady } from "./spinner.js"

const MAX_RESTARTS = 2
const RESTART_RESET_MS = 30000 // Reset counter if alive > 30s

export function startServer(ctx) {
	const {
		port,
		host,
		showLog,
		trayMode,
		pkg,
		RUNTIME,
		standaloneDir,
		serverPath,
		launcherPidFile,
		getLanIp,
		getDisplayHost,
		showInterfaceMenu,
		__filename,
	} = ctx
	const DEFAULT_HOST = "0.0.0.0"

	const displayHost = getDisplayHost()
	const url = `http://${displayHost}:${port}/dashboard`
	// Surface real network exposure when bound to all interfaces (default 0.0.0.0).
	if (host === DEFAULT_HOST) {
		const lanIp = getLanIp()
		if (lanIp)
			console.log(
				`\x1b[33m⚠ Network-exposed: reachable at http://${lanIp}:${port} (bound 0.0.0.0). Use --host 127.0.0.1 for local-only.\x1b[0m`,
			)
	}

	let restartCount = 0
	let serverStartTime = Date.now()

	const CRASH_LOG_LINES = 50
	let crashLog = []

	function spawnServer() {
		serverStartTime = Date.now()
		crashLog = []
		const child = spawn(
			RUNTIME,
			["--dns-result-order=ipv4first", "--max-old-space-size=6144", serverPath],
			{
				cwd: standaloneDir,
				stdio: showLog ? "inherit" : ["ignore", "ignore", "pipe"],
				detached: true,
				windowsHide: true,
				env: buildServerEnv({
					baseEnv: buildEnvWithRuntime(process.env),
					port,
					host,
				}),
			},
		)
		if (!showLog && child.stderr) {
			child.stderr.on("data", (data) => {
				const lines = data.toString().split("\n").filter(Boolean)
				crashLog.push(...lines)
				if (crashLog.length > CRASH_LOG_LINES) crashLog = crashLog.slice(-CRASH_LOG_LINES)
			})
		}
		return child
	}

	let server = spawnServer()

	// Lets the next launch stop exactly this instance without a process scan.
	try {
		writePidRecord(launcherPidFile, {
			cliPid: process.pid,
			serverPid: server.pid || null,
			port,
			exe: path.basename(RUNTIME),
		})
	} catch {
		// non-fatal: next launch falls back to the port check
	}

	const bootSpinner = createSpinner("Starting server...")

	// Cleanup function - force kill server process
	let isCleaningUp = false
	function cleanup() {
		if (isCleaningUp) return
		isCleaningUp = true
		bootSpinner.stop()
		removePidRecordIfOwner(launcherPidFile, process.pid)
		try {
			// Kill tray if running
			try {
				killTray()
			} catch (_e) {}
			// Kill MIT server (privileged process) via PID file
			killProxyByPidFile()
			// Kill cloudflared/tailscale via PID file (only this app's tunnel)
			killTunnelByPidFile()
			// Kill server process directly
			if (server.pid) {
				process.kill(server.pid, "SIGKILL")
			}
			// Also try to kill process group
			process.kill(-server.pid, "SIGKILL")
		} catch (_e) {}
	}

	// Suppress all errors during shutdown (systray lib throws JSON parse errors)
	let isShuttingDown = false
	process.on("uncaughtException", (err) => {
		if (isShuttingDown) return
		console.error("Error:", err.message)
	})

	// Handle all exit scenarios
	process.on("SIGINT", () => {
		if (isShuttingDown) return
		isShuttingDown = true
		console.log("\nExiting...")
		cleanup()
		setTimeout(() => process.exit(0), 100)
	})
	process.on("SIGTERM", () => {
		if (isShuttingDown) return
		isShuttingDown = true
		cleanup()
		setTimeout(() => process.exit(0), 100)
	})
	process.on("SIGHUP", () => {
		if (isShuttingDown) return
		isShuttingDown = true
		cleanup()
		setTimeout(() => process.exit(0), 100)
	})

	// Initialize tray icon (runs alongside TUI)
	const initTrayIcon = (callbacks = {}) => {
		try {
			initTray({
				port,
				onQuit: () => {
					isShuttingDown = true
					console.log("\n👋 Shutting down from tray...")
					cleanup()
					setTimeout(() => process.exit(0), 100)
				},
				onOpenDashboard: () => openBrowser(url),
				...callbacks,
			})
		} catch (err) {
			// Tray not available - continue without it
			if (typeof callbacks.onError === "function") callbacks.onError(err)
		}
	}

	// Tray-only mode: no TUI, just tray icon
	if (trayMode) {
		// Ignore SIGHUP so macOS terminal close doesn't kill the background tray process
		process.removeAllListeners("SIGHUP")
		process.on("SIGHUP", () => {})

		console.log(`\n🚀 ${pkg.name} v${pkg.version}`)
		console.log(`Server: http://${displayHost}:${port}`)

		// Only claim the tray is running once it actually became ready. Reporting
		// it up front hid every failure (missing libappindicator, EACCES, wrong
		// architecture) behind a success message.
		bootSpinner.start()
		waitServerReady(port).then(() => {
			bootSpinner.stop()
			initTrayIcon({
				onReady: () => {
					console.log("\n💡 Router is now running in system tray. Close this terminal if you want.")
					console.log("   Right-click tray icon to open dashboard or quit.\n")
				},
				onError: (err) => {
					console.log("\n⚠️  No tray icon — the server keeps running.")
					if (err?.message) console.log(`   ${err.message.split("\n").join("\n   ")}`)
					console.log(`   Dashboard: http://${displayHost}:${port}\n`)
				},
			})
		})

		return
	}

	// Wait for server to be ready, then show interface menu loop + tray
	bootSpinner.start()
	waitServerReady(port).then(async () => {
		bootSpinner.stop()
		// Start tray icon alongside TUI
		initTrayIcon()

		try {
			while (true) {
				const choice = await showInterfaceMenu()

				if (choice === "web") {
					openBrowser(url)
					// Wait for user to come back
					await pause("\nPress Enter to go back to menu...")
				} else if (choice === "terminal") {
					// Start Terminal UI - it will return when user selects Back
					await startTerminalUI(port)
					// Loop continues, show menu again
				} else if (choice === "hide") {
					if (await hideToTray({ port, displayHost, __filename, cleanup })) return
				} else if (choice === "exit") {
					isShuttingDown = true
					console.log("\nExiting...")
					cleanup()
					setTimeout(() => process.exit(0), 100)
				}
			}
		} catch (err) {
			console.error("Error:", err.message)
			cleanup()
			process.exit(1)
		}
	})

	function attachServerEvents() {
		server.on("error", (err) => {
			console.error("Failed to start server:", err.message)
			if (!isShuttingDown) tryRestart()
			else {
				cleanup()
				process.exit(1)
			}
		})

		server.on("close", (code) => {
			if (isShuttingDown || code === 0) {
				process.exit(code || 0)
				return
			}
			tryRestart(code)
		})
	}

	function tryRestart(code) {
		const aliveMs = Date.now() - serverStartTime
		// Reset counter if last run was stable
		if (aliveMs >= RESTART_RESET_MS) restartCount = 0

		if (restartCount >= MAX_RESTARTS) {
			console.error(`\n⚠️  Server crashed ${MAX_RESTARTS} times. Disabling MIT and restarting...`)
			try {
				const dbPath = path.join(
					os.homedir(),
					process.platform === "win32"
						? path.join("AppData", "Roaming", "9router", "db.json")
						: path.join(".9router", "db.json"),
				)
				if (fs.existsSync(dbPath)) {
					const db = JSON.parse(fs.readFileSync(dbPath, "utf-8"))
					if (db.settings) db.settings.mitmEnabled = false
					fs.writeFileSync(dbPath, JSON.stringify(db, null, 2))
				}
			} catch {
				/* best effort */
			}
			restartCount = 0
			server = spawnServer()
			attachServerEvents()
			return
		}

		restartCount++
		const delay = Math.min(1000 * restartCount, 10000)
		console.error(
			`\n⚠️  Server exited (code=${code ?? "unknown"}). Restarting in ${delay / 1000}s... (${restartCount}/${MAX_RESTARTS})`,
		)
		if (crashLog.length) {
			console.error("\n--- Server crash log ---")
			crashLog.forEach((l) => console.error(l))
			console.error("--- End crash log ---\n")
		}

		setTimeout(() => {
			server = spawnServer()
			attachServerEvents()
		}, delay)
	}

	attachServerEvents()
}
