import { spawn } from "node:child_process"
import { enableAutoStart } from "../tray/autostart.js"
import { clearScreen } from "../utils/display.js"

export async function hideToTray({ port, displayHost, __filename, cleanup }) {
	clearScreen()

	// Enable auto startup on OS boot
	try {
		enableAutoStart(__filename)
	} catch (_e) {}

	if (process.platform === "darwin") {
		// macOS: keep current process alive — spawning a detached child puts
		// it outside the login session so NSStatusItem silently fails.
		process.removeAllListeners("SIGHUP")
		process.on("SIGHUP", () => {})

		console.log(`\n⏳ Switching to tray mode... (icon already visible in menu bar)`)
		console.log(`🔔 9Router is running in tray (PID: ${process.pid})`)
		console.log(`   Server: http://${displayHost}:${port}`)
		console.log(`\n💡 You can close this terminal. Right-click tray icon to quit.\n`)

		// Tray already init'd at startup — just keep event loop alive.
		return true
	}

	// Windows/Linux: spawn detached bgProcess (systray works fine in child)
	console.log(`\n⏳ Starting background process... (tray icon will appear in ~3s)`)

	const bgProcess = spawn(
		process.execPath,
		["--dns-result-order=ipv4first", __filename, "--tray", "-p", port.toString()],
		{
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			env: { ...process.env },
		},
	)
	bgProcess.unref()

	console.log(`🔔 9Router is now running in background (PID: ${bgProcess.pid})`)
	console.log(`   Server: http://${displayHost}:${port}`)
	console.log(`\n💡 You can close this terminal. Right-click tray icon to quit.\n`)

	// cleanup() kills server so bgProcess can claim the port fresh
	cleanup()
	process.exit(0)
	return true
}
