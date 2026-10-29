import { invalid } from "../../domain/errors.ts"
import {
	DNS_WARMUP_DELAY_MS,
	installFailureOf,
	installNeedsPassword,
	installPasswordOf,
	statusIsFresh,
	type TailscaleCheckAnswer,
	type TunnelKind,
} from "../../domain/tunnel.ts"

/**
 * Reading a tunnel's state, and turning one on or off.
 *
 * The probes, the process handling and the scheduler all live in the host. What lives here
 * is the ordering the screens depend on: the cache on the read path, the re-arm after every
 * write, and the warmup that only a Cloudflare enable waits for.
 */

/** The probes a status poll needs. */
export interface TunnelProbeDeps {
	readonly tunnelStatus: () => Promise<unknown>
	readonly tailscaleStatus: () => Promise<unknown>
	/** Download progress is read fresh on every poll; it is the moving number. */
	readonly downloadStatus: () => unknown
	readonly now: () => number
}

/** The switches a toggle needs, plus the monitoring that follows one. */
export interface TunnelToggleDeps {
	readonly enableTunnel: () => Promise<unknown>
	readonly disableTunnel: () => Promise<unknown>
	readonly enableTailscale: () => Promise<unknown>
	readonly disableTailscale: () => Promise<unknown>
	/**
	 * Re-arm the watchdog and the scheduler after a tunnel changed state.
	 *
	 * Fire-and-forget on purpose: a monitor that failed to start must not turn a successful
	 * enable into an error the operator reads as "the tunnel did not come up".
	 */
	readonly reconfigureMonitoring: () => Promise<void>
	/** Wait, in milliseconds. Injected so a test does not sleep for the warmup. */
	readonly sleep: (ms: number) => Promise<void>
}

/** Cached probes, owned by the caller so it can survive a hot reload. */
export interface TunnelStatusCache {
	value: { tunnel: unknown; tailscale: unknown } | null
	fetchedAt: number
}

/** `GET /api/tunnel/status` — both probes, plus live download progress. */
export async function readTunnelStatus(
	cache: TunnelStatusCache,
	deps: TunnelProbeDeps,
): Promise<{ tunnel: unknown; tailscale: unknown; download: unknown }> {
	if (!statusIsFresh(cache.fetchedAt, deps.now())) {
		const [tunnel, tailscale] = await Promise.all([deps.tunnelStatus(), deps.tailscaleStatus()])
		cache.value = { tunnel, tailscale }
		cache.fetchedAt = deps.now()
	}

	// The cache holds the probes only; reading it here keeps the spread honest even on the
	// path where `statusIsFresh` was true and `value` was already set.
	const probes = cache.value ?? { tunnel: null, tailscale: null }
	return { ...probes, download: deps.downloadStatus() }
}

/**
 * `POST /api/tunnel/{enable,disable,tailscale-{enable,disable}}`.
 *
 * One function for four routes because they differ in exactly two ways: which switch is
 * flipped, and whether the answer waits for DNS. Turning a tunnel *on* at Cloudflare leaves
 * the hostname unresolvable at the edge for a moment; turning one off needs no wait, and
 * Tailscale's own DNS is not the scheduler's.
 */
export async function toggleTunnel(
	action: { readonly kind: TunnelKind; readonly on: boolean },
	deps: TunnelToggleDeps,
): Promise<unknown> {
	const result = await switchOf(action, deps)()

	// Not awaited: see `reconfigureMonitoring`.
	void deps.reconfigureMonitoring().catch(() => undefined)

	if (action.kind === "cloudflare" && action.on) await deps.sleep(DNS_WARMUP_DELAY_MS)
	return result
}

function switchOf(
	action: { readonly kind: TunnelKind; readonly on: boolean },
	deps: TunnelToggleDeps,
): () => Promise<unknown> {
	if (action.kind === "cloudflare") return action.on ? deps.enableTunnel : deps.disableTunnel
	return action.on ? deps.enableTailscale : deps.disableTailscale
}

