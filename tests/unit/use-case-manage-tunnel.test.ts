import { describe, expect, it, vi } from "vitest"
import {
	checkTailscale,
	prepareTailscaleInstall,
	readTunnelStatus,
	runTailscaleInstall,
	type TailscaleCheckDeps,
	type TailscaleInstallDeps,
	type TunnelProbeDeps,
	type TunnelStatusCache,
	type TunnelToggleDeps,
	toggleTunnel,
} from "../../apps/api/src/application/tunnel/manage-tunnel.ts"
import { DNS_WARMUP_DELAY_MS, STATUS_CACHE_TTL_MS } from "../../apps/api/src/domain/tunnel.ts"

function probes(overrides: Partial<TunnelProbeDeps> = {}): TunnelProbeDeps {
	return {
		tunnelStatus: vi.fn(async () => ({ running: true })),
		tailscaleStatus: vi.fn(async () => ({ running: true })),
		downloadStatus: vi.fn(() => ({ percent: 42 })),
		now: vi.fn(() => 1_000_000),
		...overrides,
	}
}

function cache(overrides: Partial<TunnelStatusCache> = {}): TunnelStatusCache {
	return { value: null, fetchedAt: 0, ...overrides }
}

describe("readTunnelStatus", () => {
	it("probes both services on a cold cache and adds live download progress", async () => {
		const d = probes()
		const answer = await readTunnelStatus(cache(), d)
		expect(answer).toEqual({
			tunnel: { running: true },
			tailscale: { running: true },
			download: { percent: 42 },
		})
	})

	it("reuses the probes inside the window but re-reads the download every time", async () => {
		const d = probes()
		const c = cache()
		await readTunnelStatus(c, d)
		await readTunnelStatus(c, d)

		expect(d.tunnelStatus).toHaveBeenCalledTimes(1)
		expect(d.downloadStatus).toHaveBeenCalledTimes(2)
	})

	it("probes again once the window has passed", async () => {
		let now = 1_000_000
		const d = probes({ now: () => now })
		const c = cache()
		await readTunnelStatus(c, d)
		now += STATUS_CACHE_TTL_MS
		await readTunnelStatus(c, d)
		expect(d.tunnelStatus).toHaveBeenCalledTimes(2)
	})

	it("does not cache a failed probe, so the next poll retries it", async () => {
		const d = probes({ tunnelStatus: vi.fn(async () => Promise.reject(new Error("offline"))) })
		const c = cache()
		await expect(readTunnelStatus(c, d)).rejects.toThrow("offline")
		expect(c.value).toBeNull()
	})
})

function toggleDeps(overrides: Partial<TunnelToggleDeps> = {}): TunnelToggleDeps {
	return {
		enableTunnel: vi.fn(async () => ({ enabled: "cloudflare" })),
		disableTunnel: vi.fn(async () => ({ disabled: "cloudflare" })),
		enableTailscale: vi.fn(async () => ({ enabled: "tailscale" })),
		disableTailscale: vi.fn(async () => ({ disabled: "tailscale" })),
		reconfigureMonitoring: vi.fn(async () => undefined),
		sleep: vi.fn(async () => undefined),
		...overrides,
	}
}

describe("toggleTunnel", () => {
	it("calls the switch for the service and direction asked for", async () => {
		const d = toggleDeps()
		expect(await toggleTunnel({ kind: "cloudflare", on: false }, d)).toEqual({
			disabled: "cloudflare",
		})
		expect(d.disableTunnel).toHaveBeenCalled()
		expect(d.enableTunnel).not.toHaveBeenCalled()

		await toggleTunnel({ kind: "tailscale", on: true }, d)
		expect(d.enableTailscale).toHaveBeenCalled()
	})

	it("waits for DNS only when a Cloudflare tunnel is turned on", async () => {
		const on = toggleDeps()
		await toggleTunnel({ kind: "cloudflare", on: true }, on)
		expect(on.sleep).toHaveBeenCalledWith(DNS_WARMUP_DELAY_MS)

		const off = toggleDeps()
		await toggleTunnel({ kind: "cloudflare", on: false }, off)
		expect(off.sleep).not.toHaveBeenCalled()

		const ts = toggleDeps()
		await toggleTunnel({ kind: "tailscale", on: true }, ts)
		expect(ts.sleep).not.toHaveBeenCalled()
	})

	it("re-arms monitoring after every direction of every service", async () => {
		for (const kind of ["cloudflare", "tailscale"] as const) {
			for (const on of [true, false]) {
				const d = toggleDeps()
				await toggleTunnel({ kind, on }, d)
				expect(d.reconfigureMonitoring).toHaveBeenCalledTimes(1)
			}
		}
	})

	it("does not fail a successful enable because the monitor would not start", async () => {
		const d = toggleDeps({
			reconfigureMonitoring: vi.fn(async () => Promise.reject(new Error("no settings"))),
		})
		await expect(toggleTunnel({ kind: "cloudflare", on: true }, d)).resolves.toEqual({
			enabled: "cloudflare",
		})
	})

	it("reports a failed switch instead of answering success", async () => {
		const d = toggleDeps({ enableTunnel: vi.fn(async () => Promise.reject(new Error("nope"))) })
		await expect(toggleTunnel({ kind: "cloudflare", on: true }, d)).rejects.toThrow("nope")
		expect(d.sleep).not.toHaveBeenCalled()
	})
})

