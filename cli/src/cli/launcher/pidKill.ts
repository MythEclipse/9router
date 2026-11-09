import { exec, execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Compare semver versions: returns 1 if a > b, -1 if a < b, 0 if equal
// Get app data dir (matches app/src/lib/dataDir.js convention)
function getAppDataDir() {
	return process.platform === "win32"
		? path.join(process.env.APPDATA || "", "9router")
		: path.join(os.homedir(), ".9router")
}
// Kill PID from file (best-effort, removes file after)
function killByPidFile(pidFile) {
	try {
		if (!fs.existsSync(pidFile)) return
		const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)
		if (!pid) return
		try {
			if (process.platform === "win32") {
				execSync(`taskkill /F /T /PID ${pid}`, {
					stdio: "ignore",
					windowsHide: true,
					timeout: 3000,
				})
			} else {
				process.kill(pid, "SIGKILL")
			}
		} catch {}
		try {
			fs.unlinkSync(pidFile)
		} catch {}
	} catch {}
}
// Kill tunnel processes (cloudflared/tailscale) by their PID files
function killTunnelByPidFile() {
	const tunnelDir = path.join(getAppDataDir(), "tunnel")
	killByPidFile(path.join(tunnelDir, "cloudflared.pid"))
	killByPidFile(path.join(tunnelDir, "tailscale.pid"))
}
// Kill cloudflared whose --url targets this app's port (covers stale PID file case).
// Runs async and actually kills: this is off the critical path, and a synchronous
// PowerShell scan here was pure added latency on Windows.
function killCloudflaredByAppPort(appPort) {
	if (!appPort) return
	const portMatchers = [`localhost:${appPort}`, `127.0.0.1:${appPort}`]
	const isWin = process.platform === "win32"
	const scanCmd = isWin
		? `powershell -NonInteractive -WindowStyle Hidden -Command "Get-WmiObject Win32_Process -Filter 'Name=\\"cloudflared.exe\\"' | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"`
		: "ps -eo pid,command 2>/dev/null"
	exec(scanCmd, { encoding: "utf8", windowsHide: true, timeout: 5000 }, (err, output) => {
		if (err || !output) return
		const pids = []
		const lines = isWin ? output.split("\n").slice(1) : output.split("\n")
		for (const line of lines) {
			if (!portMatchers.some((m) => line.includes(m))) continue
			if (isWin) {
				const match = line.match(/^"(\d+)"/)
				if (match) pids.push(Number(match[1]))
			} else if (line.includes("cloudflared")) {
				const pid = Number(line.trim().split(/\s+/)[0])
				if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid)
			}
		}
		for (const pid of pids) {
			try {
				if (isWin) {
					execSync(`taskkill /F /T /PID ${pid}`, {
						stdio: "ignore",
						windowsHide: true,
						timeout: 3000,
					})
				} else {
					process.kill(pid, "SIGKILL")
				}
			} catch {}
		}
	})
}
// Sleep helper using SharedArrayBuffer wait (sync, no busy-loop)
function sleepSync(ms) {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
	} catch {
		/* ignore */
	}
}

// Wait until process dies or timeout reached
function waitForExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0)
		} catch {
			return true
		}
		sleepSync(100)
	}
	return false
}
// Kill MIT server by PID file (runs privileged, needs special handling)
// Sends SIGTERM first so MIT can clean up host entries before dying.
function killProxyByPidFile() {
	try {
		const pidFile = path.join(getAppDataDir(), "mitm", ".mitm.pid")
		if (!fs.existsSync(pidFile)) return
		const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)
		if (!pid) return

		if (process.platform === "win32") {
			// Graceful first (lets server cleanup hosts), then force
			try {
				execSync(`taskkill /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 2000 })
			} catch {}
			if (!waitForExit(pid, 1500)) {
				try {
					execSync(`taskkill /F /T /PID ${pid}`, {
						stdio: "ignore",
						windowsHide: true,
						timeout: 3000,
					})
				} catch {}
			}
			// Last-resort: PowerShell Stop-Process (sometimes succeeds where taskkill fails on admin processes)
			if (!waitForExit(pid, 500)) {
				try {
					execSync(
						`powershell -NonInteractive -WindowStyle Hidden -Command "Stop-Process -Id ${pid} -Force"`,
						{ stdio: "ignore", windowsHide: true, timeout: 3000 },
					)
				} catch {}
			}
		} else {
			// SIGTERM via cached sudo token first
			try {
				execSync(`sudo -n kill -TERM ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 2000 })
			} catch {
				try {
					process.kill(pid, "SIGTERM")
				} catch {}
			}
			if (!waitForExit(pid, 1500)) {
				try {
					execSync(`sudo -n kill -9 ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 2000 })
				} catch {
					try {
						process.kill(pid, "SIGKILL")
					} catch {}
				}
			}
		}
		try {
			fs.unlinkSync(pidFile)
		} catch {}
	} catch {}
}
// Open browser
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

	exec(cmd, { windowsHide: true }, (err) => {
		if (err) {
			console.log(`Open browser manually: ${url}`)
		}
	})
}

export {
	getAppDataDir,
	killByPidFile,
	killCloudflaredByAppPort,
	killProxyByPidFile,
	killTunnelByPidFile,
	openBrowser,
}
