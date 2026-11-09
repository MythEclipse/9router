import { exec, execFileSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getRuntimeNodeModules } from "../../../../hooks/sqliteRuntime.js"
import {
	buildMenuItems,
	getAutostartEnabled,
	getIconBase64,
	handleClick,
	MENU_INDEX,
	TRAY_READY_TIMEOUT_MS,
	trayState,
} from "./state.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/**
 * macOS/Linux tray via systray binary
 *
 * Prefers `systray2`, the active fork of `systray`. Both ship only an x86_64
 * `tray_darwin_release` and select it by process.platform alone, so on Apple
 * Silicon the tray runs under Rosetta 2 and fails with EBADARCH when Rosetta is
 * absent. hooks/trayRuntime.js overlays a native arm64 build over that file to
 * avoid the dependency; the fallbacks below are Intel-only.
 *
 * Falls back to legacy `systray@1.0.5` if systray2 is unavailable, though that
 * binary's Mach-O headers are rejected by modern dyld and no icon will appear.
 */
function resolveSystray() {
	let runtimeDir = null
	try {
		runtimeDir = getRuntimeNodeModules()
	} catch (_e) {}

	// 1) systray2 in runtime dir (where ensureTrayRuntime installs it)
	if (runtimeDir) {
		try {
			return { mod: require(path.join(runtimeDir, "systray2")).default, isV2: true }
		} catch (_e) {}
	}
	// 2) systray2 resolvable from the package's own node_modules / NODE_PATH
	try {
		return { mod: require("systray2").default, isV2: true }
	} catch (_e) {}
	// 3) Legacy systray fallback (unlikely to render on modern macOS)
	try {
		return { mod: require("systray").default, isV2: false }
	} catch (_e) {}
	if (runtimeDir) {
		try {
			return { mod: require(path.join(runtimeDir, "systray")).default, isV2: false }
		} catch (_e) {}
	}
	return null
}

function chmodTrayBin(pkgName) {
	// systray2's npm tarball occasionally lands without +x on the bundled Go
	// binary (observed on macOS). spawn() then fails with EACCES. Best-effort
	// chmod on every init avoids a hard-to-diagnose silent tray failure.
	try {
		const binName = process.platform === "darwin" ? "tray_darwin_release" : "tray_linux_release"
		const candidates = [
			path.join(getRuntimeNodeModules(), pkgName, "traybin", binName),
			path.join(__dirname, "..", "..", "..", "node_modules", pkgName, "traybin", binName),
		]
		for (const p of candidates) {
			if (fs.existsSync(p)) fs.chmodSync(p, 0o755)
		}
	} catch (_e) {}
}

/**
 * Shared libraries the tray binary needs but cannot load.
 *
 * `ldd` prints "<soname> => not found" for each one. Empty when ldd is missing,
 * times out, or the binary is fine — this is a diagnostic, never a gate.
 */
function missingSharedLibs(binPath) {
	try {
		const out = execFileSync("ldd", [binPath], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		})
		return out
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.endsWith("not found"))
			.map((line) => line.split(/\s+/)[0])
	} catch (_e) {
		return []
	}
}

/**
 * Turn a dead Linux tray child into something the user can act on.
 *
 * systray2's bundled Go binary links libappindicator3.so.1 (the Ubuntu ABI).
 * Distros that ship only the maintained libayatana fork (Arch, for one) expose
 * the same symbols under libayatana-appindicator3.so.1, so ld.so aborts the
 * child with exit 127 before it writes its handshake: systray2's ready() never
 * settles and the tray silently never appears.
 *
 * Returns null when there is nothing useful to say.
 */
function linuxTrayHint(binPath) {
	if (process.platform !== "linux" || !binPath) return null
	const missing = missingSharedLibs(binPath)
	if (missing.length === 0) return null

	const lines = [`  missing shared libraries: ${missing.join(", ")}`]
	if (missing.includes("libappindicator3.so.1")) {
		lines.push(
			"  Some distros (Arch, for example) ship only the libayatana fork, which is",
			"  ABI-compatible. Install your distro's libappindicator3 package, or link it:",
			"    sudo ln -s /usr/lib/libayatana-appindicator3.so.1 /usr/lib/libappindicator3.so.1",
		)
	}
	return lines.join("\n")
}

function initUnixTray(options) {
	const { port } = options
	try {
		const resolved = resolveSystray()
		if (!resolved) return null
		const { mod: SysTray, isV2 } = resolved

		chmodTrayBin(isV2 ? "systray2" : "systray")

		const autostartEnabled = getAutostartEnabled()
		const items = buildMenuItems(port, autostartEnabled)

		const menu = {
			icon: getIconBase64(),
			// The bundled icon.png is a full-color RGBA logo. Don't mark it as a
			// template icon: macOS would then render it as a solid white square
			// because template mode only uses the alpha channel.
			isTemplateIcon: false,
			title: "",
			tooltip: `9Router - Port ${port}`,
			items,
		}

		trayState.instance = new SysTray({ menu, debug: false, copyDir: true })
		trayState.isWin = false

		trayState.instance.onClick((action) => {
			handleClick(action.seq_id, options, (newEnabled) => {
				trayState.instance.sendAction({
					type: "update-item",
					item: {
						title: newEnabled ? "✓ Auto-start Enabled" : "Enable Auto-start",
						tooltip: "Run on OS startup",
						enabled: true,
					},
					seq_id: MENU_INDEX.AUTOSTART,
				})
			})
		})

		if (isV2) {
			// systray2 resolves ready() only once the Go child writes its single
			// handshake line to stdout. A child that dies before that (missing shared
			// library, EACCES, wrong architecture) emits no 'error' event and no line,
			// so the promise stays pending forever while the caller announces a tray
			// icon that isn't there. Bound it with a timeout.
			let settled = false
			const reportFailure = (err) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				const hint = linuxTrayHint(trayState.instance?._binPath)
				options.onError?.(hint ? new Error(`${err.message}\n${hint}`) : err)
			}
			const timer = setTimeout(
				() =>
					reportFailure(
						new Error(`no handshake from the tray process within ${TRAY_READY_TIMEOUT_MS}ms`),
					),
				TRAY_READY_TIMEOUT_MS,
			)

			trayState.instance
				.ready()
				.then(() => {
					if (settled) return
					settled = true
					clearTimeout(timer)
					options.onReady?.()
				})
				.catch(reportFailure)
		} else {
			trayState.instance.onReady(() => options.onReady?.())
			trayState.instance.onError(() => {})
		}

		return trayState.instance
	} catch (err) {
		process.stderr.write(`[9router] tray init error: ${err.message}\n`)
		options.onError?.(err)
		return null
	}
}

export { initUnixTray }