function checkDeps(overrides: Partial<TailscaleCheckDeps> = {}): TailscaleCheckDeps {
	return {
		installed: () => true,
		customDaemonRunning: vi.fn(async () => true),
		systemDaemonRunning: () => false,
		loggedIn: () => true,
		hasCachedPassword: vi.fn(async () => true),
		platform: () => "linux",
		brewAvailable: vi.fn(async () => false),
		...overrides,
	}
}

describe("checkTailscale", () => {
	it("reports the custom daemon as the running one when it answers", async () => {
		const answer = await checkTailscale(checkDeps())
		expect(answer).toMatchObject({
			installed: true,
			daemonRunning: true,
			customDaemonRunning: true,
			systemDaemonRunning: false,
			loggedIn: true,
		})
	})

	it("counts the system daemon too, because the screens only ask whether it is reachable", async () => {
		const answer = await checkTailscale(
			checkDeps({ customDaemonRunning: vi.fn(async () => false), systemDaemonRunning: () => true }),
		)
		expect(answer.daemonRunning).toBe(true)
		expect(answer.customDaemonRunning).toBe(false)
	})

	it("does not claim a login when no daemon is running to be logged in to", async () => {
		const answer = await checkTailscale(
			checkDeps({
				customDaemonRunning: vi.fn(async () => false),
				systemDaemonRunning: () => false,
			}),
		)
		expect(answer.daemonRunning).toBe(false)
		expect(answer.loggedIn).toBe(false)
	})

	it("skips the daemon probes entirely when Tailscale is not installed", async () => {
		const d = checkDeps({ installed: () => false, systemDaemonRunning: vi.fn(() => false) })
		await checkTailscale(d)
		expect(d.customDaemonRunning).not.toHaveBeenCalled()
		expect(d.systemDaemonRunning).not.toHaveBeenCalled()
	})

	it("only looks for Homebrew on macOS", async () => {
		const linux = checkDeps()
		expect((await checkTailscale(linux)).brewAvailable).toBe(false)
		expect(linux.brewAvailable).not.toHaveBeenCalled()

		const mac = checkDeps({ platform: () => "darwin", brewAvailable: vi.fn(async () => true) })
		expect((await checkTailscale(mac)).brewAvailable).toBe(true)
	})
})

function installDeps(overrides: Partial<TailscaleInstallDeps> = {}): TailscaleInstallDeps {
	return {
		platform: () => "linux",
		brewAvailable: () => false,
		cachedPassword: vi.fn(async () => "cached"),
		shortId: () => "abc123",
		install: vi.fn(async () => ({ authUrl: "https://login.tailscale.com/a/1" })),
		...overrides,
	}
}

describe("prepareTailscaleInstall", () => {
	it("carries the typed password and the install's short id", async () => {
		const d = installDeps()
		expect(await prepareTailscaleInstall({ sudoPassword: "typed" }, d)).toEqual({
			password: "typed",
			shortId: "abc123",
		})
	})

	it("falls back to the cached password", async () => {
		expect(await prepareTailscaleInstall({}, installDeps())).toEqual({
			password: "cached",
			shortId: "abc123",
		})
	})

	it("refuses before the stream opens when no password is available", async () => {
		const d = installDeps({ cachedPassword: vi.fn(async () => null) })
		await expect(prepareTailscaleInstall({}, d)).rejects.toThrow("Sudo password is required")
	})

	it("does not require a password on Windows or on Homebrew macOS", async () => {
		const win = installDeps({ platform: () => "win32", cachedPassword: vi.fn(async () => null) })
		await expect(prepareTailscaleInstall({}, win)).resolves.toMatchObject({ password: "" })

		const mac = installDeps({ platform: () => "darwin", brewAvailable: () => true })
		await expect(prepareTailscaleInstall({}, mac)).resolves.toMatchObject({ password: "cached" })
	})
})

describe("runTailscaleInstall", () => {
	it("reports progress and then done with the auth URL", async () => {
		const progress: string[] = []
		const d = installDeps({
			install: vi.fn(async ({ report }) => {
				report("downloading")
				report("installing")
				return { authUrl: "https://login.tailscale.com/a/1" }
			}),
		})
		const event = await runTailscaleInstall({ password: "p", shortId: "s" }, d, (m) =>
			progress.push(m),
		)
		expect(progress).toEqual(["downloading", "installing"])
		expect(event).toEqual({
			event: "done",
			data: { success: true, authUrl: "https://login.tailscale.com/a/1" },
		})
	})

	it("answers null when the install reported no auth URL", async () => {
		const d = installDeps({ install: vi.fn(async () => ({})) })
		const event = await runTailscaleInstall({ password: "p", shortId: "s" }, d, () => {})
		expect(event).toEqual({ event: "done", data: { success: true, authUrl: null } })
	})

	it("answers an error event rather than throwing, because the stream already answered 200", async () => {
		const d = installDeps({
			install: vi.fn(async () => Promise.reject(new Error("sudo: Sorry, try again."))),
		})
		const event = await runTailscaleInstall({ password: "p", shortId: "s" }, d, () => {})
		expect(event).toEqual({ event: "error", data: { error: "Wrong sudo password" } })
	})
})
