/**
 * The launcher's fast previous-instance path.
 *
 * Every launch used to scan the whole machine for 9router processes — a PowerShell
 * WMI query per call on Windows, ~0.5s each. Recording the PIDs instead makes the
 * next launch O(1), and the full scan survives only as a fallback for a port still
 * held afterwards.
 *
 * The dangerous part is that a PID record outlives the process it names, so a
 * recycled PID would have the launcher kill a stranger. These cases pin the guard:
 * the recorded executable must still match before anything is signalled.
 */

import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	getPidFilePath,
	isPidAlive,
	isPortInUse,
	processMatchesExe,
	readPidRecord,
	removePidRecordIfOwner,
	stopRecordedInstance,
	waitForPidsExit,
	waitForPortFree,
	writePidRecord,
} from "../../cli/src/cli/utils/launcherProcess.ts"

const EXE = path.basename(process.execPath)

function listen(): Promise<net.Server> {
	return new Promise((resolve) => {
		const server = net.createServer()
		server.listen(0, "127.0.0.1", () => resolve(server))
	})
}

function portOf(server: net.Server): number {
	const address = server.address()
	if (!address || typeof address === "string") throw new Error("no port")
	return address.port
}

function close(server: net.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()))
}

describe("launcher PID record", () => {
	let dir: string
	let file: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-pid-"))
		file = getPidFilePath(path.join(dir, "nested"))
	})
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

	it("places the record under the data dir", () => {
		expect(file).toBe(path.join(dir, "nested", "launcher.pid"))
	})

	it("round-trips a record and creates the data dir", () => {
		const record = { cliPid: 111, serverPid: 222, port: 20128, exe: EXE }
		writePidRecord(file, record)
		expect(readPidRecord(file)).toEqual(record)
	})

	it("returns null when the record is missing", () => {
		expect(readPidRecord(file)).toBeNull()
	})

	it("returns null for malformed JSON", () => {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, "{not json")
		expect(readPidRecord(file)).toBeNull()
	})

	it("returns null when PIDs are not positive integers", () => {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, JSON.stringify({ cliPid: "1; rm -rf /", serverPid: -4, exe: EXE }))
		expect(readPidRecord(file)).toBeNull()
	})

	it("drops an invalid serverPid but keeps a valid cliPid", () => {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, JSON.stringify({ cliPid: 5, serverPid: "x", port: 1, exe: EXE }))
		expect(readPidRecord(file)).toEqual({ cliPid: 5, serverPid: null, port: 1, exe: EXE })
	})

	it("returns null when the record carries no executable to check", () => {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, JSON.stringify({ cliPid: 5, serverPid: 6, port: 1 }))
		expect(readPidRecord(file)).toBeNull()
	})

	it("removes the record only for its owner", () => {
		writePidRecord(file, { cliPid: 111, serverPid: 222, port: 1, exe: EXE })
		removePidRecordIfOwner(file, 999)
		expect(fs.existsSync(file)).toBe(true)
		removePidRecordIfOwner(file, 111)
		expect(fs.existsSync(file)).toBe(false)
	})
})

describe("isPidAlive", () => {
	it("is true for the current process", () => {
		expect(isPidAlive(process.pid)).toBe(true)
	})

	it("is false when the signal probe reports ESRCH", () => {
		const kill = () => {
			const e = new Error("no such process") as NodeJS.ErrnoException
			e.code = "ESRCH"
			throw e
		}
		expect(isPidAlive(1234, { kill })).toBe(false)
	})

	it("is true when the probe reports EPERM (alive, owned by another user)", () => {
		const kill = () => {
			const e = new Error("not permitted") as NodeJS.ErrnoException
			e.code = "EPERM"
			throw e
		}
		expect(isPidAlive(1234, { kill })).toBe(true)
	})

	it("is false for invalid PIDs without probing", () => {
		const kill = () => {
			throw new Error("should not be called")
		}
		expect(isPidAlive(0, { kill })).toBe(false)
		expect(isPidAlive(-1, { kill })).toBe(false)
		expect(isPidAlive(1.5, { kill })).toBe(false)
	})
})

describe("stopRecordedInstance", () => {
	const deps = (overrides = {}) => {
		const killed: number[] = []
		return {
			killed,
			opts: {
				selfPid: 1,
				isAlive: () => true,
				matchesExe: () => true,
				killPid: (pid: number) => killed.push(pid),
				...overrides,
			},
		}
	}

	it("kills the recorded server and CLI, server first", () => {
		const { killed, opts } = deps()
		const result = stopRecordedInstance({ cliPid: 10, serverPid: 20, port: null, exe: EXE }, opts)
		expect(killed).toEqual([20, 10])
		expect(result).toEqual([20, 10])
	})

	it("never kills itself", () => {
		const { killed, opts } = deps({ selfPid: 10 })
		stopRecordedInstance({ cliPid: 10, serverPid: 20, port: null, exe: EXE }, opts)
		expect(killed).toEqual([20])
	})

	it("skips PIDs that are no longer alive", () => {
		const { killed, opts } = deps({ isAlive: (pid: number) => pid === 20 })
		stopRecordedInstance({ cliPid: 10, serverPid: 20, port: null, exe: EXE }, opts)
		expect(killed).toEqual([20])
	})

	it("skips a reused PID that now belongs to a different program", () => {
		const { killed, opts } = deps({ matchesExe: (pid: number) => pid !== 10 })
		stopRecordedInstance({ cliPid: 10, serverPid: 20, port: null, exe: EXE }, opts)
		expect(killed).toEqual([20])
	})

	it("does nothing for a null record", () => {
		const { killed, opts } = deps()
		expect(stopRecordedInstance(null, opts)).toEqual([])
		expect(killed).toEqual([])
	})

	it("keeps going when one kill throws", () => {
		const { opts } = deps({
			killPid: (pid: number) => {
				if (pid === 20) throw new Error("denied")
			},
		})
		expect(stopRecordedInstance({ cliPid: 10, serverPid: 20, port: null, exe: EXE }, opts)).toEqual([
			10,
		])
	})
})

