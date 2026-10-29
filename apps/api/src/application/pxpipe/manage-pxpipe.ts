/**
 * The pxpipe controls: status, start, stop, reload, install, health, stats, logs.
 *
 * "Start" and "stop" in this mode do not spawn a process — they warm and drop an
 * in-process module, and requests fall back to uncompressed passthrough when it
 * is dropped. That is why `stop` reports `stopped: false` when nothing was
 * loaded: the caller asked to stop something that was not running, and the
 * distinction is worth keeping.
 *
 * The engine reaches into the filesystem and npm, so every touch is behind a
 * port. The rules that used to be inline in the handlers live here:
 *
 *  - starting auto-installs only when the operator allowed it, and answers 409
 *    (not 500) when it did not — "not installed" is a state, not a failure;
 *  - install reloads before the health check, because health must observe the
 *    fresh module rather than the one still in memory;
 *  - the list limit has a floor and a ceiling instead of `x || 100`, which let
 *    `?limit=-5` through to a negative slice.
 */

import { conflict } from "../../domain/errors.ts"
import { readListLimit } from "../../domain/list-limit.ts"

/** Everything the module knows about itself. */
export interface PxpipeStatus {
	readonly [field: string]: unknown
}

export interface PxpipeHealth {
	readonly healthy: boolean
	readonly checks: readonly unknown[]
	readonly [field: string]: unknown
}

export interface PxpipeInstallInfo {
	readonly installed: boolean
	readonly [field: string]: unknown
}

export interface PxpipePort {
	status(): PxpipeStatus
	installInfo(): PxpipeInstallInfo
	install(): Promise<PxpipeInstallInfo>
	load(): Promise<void>
	/** Returns whether anything was actually loaded. */
	unload(): boolean
	health(): Promise<PxpipeHealth>
	stats(input: { recentLimit: number }): unknown
	readEvents(input: { limit: number }): readonly unknown[]
	installLogTail(): string
}

export interface PxpipeSettings {
	/** The operator's panel settings, mirrored onto the status payload. */
	read(): Promise<{
		readonly enabled: boolean
		readonly autoInstall: boolean
		readonly minChars: unknown
		readonly timeoutMs: unknown
	}>
}

export function makePxpipe(engine: PxpipePort, settings: PxpipeSettings) {
	return {
		/** Status with the operator's settings folded in, as the card expects. */
		async status(): Promise<PxpipeStatus> {
			const current = engine.status()
			const config = await settings.read()
			return {
				...current,
				enabled: config.enabled,
				autoInstall: config.autoInstall,
				minChars: config.minChars,
				timeoutMs: config.timeoutMs,
			}
		},

		/**
		 * Warm the module, installing first only when the operator allowed it.
		 *
		 * 409 rather than 500 for "not installed": nothing failed, the operator
		 * simply has auto-install off, and the dashboard shows a different message
		 * for each.
		 */
		async start(): Promise<PxpipeStatus> {
			if (!engine.installInfo().installed) {
				const config = await settings.read()
				if (!config.autoInstall) {
					throw conflict("PXPIPE is not installed")
				}
				await attempt(() => engine.install())
			}
			await attempt(() => engine.load())
			return engine.status()
		},

		/** `stopped` reports whether anything was actually loaded. */
		async stop(): Promise<PxpipeStatus & { stopped: boolean }> {
			const stopped = engine.unload()
			return { stopped, ...engine.status() }
		},

		/** Pick up an upgraded install without restarting the server. */
		async reload(): Promise<PxpipeStatus> {
			engine.unload()
			await attempt(() => engine.load())
			return engine.status()
		},

		/** Reinstall at latest, drop the old module, then health-check the new one. */
		async install(): Promise<PxpipeInstallInfo & { health: PxpipeHealth }> {
			const info = await attempt(() => engine.install())
			// Order matters: health must load the fresh module, not the cached one.
			engine.unload()
			const health = await engine.health()
			return { ...info, health }
		},

		async checkHealth(): Promise<PxpipeHealth> {
			return attempt(() => engine.health())
		},

		async stats(rawLimit: string | null | undefined): Promise<unknown> {
			const { limit } = readListLimit(rawLimit)
			return engine.stats({ recentLimit: limit })
		},

		/** Newest first, because the panel renders it top-down. */
		async logs(rawLimit: string | null | undefined): Promise<{
			installLog: string
			events: readonly unknown[]
			limit: number
			adjusted: boolean
		}> {
			const { limit, adjusted } = readListLimit(rawLimit)
			const events = engine.readEvents({ limit }).slice().reverse()
			return { installLog: engine.installLogTail(), events, limit, adjusted }
		},
	}
}

/** Wraps an engine throw that the routes used to surface as a raw 500. */
export function pxpipeFailure(error: unknown): never {
	const message = error instanceof Error ? error.message : "pxpipe operation failed"
	// The engine already distinguishes "npm is missing" from "nothing is installed";
	// collapsing those into one generic 500 is what made the panel unable to tell
	// the operator what to fix.
	const code =
		typeof error === "object" && error !== null && "code" in error
			? (error as { code: unknown }).code
			: undefined
	throw new PxpipeError(message, typeof code === "string" ? code : "INTERNAL", error)
}

/** An engine failure, keeping the engine's own code alongside the message. */
export class PxpipeError extends Error {
	readonly code: string
	readonly appCode = "INTERNAL"

	constructor(message: string, code: string, cause: unknown) {
		super(message, { cause })
		this.name = "PxpipeError"
		this.code = code
	}
}

/**
 * Run an engine call, translating its failure into a typed one.
 *
 * The handlers used to answer `{error: error.message}` with a 500 for every
 * failure, so "npm is not on PATH" and "the module threw" were the same response.
 * The engine's own `code` is carried through so the panel can word it.
 */
async function attempt<T>(step: () => Promise<T>): Promise<T> {
	try {
		return await step()
	} catch (error) {
		pxpipeFailure(error)
	}
}