/** What the check route needs from the machine. */
export interface TailscaleCheckDeps {
	readonly installed: () => boolean
	readonly customDaemonRunning: () => Promise<boolean>
	readonly systemDaemonRunning: () => boolean
	readonly loggedIn: () => boolean
	readonly hasCachedPassword: () => Promise<boolean>
	readonly platform: () => string
	readonly brewAvailable: () => Promise<boolean>
}

/**
 * `GET /api/tunnel/tailscale-check` — what Tailscale looks like here.
 *
 * The three probes run together, and none of them runs at all when Tailscale is not
 * installed: probing a daemon that cannot exist costs a timeout per poll, and reports
 * "not running" for something that was never there.
 */
export async function checkTailscale(deps: TailscaleCheckDeps): Promise<TailscaleCheckAnswer> {
	const installed = deps.installed()
	const platform = deps.platform()

	const [brewAvailable, customDaemonRunning, systemDaemonRunning] = await Promise.all([
		platform === "darwin" ? deps.brewAvailable() : Promise.resolve(false),
		installed ? deps.customDaemonRunning() : Promise.resolve(false),
		installed ? Promise.resolve(deps.systemDaemonRunning()) : Promise.resolve(false),
	])

	const daemonRunning = customDaemonRunning || systemDaemonRunning
	return {
		installed,
		loggedIn: daemonRunning ? deps.loggedIn() : false,
		platform,
		brewAvailable,
		daemonRunning,
		customDaemonRunning,
		systemDaemonRunning,
		hasCachedPassword: await deps.hasCachedPassword(),
	}
}

/** What the installer needs, and how it reports progress. */
export interface TailscaleInstallDeps {
	readonly platform: () => string
	readonly brewAvailable: () => boolean
	readonly cachedPassword: () => Promise<string | null>
	readonly shortId: () => string
	/** Run the install, calling `report` for each line of progress. */
	readonly install: (input: {
		password: string
		shortId: string
		report: (message: string) => void
	}) => Promise<{ authUrl?: string | null }>
}

/**
 * The gate in front of `POST /api/tunnel/tailscale-install`.
 *
 * Returns the password to install with, or refuses before the stream opens. Refusing here
 * rather than inside the stream is what lets the screen show the error in the form it
 * belongs to, instead of an event nobody styled.
 */
export async function prepareTailscaleInstall(
	body: Record<string, unknown>,
	deps: TailscaleInstallDeps,
): Promise<{ password: string; shortId: string }> {
	const platform = deps.platform()
	const brewAvailable = platform === "darwin" ? deps.brewAvailable() : false
	const cached = await deps.cachedPassword()

	const password = installPasswordOf({
		sent: body.sudoPassword,
		cached,
		required: installNeedsPassword(platform, brewAvailable),
	})
	if ("error" in password) throw invalid(password.error)

	return { password: password.password, shortId: deps.shortId() }
}

/** The terminal event of an install stream. */
export type InstallEvent =
	| { readonly event: "done"; readonly data: { success: true; authUrl: string | null } }
	| { readonly event: "error"; readonly data: { error: string } }

/**
 * Run the install, reporting each step, and answer the terminal event.
 *
 * `done` carries the auth URL when there is one; `error` carries the message. They are
 * distinct events because the screen treats them differently — one closes the dialog, the
 * other keeps it open with the reason. A failed install is not thrown: the stream has
 * already answered 200, so the failure has to travel as an event.
 */
export async function runTailscaleInstall(
	prepared: { password: string; shortId: string },
	deps: Pick<TailscaleInstallDeps, "install">,
	reportProgress: (message: string) => void,
): Promise<InstallEvent> {
	try {
		const result = await deps.install({
			password: prepared.password,
			shortId: prepared.shortId,
			report: reportProgress,
		})
		return { event: "done", data: { success: true, authUrl: result.authUrl ?? null } }
	} catch (error) {
		return {
			event: "error",
			data: { error: installFailureOf(error instanceof Error ? error.message : undefined) },
		}
	}
}