describe("processMatchesExe", () => {
	it("recognises the current process by its executable name", () => {
		expect(processMatchesExe(process.pid, EXE)).toBe(true)
	})

	it("rejects the current process for a different executable name", () => {
		expect(processMatchesExe(process.pid, "definitely-not-this.exe")).toBe(false)
	})

	it("rejects a missing executable name", () => {
		expect(processMatchesExe(process.pid, "")).toBe(false)
	})
})

describe("port helpers", () => {
	it("isPortInUse is true for a listening port and false once closed", async () => {
		const server = await listen()
		const port = portOf(server)
		expect(await isPortInUse(port)).toBe(true)
		await close(server)
		expect(await isPortInUse(port)).toBe(false)
	})

	it("waitForPortFree resolves immediately when the port is already free", async () => {
		const server = await listen()
		const port = portOf(server)
		await close(server)
		const start = Date.now()
		expect(await waitForPortFree(port, { timeoutMs: 2000 })).toBe(true)
		expect(Date.now() - start).toBeLessThan(400)
	})

	it("waitForPortFree resolves as soon as the port is released", async () => {
		const server = await listen()
		const port = portOf(server)
		setTimeout(() => server.close(), 200)
		const start = Date.now()
		expect(await waitForPortFree(port, { timeoutMs: 3000, intervalMs: 50 })).toBe(true)
		const elapsed = Date.now() - start
		expect(elapsed).toBeGreaterThanOrEqual(150)
		expect(elapsed).toBeLessThan(1500)
	})

	it("waitForPortFree gives up after the timeout", async () => {
		const server = await listen()
		const port = portOf(server)
		try {
			expect(await waitForPortFree(port, { timeoutMs: 300, intervalMs: 50 })).toBe(false)
		} finally {
			await close(server)
		}
	})
})

describe("waitForPidsExit", () => {
	it("resolves immediately when nothing is alive", async () => {
		const start = Date.now()
		expect(await waitForPidsExit([1, 2], { isAlive: () => false })).toBe(true)
		expect(Date.now() - start).toBeLessThan(100)
	})

	it("resolves once all PIDs exit", async () => {
		let alive = true
		setTimeout(() => {
			alive = false
		}, 150)
		expect(
			await waitForPidsExit([1], { isAlive: () => alive, intervalMs: 25, timeoutMs: 2000 }),
		).toBe(true)
	})

	it("gives up after the timeout", async () => {
		expect(await waitForPidsExit([1], { isAlive: () => true, intervalMs: 25, timeoutMs: 150 })).toBe(
			false,
		)
	})
})

describe("cli.ts actually uses the fast path", () => {
	// The launcher was split into cli/src/cli/launcher/*.ts; scan the entry point
	// plus every module under cli/src/cli so these invariants survive the next move.
	const cliSourceFiles = (dir) =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir)
			if (entry.isDirectory()) return cliSourceFiles(child)
			return entry.name.endsWith(".ts") ? [child] : []
		})
	const src = [
		new URL("../../cli/cli.ts", import.meta.url),
		...cliSourceFiles(new URL("../../cli/src/cli/", import.meta.url)),
	]
		.map((u) => fs.readFileSync(u, "utf-8"))
		.join("\n")

	it("writes a PID record when it spawns the server", () => {
		expect(src).toContain("writePidRecord(launcherPidFile")
		expect(src).toContain("removePidRecordIfOwner(launcherPidFile, process.pid)")
	})

	it("stops the previous instance by record before falling back to the scan", () => {
		const stop = src.slice(src.indexOf("async function stopPreviousInstance"))
		const body = stop.slice(0, stop.indexOf("\n}"))
		// Record first, scan and port kill only after the port check.
		expect(body.indexOf("stopRecordedInstance")).toBeLessThan(body.indexOf("killAllAppProcesses"))
		expect(body).toContain("isPortInUse")
	})

	it("no longer scans the machine before every launch", () => {
		expect(src).not.toMatch(/killAllAppProcesses\(port\)\s*\n\s*\.then\(\(\) => killProcessOnPort/)
	})

	it("polls instead of sleeping a fixed interval after killing", () => {
		expect(src).not.toContain("setTimeout(() => resolve(), 1000)")
		expect(src).not.toContain("setTimeout(() => resolve(), 500)")
		expect(src).toContain("waitForPidsExit(")
		expect(src).toContain("waitForPortFree(")
	})

	it("kills the cloudflared it found instead of only returning the PIDs", () => {
		const fn = src.slice(src.indexOf("function killCloudflaredByAppPort"))
		const body = fn.slice(0, fn.indexOf("\n}"))
		expect(body).toContain('process.kill(pid, "SIGKILL")')
		expect(body).toContain("taskkill")
	})

	it("shows a spinner immediately and stops it before starting the server", () => {
		expect(src).toContain("createSpinner(")
		// Started inline, so the spinner is on screen before the process scan runs.
		expect(src).toMatch(/const startupSpinner = createSpinner\([\s\S]*?\)\.start\(\)/)
		// stop() and startServer() share one handler; a comment may sit between them.
		expect(src).toMatch(/startupSpinner\.stop\(\)[\s\S]{0,400}?startServer\(\)/)
	})
})
