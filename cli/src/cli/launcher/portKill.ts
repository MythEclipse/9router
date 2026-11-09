import { execSync } from "node:child_process"
import fs from "node:fs"
import {
	isPortInUse,
	readPidRecord,
	stopRecordedInstance,
	waitForPidsExit,
	waitForPortFree,
} from "../utils/launcherProcess.js"
import { killCloudflaredByAppPort, killProxyByPidFile, killTunnelByPidFile } from "./pidKill.js"
import { PORT_RELEASE_WAIT_MS, PROCESS_EXIT_WAIT_MS } from "./spinner.js"

// Kill all 9router processes (full machine-wide scan — slow on Windows, so the
// launcher uses it only as a fallback; see stopPreviousInstance).
function killAllAppProcesses() {
	return new Promise((resolve) => {
		try {
			const platform = process.platform
			const pids = []

			if (platform === "win32") {
				// Windows: use WMI to get full CommandLine (tasklist /V doesn't include it)
				try {
					const psCmd = `powershell -NonInteractive -WindowStyle Hidden -Command "Get-WmiObject Win32_Process -Filter 'Name=\\"node.exe\\"' | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"`
					const output = execSync(psCmd, {
						encoding: "utf8",
						windowsHide: true,
						timeout: 5000,
					})
					const lines = output
						.split("\n")
						.slice(1)
						.filter((l) => l.trim())
					lines.forEach((line) => {
						// Whitelist: real node process running 9router/cli.js, or next-server.
						// Avoids killing editors/grep/strace/cursor that just have "9router" in cmdline.
						const cmd = line.toLowerCase()
						const isAppProcess =
							(cmd.includes("node") &&
								cmd.includes("9router") &&
								(cmd.includes("cli") || cmd.includes("\\9router") || cmd.includes("/9router"))) ||
							cmd.includes("next-server")
						if (isAppProcess) {
							const match = line.match(/^"(\d+)"/)
							if (match && match[1] && match[1] !== process.pid.toString()) {
								pids.push(match[1])
							}
						}
					})
				} catch (_e) {
					// No processes found or error - continue
				}
			} else {
				// macOS/Linux: use ps to find all matching processes
				try {
					const output = execSync("ps aux 2>/dev/null", {
						encoding: "utf8",
						timeout: 5000,
					})
					const lines = output.split("\n")

					lines.forEach((line) => {
						// Whitelist: real node process running 9router/cli.js, or next-server.
						// Avoids killing grep/strace/editors/cursor that incidentally match "9router".
						const cmd = line.toLowerCase()
						const isAppProcess =
							(cmd.includes("node") &&
								cmd.includes("9router") &&
								(cmd.includes("cli") || cmd.includes("/9router"))) ||
							cmd.includes("next-server")
						if (isAppProcess) {
							const parts = line.trim().split(/\s+/)
							const pid = parts[1]
							if (pid && !Number.isNaN(pid) && pid !== process.pid.toString()) {
								pids.push(pid)
							}
						}
					})
				} catch (_e) {
					// No processes found or error - continue
				}
			}

			// Kill all found processes
			if (pids.length > 0) {
				pids.forEach((pid) => {
					try {
						if (platform === "win32") {
							execSync(`taskkill /F /PID ${pid} 2>nul`, {
								stdio: "ignore",
								shell: true,
								windowsHide: true,
								timeout: 3000,
							})
						} else {
							execSync(`kill -9 ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 3000 })
						}
					} catch (_err) {
						// Process already dead or can't kill - continue
					}
				})

				// Wait for processes to terminate — returns as soon as they are gone.
				waitForPidsExit(pids.map(Number), { timeoutMs: PROCESS_EXIT_WAIT_MS }).then(() => resolve())
			} else {
				resolve()
			}
		} catch (_err) {
			// Silent fail - continue anyway
			resolve()
		}
	})
}
// Kill any process on specific port
function killProcessOnPort(port) {
	return new Promise((resolve) => {
		try {
			const platform = process.platform
			let pid

			if (platform === "win32") {
				try {
					const output = execSync(`netstat -ano | findstr :${port}`, {
						encoding: "utf8",
						shell: true,
						windowsHide: true,
						timeout: 5000,
					}).trim()
					const lines = output.split("\n").filter((l) => l.includes("LISTENING"))
					if (lines.length > 0) {
						pid = lines[0].trim().split(/\s+/).pop()
						execSync(`taskkill /F /PID ${pid} 2>nul`, {
							stdio: "ignore",
							shell: true,
							windowsHide: true,
							timeout: 3000,
						})
					}
				} catch (_e) {
					// Port is free or error
				}
			} else {
				// macOS/Linux
				try {
					const pidOutput = execSync(`lsof -ti:${port}`, {
						encoding: "utf8",
						stdio: ["pipe", "pipe", "ignore"],
					}).trim()
					if (pidOutput) {
						pid = pidOutput.split("\n")[0]
						execSync(`kill -9 ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 3000 })
					}
				} catch (_e) {
					// Port is free or error
				}
			}

			// Wait for the port only when something was killed; return once it is free.
			if (pid) waitForPortFree(port, { timeoutMs: PORT_RELEASE_WAIT_MS }).then(() => resolve())
			else resolve()
		} catch (_err) {
			// Silent fail - continue anyway
			resolve()
		}
	})
}

// Stop the previous launcher by its PID record (fast path). The machine-wide
// process scan (~0.5s per PowerShell call on Windows) runs only when the port is
// still occupied afterwards, e.g. by a launcher from a version without a record.
async function stopPreviousInstance(appPort, launcherPidFile) {
	// MITM + tunnel run on separate ports/processes — killing them doesn't free the
	// app port, so keep them off the critical path. Server-side MITM manager has
	// stale-lock recovery and starts deferred (~3s).
	setImmediate(() => {
		try {
			killProxyByPidFile()
		} catch {}
		try {
			killTunnelByPidFile()
		} catch {}
		try {
			killCloudflaredByAppPort(appPort)
		} catch {}
	})

	const killed = stopRecordedInstance(readPidRecord(launcherPidFile))
	try {
		fs.unlinkSync(launcherPidFile)
	} catch {}
	if (killed.length > 0) await waitForPidsExit(killed, { timeoutMs: PROCESS_EXIT_WAIT_MS })

	if (!(await isPortInUse(appPort))) return
	await killAllAppProcesses()
	await killProcessOnPort(appPort)
}

export { killAllAppProcesses, killProcessOnPort, stopPreviousInstance }
