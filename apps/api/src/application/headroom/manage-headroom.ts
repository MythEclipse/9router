/**
 * Headroom's local proxy: start, restart, and the compression extras it can carry.
 *
 * `start` and `restart` were the same fifty lines twice, including the same gate and the
 * same failure mapping. They are one function here with a different action, because the
 * only thing that ever differed was which process call ran at the end.
 *
 * **The gate runs before the process call, always.** A remote Headroom URL belongs to
 * whoever runs it; starting "it" locally spawns a proxy the configured URL never reaches,
 * so the dashboard would show a healthy proxy while every request went somewhere else.
 * `restart` is gated the same way: a restart of a proxy this install never started is not a
 * restart.
 *
 * **A failure carries its own status.** `NOT_INSTALLED` is the caller's problem — they must
 * install Headroom — and answering 500 tells them to retry something that cannot work until
 * they do something else. The code sets differ per operation, so `headroomFailureStatus`
 * takes the set as an argument rather than merging them.
 */

import { AppError } from "../../domain/errors.ts"
import {
	externalProxyRefusal,
	headroomFailureStatus,
	headroomStartOptions,
	headroomStartPort,
	headroomStopStatus,
	headroomUrl,
	INSTALL_CLIENT_ERROR_CODES,
	START_CLIENT_ERROR_CODES,
	UNINSTALL_CLIENT_ERROR_CODES,
} from "../../domain/headroom-lifecycle.ts"

/** The process manager and the python probe, supplied by the host that owns them. */
export interface HeadroomDeps {
	/**
	 * The URL this install talks to when nothing is configured.
	 *
	 * Supplied by the host rather than held here: which port Headroom's own client expects is
	 * a fact about the install, not a rule about the lifecycle.
	 */
	readonly defaultUrl: string
	/** Whether a URL points at this machine. Only then may a proxy be started here. */
	readonly isLoopback: (url: unknown) => boolean
	readonly start: (options: StartOptions) => Promise<Record<string, unknown>>
	readonly restart: (options: StartOptions) => Promise<Record<string, unknown>>
	readonly stop: () => { readonly stopped?: boolean } & Record<string, unknown>
	/** Everything the status screen needs: installed, running, and the managed pid. */
	readonly detect: (url: string) => Promise<Record<string, unknown>>
	readonly managedPid: () => number | null
	readonly findPython: () => string | null
	readonly installedExtras: (python: string | null) => Record<string, unknown>
	readonly availableExtras: readonly string[]
	/**
	 * `unknown`, not a record: the host's extras installer predates this layer and answers
	 * `unknown`. Narrowing it here would mean a cast in the host, which hides the same
	 * uncertainty one file further from where it matters.
	 */
	readonly installExtras: (extras: readonly unknown[]) => Promise<unknown>
	readonly uninstallExtras: (extras: readonly unknown[]) => Promise<unknown>
	readonly installLogTail: (maxLines?: number) => string
	/** The settings row the configured URL and the two feature flags come from. */
	readonly readSettings: () => Promise<Record<string, unknown> | null>
}

/** How a proxy is started: where, and the two features the settings screen toggles. */
export interface StartOptions {
	readonly port: number
	readonly codeAware: boolean
	readonly kompress: boolean
}

/** A lifecycle call, once the settings have been read and the gate has passed. */
export interface LifecyclePlan extends StartOptions {
	readonly url: string
}

/**
 * Run a lifecycle call, translating a failure into an error that carries its status.
 *
 * The status cannot come from the code alone: `NOT_INSTALLED` is 400 for `start` and is not
 * even a client error for uninstall. `headroomFailureStatus` decides it from the set the
 * operation passes in.
 */
async function lifecycleCall<T>(
	run: () => Promise<T>,
	clientCodes: ReadonlySet<string>,
): Promise<T> {
	try {
		return await run()
	} catch (error) {
		const failure = error as { readonly code?: unknown; readonly message?: unknown } | null
		throw new AppError(
			clientCodes.has(String(failure?.code ?? "")) ? "VALIDATION" : "INTERNAL",
			typeof failure?.message === "string" ? failure.message : "Headroom failed",
			{ status: headroomFailureStatus(failure, clientCodes), cause: error },
		)
	}
}

/** What the headroom namespace offers. */
export interface HeadroomLifecycle {
	/** Read the settings, refuse a remote URL, and decide the port and the two flags. */
	readonly plan: () => Promise<LifecyclePlan>
	readonly start: () => Promise<Record<string, unknown>>
	readonly restart: () => Promise<Record<string, unknown>>
	readonly stop: () => Record<string, unknown> & { readonly status: number }
	readonly status: () => Promise<Record<string, unknown>>
	readonly extras: {
		readonly read: (input: { readonly log?: boolean }) => Record<string, unknown>
		readonly install: (extras: readonly unknown[]) => Promise<unknown>
		readonly uninstall: (extras: readonly unknown[]) => Promise<unknown>
	}
}

export function makeHeadroom(deps: HeadroomDeps): HeadroomLifecycle {
	const { defaultUrl } = deps

	const configuredUrl = async () => headroomUrl(await deps.readSettings(), defaultUrl)

	const plan = async (): Promise<LifecyclePlan> => {
		const settings = await deps.readSettings()
		const url = headroomUrl(settings, defaultUrl)
		const refusal = externalProxyRefusal(url, deps.isLoopback)
		if (refusal) {
			// 400 rather than 403: the URL is wrong for this operation, not the caller's
			// identity — the same request works once they point it at a local proxy.
			throw new AppError("VALIDATION", refusal.message, {
				status: 400,
				data: { code: refusal.code },
			})
		}
		return { url, port: headroomStartPort(url), ...headroomStartOptions(settings) }
	}

	const run = async (call: (options: StartOptions) => Promise<Record<string, unknown>>) => {
		const planned = await plan()
		const result = await lifecycleCall(() => call(planned), START_CLIENT_ERROR_CODES)
		return { success: true, ...result }
	}

	return {
		plan,
		start: () => run(deps.start),
		restart: () => run(deps.restart),
		stop: () => {
			const result = deps.stop()
			// Nothing to stop is 409, not 200: the caller asked for a state change that did
			// not happen, and 200 leaves the dashboard showing "stopped" for a proxy it never
			// had. The status travels with the answer because the body is the same either way.
			return { ...result, status: headroomStopStatus(result) }
		},
		status: async () => {
			const url = await configuredUrl()
			return { ...(await deps.detect(url)), url, managedPid: deps.managedPid() }
		},
		extras: {
			read: ({ log }) => {
				if (log) return { log: deps.installLogTail() }
				return {
					available: deps.availableExtras,
					...deps.installedExtras(deps.findPython()),
				}
			},
			install: (extras) => lifecycleCall(() => deps.installExtras(extras), INSTALL_CLIENT_ERROR_CODES),
			uninstall: (extras) =>
				lifecycleCall(() => deps.uninstallExtras(extras), UNINSTALL_CLIENT_ERROR_CODES),
		},
	}
}
