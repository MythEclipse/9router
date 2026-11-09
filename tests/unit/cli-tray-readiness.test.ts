/**
 * The tray must never be announced before it is actually there.
 *
 * The launcher used to print "Router is now running in system tray" the moment it
 * called initTray, which is a promise the tray process never made. systray2's
 * ready() resolves only when its Go child writes one handshake line to stdout, and
 * a child that dies first — missing libappindicator3, EACCES, wrong architecture —
 * emits no 'error' event and no line. The promise then stays pending forever and
 * the user gets a success message for a tray icon that does not exist.
 *
 * tray.ts resolves systray2 through createRequire against the runtime dir, so the
 * fake is installed into a temp DATA_DIR rather than vi.mock'd: this exercises the
 * real resolveSystray path, which is the one that silently returned null before.
 */
import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const control = {
	tray: null as Record<string, any> | null,
	readyDeferred: {
		resolve: null as (() => void) | null,
		reject: null as ((e: Error) => void) | null,
	},
}

// The body of the fake systray2 entry point. Written to disk so createRequire
// loads it as a normal package, exactly as it would load the real one.
const FAKE_SYSTRAY2 = `
exports.default = class FakeSysTray {
	constructor() {
		this._binPath = "/usr/lib/systray2/tray_linux_release"
		this.onClick = () => {}
		this.sendAction = () => {}
		this.ready = () => new Promise((resolve, reject) => {
			globalThis.__trayControl.readyDeferred.resolve = resolve
			globalThis.__trayControl.readyDeferred.reject = reject
		})
	}
}
`

const realPlatform = process.platform
let tempRoot = ""
let originalDataDir: string | undefined

function setPlatform(value: string) {
	Object.defineProperty(process, "platform", { value, configurable: true })
}

async function loadTray() {
	// Fresh module per case: tray.ts keeps module-level trayInstance/isWinTray.
	vi.resetModules()
	return import("../../cli/src/cli/tray/tray.ts")
}

describe("initTray readiness contract", () => {
	beforeEach(async () => {
		control.readyDeferred.resolve = null
		control.readyDeferred.reject = null
		;(globalThis as any).__trayControl = control

		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "9router-tray-"))
		const pkgDir = path.join(tempRoot, "runtime", "node_modules", "systray2")
		await fs.mkdir(pkgDir, { recursive: true })
		await fs.writeFile(
			path.join(pkgDir, "package.json"),
			JSON.stringify({ name: "systray2", version: "1.0.0", main: "index.js" }),
		)
		await fs.writeFile(path.join(pkgDir, "index.js"), FAKE_SYSTRAY2)

		originalDataDir = process.env.DATA_DIR
		process.env.DATA_DIR = tempRoot
		process.env.DISPLAY = ":0"
		setPlatform("linux")
	})

	afterEach(async () => {
		setPlatform(realPlatform)
		if (originalDataDir === undefined) delete process.env.DATA_DIR
		else process.env.DATA_DIR = originalDataDir
		vi.useRealTimers()
		await fs.rm(tempRoot, { recursive: true, force: true })
	})

	it("reports failure instead of silently returning when there is no display", async () => {
		delete process.env.DISPLAY
		const { initTray } = await loadTray()
		const onError = vi.fn()
		const onReady = vi.fn()

		const result = initTray({ port: 20128, onReady, onError })

		expect(result).toBeNull()
		expect(onReady).not.toHaveBeenCalled()
		expect(onError).toHaveBeenCalledTimes(1)
		expect(onError.mock.calls[0][0].message).toContain("DISPLAY")
	})

	it("does not call onReady before the tray handshake arrives", async () => {
		const { initTray } = await loadTray()
		const onReady = vi.fn()

		const result = initTray({ port: 20128, onReady, onError: vi.fn() })

		expect(result).not.toBeNull()
		expect(onReady).not.toHaveBeenCalled()
	})

	it("calls onReady once the handshake arrives", async () => {
		const { initTray } = await loadTray()
		const onReady = vi.fn()
		const onError = vi.fn()

		initTray({ port: 20128, onReady, onError })
		await vi.waitFor(() => expect(control.readyDeferred.resolve).toBeTypeOf("function"))
		control.readyDeferred.resolve?.()
		await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
		expect(onError).not.toHaveBeenCalled()
	})

	it("calls onError when ready() rejects", async () => {
		const { initTray } = await loadTray()
		const onReady = vi.fn()
		const onError = vi.fn()

		initTray({ port: 20128, onReady, onError })
		await vi.waitFor(() => expect(control.readyDeferred.reject).toBeTypeOf("function"))
		control.readyDeferred.reject?.(new Error("spawn EACCES"))
		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
		expect(onError.mock.calls[0][0].message).toContain("spawn EACCES")
		expect(onReady).not.toHaveBeenCalled()
	})

	it("reports a timeout when the handshake never comes", async () => {
		vi.useFakeTimers()
		const { initTray } = await loadTray()
		const onReady = vi.fn()
		const onError = vi.fn()

		initTray({ port: 20128, onReady, onError })
		await vi.advanceTimersByTimeAsync(0)
		expect(onError).not.toHaveBeenCalled()

		// The child is dead but never told us: only the deadline can catch this.
		await vi.advanceTimersByTimeAsync(3000)

		expect(onError).toHaveBeenCalledTimes(1)
		expect(onError.mock.calls[0][0].message).toContain("no handshake")
		expect(onReady).not.toHaveBeenCalled()
	})

	it("settles exactly once — a late resolve after a timeout is ignored", async () => {
		vi.useFakeTimers()
		const { initTray } = await loadTray()
		const onReady = vi.fn()
		const onError = vi.fn()

		initTray({ port: 20128, onReady, onError })
		await vi.advanceTimersByTimeAsync(3000)
		expect(onError).toHaveBeenCalledTimes(1)

		control.readyDeferred.resolve?.()
		await vi.advanceTimersByTimeAsync(0)
		expect(onReady).not.toHaveBeenCalled()
		expect(onError).toHaveBeenCalledTimes(1)
	})
})

describe("cli.ts announces the tray only from onReady", () => {
	// cli.ts now delegates the tray handshake to cli/src/cli/**; scan the entry
	// point plus the whole CLI source tree so the invariant holds wherever it lands.
	const cliSourceFiles = (dir) =>
		fsSync.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir)
			if (entry.isDirectory()) return cliSourceFiles(child)
			return entry.name.endsWith(".ts") ? [child] : []
		})
	const src = [
		new URL("../../cli/cli.ts", import.meta.url),
		...cliSourceFiles(new URL("../../cli/src/cli/", import.meta.url)),
	]
		.map((u) => fsSync.readFileSync(u, "utf-8"))
		.join("\n")

	it("no longer prints the success message straight after initTrayIcon()", () => {
		expect(src).not.toMatch(
			/initTrayIcon\(\)\s*\r?\n\s*console\.log\("\\n💡 Router is now running in system tray/,
		)
	})

	it("prints it inside onReady and offers a dashboard fallback from onError", () => {
		expect(src).toMatch(/onReady: \(\) => \{/)
		expect(src).toContain("No tray icon")
		expect(src).toContain("the server keeps running")
	})
})
