import "server-only"

import { execSync } from "node:child_process"
import os from "node:os"
import type {
	TailscaleCheckDeps,
	TailscaleInstallDeps,
	TunnelProbeDeps,
	TunnelToggleDeps,
} from "9router-api/application/tunnel/manage-tunnel"
import { getSettings, updateSettings } from "@/lib/localDb"
import {
	disableTailscale,
	disableTunnel,
	enableTailscale,
	enableTunnel,
	generateShortId,
	getDownloadStatus,
	getTailscaleBin,
	getTailscaleStatus,
	getTunnelStatus,
	installTailscale,
	isSystemDaemonRunning,
	isTailscaleInstalled,
	isTailscaleLoggedIn,
	loadState,
	TAILSCALE_SOCKET,
} from "@/lib/tunnel"
import { getCachedPassword, initDbHooks, loadEncryptedPassword } from "@/mitm/manager"
import { configureTunnelMonitoring } from "@/shared/services/initializeApp"

/**
 * The machine side of the tunnel toggle.
 *
 * These routes reach out to a process, a socket, or a package manager, which is exactly what
 * the use-cases may not do. Each function here answers one question about this host; the
 * ordering that turns the answers into a screen lives in `manage-tunnel.ts`.
 */

const EXTENDED_PATH = `/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/opt/homebrew/sbin:/usr/sbin:/usr/bin:/bin:/snap/bin:${process.env.PATH || ""}`

/** How long a `which`/`pgrep` probe may take, in milliseconds. */
const PROBE_TIMEOUT_MS = 1_500

/**
 * The encryptor persists through these hooks, and the installer is the route that saves a
 * password — so they are wired here, once, for whichever tunnel route runs first.
 */
initDbHooks(getSettings, updateSettings)

/** Run a probe, answering whether it exited cleanly. Never throws. */
function probe(command: string): boolean {
	try {
		execSync(command, {
			stdio: "ignore",
			windowsHide: true,
			env: { ...process.env, PATH: EXTENDED_PATH },
			timeout: PROBE_TIMEOUT_MS,
		})
		return true
	} catch {
		return false
	}
}

/**
 * Whether the bundled binary answers on its own socket.
 *
 * Falling back to `pgrep` covers the window where the daemon is alive but has not written
 * its socket yet — reporting "not running" there would make the install flow try to start a
 * second daemon.
 */
function isCustomDaemonRunning(): boolean {
	const bin = getTailscaleBin()
	if (!bin) return false
	if (probe(`"${bin}" --socket ${TAILSCALE_SOCKET} status --json`)) return true
	return probe("pgrep -x tailscaled")
}

async function hasCachedPassword(): Promise<boolean> {
	if (getCachedPassword()) return true
	return Boolean(await loadEncryptedPassword())
}

export function createTunnelProbeDeps(): TunnelProbeDeps {
	return {
		tunnelStatus: getTunnelStatus,
		tailscaleStatus: getTailscaleStatus,
		downloadStatus: getDownloadStatus,
		now: () => Date.now(),
	}
}

export function createTunnelToggleDeps(): TunnelToggleDeps {
	return {
		enableTunnel,
		disableTunnel,
		enableTailscale,
		disableTailscale,
		// The watchdog reads the settings row, so it re-reads it here rather than taking a
		// copy that is stale by the time the tunnel comes up.
		reconfigureMonitoring: async () => configureTunnelMonitoring(await getSettings()),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	}
}

export function createTailscaleCheckDeps(): TailscaleCheckDeps {
	return {
		installed: isTailscaleInstalled,
		customDaemonRunning: async () => isCustomDaemonRunning(),
		systemDaemonRunning: isSystemDaemonRunning,
		loggedIn: isTailscaleLoggedIn,
		hasCachedPassword,
		platform: () => os.platform(),
		brewAvailable: async () => probe("which brew"),
	}
}

export function createTailscaleInstallDeps(): TailscaleInstallDeps {
	return {
		platform: () => os.platform(),
		brewAvailable: () => probe("which brew"),
		cachedPassword: async () => (getCachedPassword() ?? (await loadEncryptedPassword())) || null,
		// An install that already has a short id keeps it: two installs on one machine would
		// otherwise answer on different funnel hosts, and the recorded state would disagree
		// with the one Tailscale is actually serving.
		shortId: () => loadState()?.shortId || generateShortId(),
		install: async ({ password, shortId, report }) => {
			const result = await installTailscale(password, shortId, report)
			return { authUrl: "authUrl" in result ? (result.authUrl ?? null) : null }
		},
	}
}
