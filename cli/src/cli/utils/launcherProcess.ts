/**
 * Fast previous-instance detection for the launcher.
 *
 * The launcher records its own PID and its server's PID in <dataDir>/launcher.pid.
 * The next launch stops exactly those processes instead of scanning every process
 * on the machine — a PowerShell WMI query costs ~0.5s per call on Windows — and
 * falls back to the full scan only when the port is still occupied afterwards
 * (e.g. by a launcher from a version that predates the record).
 *
 * Every function that touches the outside world takes it as an injected option so
 * the decision logic is testable without spawning or killing real processes.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

const PID_FILE_NAME = "launcher.pid"
/** A localhost connect either answers fast or is not going to. */
const PORT_PROBE_TIMEOUT_MS = 500
const DEFAULT_WAIT_TIMEOUT_MS = 3000
const DEFAULT_POLL_INTERVAL_MS = 50
const EXE_LOOKUP_TIMEOUT_MS = 2000

export interface PidRecord {
	readonly cliPid: number
	readonly serverPid: number | null
	readonly port: number | null
	readonly exe: string
}

export interface WaitOptions {
	readonly timeoutMs?: number
	readonly intervalMs?: number
}

export function getPidFilePath(dataDir: string): string {
	return path.join(dataDir, PID_FILE_NAME)
}

function toPid(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

export function writePidRecord(
	file: string,
	record: { cliPid: number; serverPid: number | null; port: number; exe: string },
): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	// Write-then-rename so a crash mid-write cannot leave a half-parsed record that
	// parses as a valid but wrong PID.
	const tmp = `${file}.${process.pid}.tmp`
	fs.writeFileSync(tmp, JSON.stringify(record))
	fs.renameSync(tmp, file)
}

export function readPidRecord(file: string): PidRecord | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"))
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== "object") return null
	const raw = parsed as Record<string, unknown>
	const cliPid = toPid(raw.cliPid)
	// A record without an exe cannot be checked for PID reuse, so it is unusable —
	// falling back to the scan is safer than killing a stranger.
	if (!cliPid || typeof raw.exe !== "string" || !raw.exe) return null
	return {
		cliPid,
		serverPid: toPid(raw.serverPid),
		port: typeof raw.port === "number" && Number.isSafeInteger(raw.port) ? raw.port : null,
		exe: raw.exe,
	}
}

/** Removes the record only if this process wrote it — never a successor's. */
export function removePidRecordIfOwner(file: string, ownerPid: number): void {
	const record = readPidRecord(file)
	if (!record || record.cliPid !== ownerPid) return
	try {
		fs.unlinkSync(file)
	} catch {
		/* already removed */
	}
}

export function isPidAlive(
	pid: number,
	{
		kill = process.kill.bind(process),
	}: { kill?: (pid: number, signal: number | string) => void } = {},
): boolean {
	if (!toPid(pid)) return false
	try {
		kill(pid, 0)
		return true
	} catch (err) {
		// EPERM means it exists but belongs to another user — alive for our purposes.
		return Boolean(err) && (err as NodeJS.ErrnoException).code === "EPERM"
	}
}

function normalizeExeName(name: string): string {
	return String(name || "")
		.trim()
		.toLowerCase()
		.replace(/\.exe$/, "")
}

function lookupExeName(pid: number): string {
	if (process.platform === "win32") {
		const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
			encoding: "utf8",
			windowsHide: true,
			timeout: EXE_LOOKUP_TIMEOUT_MS,
		})
		const match = out.match(/^"([^"]+)","(\d+)"/m)
		return match && Number(match[2]) === pid ? match[1] : ""
	}
	// /proc/<pid>/comm is rewritten by process.title (Next sets "next-server (v…)"),
	// so resolve the real executable instead.
	try {
		return fs.readlinkSync(`/proc/${pid}/exe`)
	} catch {
		return execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
			encoding: "utf8",
			timeout: EXE_LOOKUP_TIMEOUT_MS,
		})
	}
}

/**
 * Guards against PID reuse: a stale record must never kill an unrelated program
 * that happens to have inherited the PID.
 */
export function processMatchesExe(pid: number, exe: string): boolean {
	const expected = normalizeExeName(exe)
	if (!expected || !toPid(pid)) return false
	try {
		return normalizeExeName(path.basename(lookupExeName(pid))) === expected
	} catch {
		return false
	}
}

function defaultKillPid(pid: number): void {
	if (process.platform === "win32") {
		execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
			stdio: "ignore",
			windowsHide: true,
			timeout: EXE_LOOKUP_TIMEOUT_MS,
		})
	} else {
		process.kill(pid, "SIGKILL")
	}
}

/**
 * Stops the processes named in a launcher record, returning the PIDs it killed.
 *
 * Server first, so the port is released even if the CLI kill fails.
 */
export function stopRecordedInstance(
	record: PidRecord | null,
	{
		selfPid = process.pid,
		isAlive = isPidAlive,
		matchesExe = processMatchesExe,
		killPid = defaultKillPid,
	}: {
		selfPid?: number
		isAlive?: (pid: number) => boolean
		matchesExe?: (pid: number, exe: string) => boolean
		killPid?: (pid: number) => void
	} = {},
): number[] {
	if (!record) return []
	const candidates = [record.serverPid, record.cliPid].filter(
		(pid): pid is number => toPid(pid) !== null && pid !== selfPid,
	)
	const killed: number[] = []
	for (const pid of candidates) {
		if (!isAlive(pid) || !matchesExe(pid, record.exe)) continue
		try {
			killPid(pid)
			killed.push(pid)
		} catch {
			// Already gone or not permitted — the port check decides what happens next.
		}
	}
	return killed
}

export function isPortInUse(
	port: number,
	host = "127.0.0.1",
	timeoutMs = PORT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port })
		const finish = (inUse: boolean) => {
			socket.destroy()
			resolve(inUse)
		}
		socket.setTimeout(timeoutMs, () => finish(false))
		socket.once("connect", () => finish(true))
		socket.once("error", () => finish(false))
	})
}

async function pollUntil(
	check: () => boolean | Promise<boolean>,
	{ timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = DEFAULT_POLL_INTERVAL_MS }: WaitOptions = {},
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		if (await check()) return true
		if (Date.now() >= deadline) return false
		await new Promise((r) => setTimeout(r, intervalMs))
	}
}

/** Resolves true as soon as nothing is listening, false at the deadline. */
export function waitForPortFree(port: number, opts: WaitOptions = {}): Promise<boolean> {
	return pollUntil(async () => !(await isPortInUse(port)), opts)
}

export function waitForPidsExit(
	pids: readonly number[],
	{ isAlive = isPidAlive, ...opts }: WaitOptions & { isAlive?: (pid: number) => boolean } = {},
): Promise<boolean> {
	return pollUntil(() => pids.every((pid) => !isAlive(pid)), opts)
}
