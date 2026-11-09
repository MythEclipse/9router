#!/usr/bin/env node

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureSqliteRuntime } from "./hooks/sqliteRuntime.js"
import { ensureTrayRuntime } from "./hooks/trayRuntime.js"
import { run as runConnect } from "./src/cli/commands/connect.js"
import { run as runShow } from "./src/cli/commands/show.js"
import { run as runXaiVideo } from "./src/cli/commands/xaiVideo.js"
import { getAppDataDir } from "./src/cli/launcher/pidKill.js"
import { stopPreviousInstance } from "./src/cli/launcher/portKill.js"
import { startServer } from "./src/cli/launcher/serverLauncher.js"
import { createSpinner } from "./src/cli/launcher/spinner.js"
import { clearScreen } from "./src/cli/utils/display.js"
import { getEndpoint } from "./src/cli/utils/endpoint.js"
import { selectMenu } from "./src/cli/utils/input.js"
import { getPidFilePath } from "./src/cli/utils/launcherProcess.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"))

async function main() {
	const args = process.argv.slice(2)

	// Subcommands (`9router xai video …`) run against an already-running gateway
	// and bypass the launcher flow (no runtime self-heal, no server spawn).
	if (args[0] === "xai" && args[1] === "video") {
		runXaiVideo(args.slice(2))
			.then((code) => process.exit(code))
			.catch((err) => {
				console.error(`❌ ${err?.message || err}`)
				process.exit(1)
			})
		return
	}

	// `9router connect <url>` configures local CLI tools against a remote server, and
	// `9router show` prints what they're currently set to — no local server, no
	// runtime deps. Usable via `npx 9router …`.
	if (args[0] === "connect" || args[0] === "show") {
		const run = args[0] === "show" ? runShow : runConnect
		run(args.slice(1))
			.then((code) => process.exit(code))
			.catch((err) => {
				console.error(`❌ ${err?.message || err}`)
				process.exit(1)
			})
		return
	}

	// Self-heal SQLite runtime deps (sql.js + better-sqlite3) into ~/.9router/runtime
	// so the server can resolve them via NODE_PATH. Best-effort — sql.js is required,
	// better-sqlite3 is optional. Logs to stderr only on failure.
	try {
		ensureSqliteRuntime({ silent: true })
	} catch {}

	// Self-heal tray runtime (systray for macOS/Linux only). Windows skipped.
	try {
		ensureTrayRuntime({ silent: true })
	} catch {}

	// Configuration constants
	const APP_NAME = pkg.name // Use from package.json
	const DEFAULT_PORT = 20128
	const DEFAULT_HOST = "0.0.0.0"

	// First non-internal IPv4 — the address remote peers actually reach when bound to 0.0.0.0.
	function getLanIp() {
		for (const ifaces of Object.values(os.networkInterfaces())) {
			for (const i of ifaces || []) {
				if (i.family === "IPv4" && !i.internal) return i.address
			}
		}
		return null
	}

	// Local URL stays "localhost"; warn separately when bound to all interfaces (network-exposed).
	function getDisplayHost() {
		return host === DEFAULT_HOST ? "localhost" : host
	}
	const _MAX_PORT_ATTEMPTS = 10
	// Identifiers for killAllAppProcesses - only kill 9router specifically
	const _PROCESS_IDENTIFIERS = [
		"9router", // Only package name - avoid killing other apps
	]

	// Parse arguments
	let port = DEFAULT_PORT
	let host = DEFAULT_HOST
	let _noBrowser = false
	let showLog = false
	let trayMode = false

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port" || args[i] === "-p") {
			port = parseInt(args[i + 1], 10) || DEFAULT_PORT
			i++
		} else if (args[i] === "--host" || args[i] === "-H") {
			host = args[i + 1] || DEFAULT_HOST
			i++
		} else if (args[i] === "--no-browser" || args[i] === "-n") {
			_noBrowser = true
		} else if (args[i] === "--log" || args[i] === "-l") {
			showLog = true
		} else if (args[i] === "--tray" || args[i] === "-t") {
			trayMode = true
			process.env.TRAY_MODE = "1"
		} else if (args[i] === "--help" || args[i] === "-h") {
			console.log(`
Usage: ${APP_NAME} [options]

Options:
  -p, --port <port>   Port to run the server (default: ${DEFAULT_PORT})
  -H, --host <host>   Host to bind (default: ${DEFAULT_HOST})
  -n, --no-browser    Don't open browser automatically
  -l, --log           Show server logs (default: hidden)
  -t, --tray          Run in system tray mode (background)
  -h, --help          Show this help message
  -v, --version       Show version

Commands:
  connect <server-url> Configure Claude Code for a remote 9router server
                      (npx 9router connect http://host:20128 — no install needed)
  show [tool…]        Show each CLI tool's current 9router config and models
                      (e.g. 9router show claude)
  xai video --prompt "..." --output video.mp4
                      Generate a Grok Imagine video via the running gateway
                      (see: ${APP_NAME} xai video --help)
`)
			process.exit(0)
		} else if (args[i] === "--version" || args[i] === "-v") {
			console.log(pkg.version)
			process.exit(0)
		}
	}

	// Always use Node.js runtime with absolute path
	const RUNTIME = process.execPath

	// Find standalone server (bundled in bin/app for published package).
	// Prefer custom-server.js (injects real socket IP) when present.
	const standaloneDir = path.join(__dirname, "app")
	const customServerPath = path.join(standaloneDir, "custom-server.js")
	const serverPath = fs.existsSync(customServerPath)
		? customServerPath
		: path.join(standaloneDir, "server.js")

	if (!fs.existsSync(serverPath)) {
		console.error("Error: Standalone build not found.")
		console.error("Please run 'npm run build:cli' first.")
		process.exit(1)
	}

	const launcherPidFile = getPidFilePath(getAppDataDir())

	// Show progress immediately rather than after the process scan: stopping a previous
	// instance used to be silent for a second or more.
	const startupSpinner = createSpinner(`Starting ${pkg.name} v${pkg.version}...`).start()
	stopPreviousInstance(port, launcherPidFile).then(() => {
		startupSpinner.stop()
		// NOTE: upstream passes its parallel update check in here. This fork has no
		// update checker, so there is no promise to hand over — startServer() takes none.
		startServer()
	})

	// Show interface selection menu
	async function showInterfaceMenu() {
		clearScreen()

		const displayHost = getDisplayHost()

		// Detect tunnel/local mode for server URL display
		let serverUrl
		try {
			const { endpoint, tunnelEnabled } = await getEndpoint(port)
			serverUrl = tunnelEnabled ? endpoint.replace(/\/v1$/, "") : `http://${displayHost}:${port}`
		} catch (_e) {
			serverUrl = `http://${displayHost}:${port}`
		}

		const subtitle = `🚀 Server: \x1b[32m${serverUrl}\x1b[0m`

		const menuItems = [
			{ label: "Web UI (Open in Browser)", icon: "🌐" },
			{ label: "Terminal UI (Interactive CLI)", icon: "💻" },
			{ label: "Hide to Tray (Background)", icon: "🔔" },
			{ label: "Exit", icon: "🚪" },
		]

		const selected = await selectMenu(`Choose Interface (v${pkg.version})`, menuItems, 0, subtitle)

		if (selected === 0) return "web"
		if (selected === 1) return "terminal"
		if (selected === 2) return "hide"
		return "exit"
	}
}

main().catch((err) => {
	console.error(`❌ ${err?.message || err}`)
	process.exitCode = 1
})
