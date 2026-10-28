import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { DATA_DIR } from "@9router/db/shared/dataDir"
import {
	EXTRA_MARKERS,
	findHeadroomBinary,
	findPython310,
	getInstalledHeadroomExtras,
	HEADROOM_COMPRESSION_EXTRAS,
} from "./detect.ts"

const HEADROOM_DIR = path.join(DATA_DIR, "headroom")
const PID_FILE = path.join(HEADROOM_DIR, "proxy.pid")
const LOG_FILE = path.join(HEADROOM_DIR, "proxy.log")
const INSTALL_LOG_FILE = path.join(HEADROOM_DIR, "install.log")
const DEFAULT_PORT = 8787
const STARTUP_TIMEOUT_MS = 8000

function ensureDir() {
	if (!fs.existsSync(HEADROOM_DIR)) fs.mkdirSync(HEADROOM_DIR, { recursive: true })
}

function readPid(): number | null {
	try {
		if (fs.existsSync(PID_FILE)) return parseInt(fs.readFileSync(PID_FILE, "utf8"), 10)
	} catch {
		/* ignore */
	}
	return null
}

function writePid(pid: number): void {
	ensureDir()
	fs.writeFileSync(PID_FILE, String(pid))
}

function clearPid() {
	try {
		if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE)
	} catch {
		/* ignore */
	}
}

