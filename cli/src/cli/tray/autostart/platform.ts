import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { APP_LABEL, APP_NAME, getCliJsPath } from "./core.js"

// ============ macOS ============

/**
 * Returns true when the current Node process IS the running instance that
 * launchd is managing under our agent label.
 *
 * `launchctl unload <plist>` (and `load`) for an Aqua user-domain agent sends
 * SIGTERM to the running process. When the running 9router cli.js was itself
 * spawned by the autostart launchd agent (i.e. user enabled autostart at
 * some point, then rebooted, then clicked the tray icon's "Disable
 * Auto-start" menu item), an unload would kill the very process executing
 * the click handler - and the tray icon would disappear instead of the menu
 * label flipping back to "Enable Auto-start". This helper lets the enable
 * and disable paths sidestep that by skipping launchctl when we'd otherwise
 * be killing ourselves.
 */
function isAgentSelfMacOS() {
	try {
		const output = execSync(`launchctl list ${APP_LABEL}`, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		})
		const match = output.match(/"PID"\s*=\s*(\d+)/)
		return !!(match && parseInt(match[1], 10) === process.pid)
	} catch (_e) {
		return false
	}
}

function enableMacOS(cliPath) {
	const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents")
	const plistPath = path.join(launchAgentsDir, `${APP_LABEL}.plist`)

	if (!fs.existsSync(launchAgentsDir)) {
		fs.mkdirSync(launchAgentsDir, { recursive: true })
	}

	const nodePath = process.execPath
	const routerScript = getCliJsPath(cliPath)
	// Don't write a broken plist that references a non-existent script.
	if (!routerScript) return false

	// Invoke node + cli.js directly with absolute paths - no shell wrapper.
	// The previous design ran `zsh -l -c "..."` so a login shell would source
	// nvm/.zshrc and set PATH; that's fragile (nvm.sh sourcing varies by user,
	// some setups don't put node on PATH from a non-interactive login shell).
	// EnvironmentVariables.PATH explicitly includes node's bin dir so child
	// processes spawned by cli.js (npm install at runtime, etc.) resolve.
	const launchPath = `${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`

	const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${APP_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${routerScript}</string>
        <string>--tray</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${launchPath}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/9router.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/9router.error.log</string>
</dict>
</plist>`

	fs.writeFileSync(plistPath, plistContent)

	// If we're the running agent already, launchctl unload/load would send
	// ourselves SIGTERM. Skip it - the plist file is updated on disk and
	// launchd will pick it up at next login. isAutoStartEnabled() will still
	// return true because launchctl already has the agent loaded.
	if (isAgentSelfMacOS()) {
		return true
	}

	// Register with launchd in the current session. Without this, the agent
	// only takes effect on the next user login and the user has no signal that
	// anything actually happened. `unload` first defends against re-enable
	// replacing an existing plist.
	try {
		execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" })
	} catch (_e) {}
	try {
		execSync(`launchctl load -w "${plistPath}"`, { stdio: "ignore" })
	} catch (_e) {
		// Even if load fails, the plist is on disk and will be picked up at next
		// login; report success based on the file write.
	}
	return true
}

function disableMacOS() {
	const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${APP_LABEL}.plist`)

	// Don't kill ourselves: when the current process is the running agent,
	// `launchctl unload` would send SIGTERM and the user clicking
	// "Disable Auto-start" from the tray menu would lose their tray icon
	// instead of just flipping the menu label. Skip the unload - removing the
	// plist file is enough to prevent the agent from starting on next login.
	if (!isAgentSelfMacOS()) {
		try {
			execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" })
		} catch (_e) {}
	}

	if (fs.existsSync(plistPath)) {
		fs.unlinkSync(plistPath)
	}
	return true
}

// ============ Windows ============

function enableWindows(cliPath) {
	const startupDir = path.join(
		process.env.APPDATA || "",
		"Microsoft",
		"Windows",
		"Start Menu",
		"Programs",
		"Startup",
	)
	const vbsPath = path.join(startupDir, `${APP_NAME}.vbs`)

	if (!fs.existsSync(startupDir)) return false

	const nodePath = process.execPath
	const routerScript = getCliJsPath(cliPath)
	if (!routerScript) return false

	// Run node + cli.js directly, hidden window. Avoids the fragile
	// `9router.cmd` lookup that depended on the npm prefix path.
	const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${nodePath}"" ""${routerScript}"" --tray", 0, False
`
	fs.writeFileSync(vbsPath, vbsContent)
	return true
}

function disableWindows() {
	const vbsPath = path.join(
		process.env.APPDATA || "",
		"Microsoft",
		"Windows",
		"Start Menu",
		"Programs",
		"Startup",
		`${APP_NAME}.vbs`,
	)
	if (fs.existsSync(vbsPath)) {
		fs.unlinkSync(vbsPath)
	}
	return true
}

// ============ Linux ============

function enableLinux(cliPath) {
	const autostartDir = path.join(os.homedir(), ".config", "autostart")
	const desktopPath = path.join(autostartDir, `${APP_NAME}.desktop`)

	if (!fs.existsSync(autostartDir)) {
		try {
			fs.mkdirSync(autostartDir, { recursive: true })
		} catch (_e) {
			return false
		}
	}

	const nodePath = process.execPath
	const routerScript = getCliJsPath(cliPath)
	if (!routerScript) return false

	const desktopContent = `[Desktop Entry]
Type=Application
Name=9Router
Comment=9Router API Proxy
Exec=${nodePath} ${routerScript} --tray
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`
	fs.writeFileSync(desktopPath, desktopContent)
	return true
}

function disableLinux() {
	const desktopPath = path.join(os.homedir(), ".config", "autostart", `${APP_NAME}.desktop`)
	if (fs.existsSync(desktopPath)) {
		fs.unlinkSync(desktopPath)
	}
	return true
}

export { disableLinux, disableMacOS, disableWindows, enableLinux, enableMacOS, enableWindows }