// process.kill throws if pid is dead - use this to probe.
export function isPidAlive(pid: number | null | undefined): boolean {
	if (!pid || typeof pid !== "number") return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

export function getManagedPid(): number | null {
	const pid = readPid()
	return pid && isPidAlive(pid) ? pid : null
}

// Build proxy CLI flags for the active compression extras. `[code]` (AST
// compression) is off by default in headroom → pass --code-aware to turn it on;
// `[ml]` (Kompress) is on by default → pass --disable-kompress to turn it off.
function extrasProxyArgs({
	codeAware = false,
	kompress = true,
}: {
	codeAware?: boolean
	kompress?: boolean
} = {}): string[] {
	const args: string[] = []
	if (codeAware) args.push("--code-aware")
	if (kompress === false) args.push("--disable-kompress")
	return args
}

export async function startHeadroomProxy({
	port = DEFAULT_PORT,
	codeAware = false,
	kompress = true,
}: {
	port?: number
	codeAware?: boolean
	kompress?: boolean
} = {}): Promise<{
	pid: number
	alreadyRunning?: boolean
}> {
	const safePort = Number(port) > 0 && Number(port) < 65536 ? Number(port) : DEFAULT_PORT
	const binary = findHeadroomBinary()
	if (!binary) {
		throw Object.assign(new Error("Headroom CLI not installed"), { code: "NOT_INSTALLED" })
	}

	const existing = getManagedPid()
	if (existing) return { pid: existing, alreadyRunning: true }

	ensureDir()
	// spawn stdio requires fd numbers, not WriteStream objects.
	const outFd = fs.openSync(LOG_FILE, "a")

	const args = ["proxy", "--port", String(safePort), ...extrasProxyArgs({ codeAware, kompress })]
	const child = spawn(binary, args, {
		stdio: ["ignore", outFd, outFd],
		detached: true,
		windowsHide: true,
		env: { ...process.env },
	})

	if (!child.pid) {
		fs.closeSync(outFd)
		throw Object.assign(new Error("Failed to spawn headroom proxy"), { code: "SPAWN_FAILED" })
	}

	child.unref()
	writePid(child.pid)

	// Wait until the process either stays alive briefly (success) or exits fast (failure).
	await new Promise((resolve, reject) => {
		const startupTimer = setTimeout(() => {
			if (isPidAlive(child.pid)) resolve(undefined)
			else reject(new Error("headroom proxy exited during startup - see proxy.log"))
		}, STARTUP_TIMEOUT_MS)

		child.once("exit", (code) => {
			clearTimeout(startupTimer)
			clearPid()
			fs.closeSync(outFd)
			reject(
				Object.assign(new Error(`headroom proxy exited early (code=${code}) - see proxy.log`), {
					code: "EARLY_EXIT",
				}),
			)
		})
	})

	// Close parent's copy of the fd; child retains its own after unref.
	fs.closeSync(outFd)

	return { pid: child.pid, alreadyRunning: false }
}

export function stopHeadroomProxy() {
	const pid = getManagedPid()
	if (!pid) return { stopped: false, reason: "not_running" }
	try {
		process.kill(pid, "SIGTERM")
		// Give it a moment, then force if still alive.
		setTimeout(() => {
			if (isPidAlive(pid)) {
				try {
					process.kill(pid, "SIGKILL")
				} catch {
					/* already gone */
				}
			}
		}, 2000)
		clearPid()
		return { stopped: true, pid }
	} catch (e) {
		clearPid()
		throw Object.assign(
			new Error(`Failed to stop headroom proxy: ${e instanceof Error ? e.message : e}`),
			{ code: "STOP_FAILED" },
		)
	}
}

// Stop the managed proxy (if any), wait for the pid to die, then start again
// with the given flags. Used when toggling active extras that require a restart.
export async function restartHeadroomProxy(opts = {}) {
	const pid = getManagedPid()
	if (pid) {
		try {
			process.kill(pid, "SIGTERM")
		} catch {
			/* already gone */
		}
		// Wait up to ~3s for graceful exit, force-kill if still alive.
		for (let i = 0; i < 30 && isPidAlive(pid); i++) {
			await new Promise((r) => setTimeout(r, 100))
		}
		if (isPidAlive(pid)) {
			try {
				process.kill(pid, "SIGKILL")
			} catch {
				/* already gone */
			}
			await new Promise((r) => setTimeout(r, 300))
		}
		clearPid()
	}
	return startHeadroomProxy(opts)
}

export function getHeadroomLogTail(maxLines = 200) {
	try {
		if (!fs.existsSync(LOG_FILE)) return ""
		const content = fs.readFileSync(LOG_FILE, "utf8")
		const lines = content.split(/\r?\n/).filter(Boolean)
		return lines.slice(-maxLines).join("\n")
	} catch {
		return ""
	}
}

// Install (or upgrade) headroom-ai with the requested compression extras.
// `extras` is a whitelist from HEADROOM_COMPRESSION_EXTRAS - anything else
// is rejected to keep the install surface predictable. Always installs the
// `proxy` base + whatever extras the user picked, regardless of what is
// already present.
export async function installHeadroomExtras(extras = []) {
	const requested = Array.isArray(extras)
		? extras.filter((e) => HEADROOM_COMPRESSION_EXTRAS.includes(e))
		: []
	const py = findPython310()
	if (!py) {
		throw Object.assign(new Error("Python >= 3.10 not found"), { code: "NO_PYTHON" })
	}
	if (!findHeadroomBinary()) {
		throw Object.assign(
			new Error("headroom-ai not installed (run `pip install headroom-ai[proxy]` first)"),
			{ code: "NOT_INSTALLED" },
		)
	}
	// pip install string is built from a closed set (HEADROOM_COMPRESSION_EXTRAS),
	// so it cannot be poisoned by caller input - the comma-list is a fixed
	// ['proxy', ...requested]. No shell interpolation.
	const extrasList = ["proxy", ...requested].join(",")
	const spec = `headroom-ai[${extrasList}]`
	const args = ["-m", "pip", "install", "--upgrade", spec]

	ensureDir()
	// Truncate ("w") so the log reflects only the current install for live progress.
	const outFd = fs.openSync(INSTALL_LOG_FILE, "w")
	const child = spawn(py, args, {
		stdio: ["ignore", outFd, outFd],
		windowsHide: true,
		env: { ...process.env },
	})

	return new Promise((resolve, reject) => {
		child.once("error", (e) => {
			fs.closeSync(outFd)
			reject(e)
		})
		child.once("exit", (code) => {
			fs.closeSync(outFd)
			if (code === 0) {
				const status = getInstalledHeadroomExtras(py)
				resolve({ success: true, code, spec, extras: requested, ...status })
			} else {
				reject(
					Object.assign(new Error(`pip install exited with code=${code} - see headroom/install.log`), {
						code: "INSTALL_FAILED",
					}),
				)
			}
		})
	})
}

// Uninstall the marker packages that back a single extra (e.g. `ml` → torch,
// huggingface-hub). `headroom-ai` base and the `proxy` extra are never removed.
export async function uninstallHeadroomExtras(extras = []) {
	const requested = Array.isArray(extras)
		? extras.filter((e) => HEADROOM_COMPRESSION_EXTRAS.includes(e))
		: []
	const py = findPython310()
	if (!py) {
		throw Object.assign(new Error("Python >= 3.10 not found"), { code: "NO_PYTHON" })
	}
	const pkgs = [...new Set(requested.flatMap((e) => EXTRA_MARKERS[e] || []))]
	if (pkgs.length === 0) {
		throw Object.assign(new Error("No valid extras to remove"), { code: "INVALID_EXTRAS" })
	}
	const args = ["-m", "pip", "uninstall", "-y", ...pkgs]

	ensureDir()
	const outFd = fs.openSync(INSTALL_LOG_FILE, "w")
	const child = spawn(py, args, {
		stdio: ["ignore", outFd, outFd],
		windowsHide: true,
		env: { ...process.env },
	})

	return new Promise((resolve, reject) => {
		child.once("error", (e) => {
			fs.closeSync(outFd)
			reject(e)
		})
		child.once("exit", (code) => {
			fs.closeSync(outFd)
			if (code === 0) {
				const status = getInstalledHeadroomExtras(py)
				resolve({ success: true, code, removed: pkgs, extras: requested, ...status })
			} else {
				reject(
					Object.assign(new Error(`pip uninstall exited with code=${code} - see headroom/install.log`), {
						code: "UNINSTALL_FAILED",
					}),
				)
			}
		})
	})
}

// Read the tail of the install/uninstall log for live progress in the UI.
export function getInstallLogTail(maxLines = 15) {
	try {
		if (!fs.existsSync(INSTALL_LOG_FILE)) return ""
		const lines = fs.readFileSync(INSTALL_LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean)
		return lines.slice(-maxLines).join("\n")
	} catch {
		return ""
	}
}
