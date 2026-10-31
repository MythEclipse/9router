/**
 * Export captured requests as a translator regression suite.
 *
 * The port is deliberately narrow — one id, or a page of recent captures — because the caller
 * (a dashboard button, a CI job) always knows which requests it wants. Filtering happens in the
 * repository, which already knows how to page and how to apply a model allow-list.
 */
import {
	type CapturedDetail,
	type ReplayCase,
	replayCasesOf,
	vitestSource,
} from "../../domain/replay-case.ts"

export interface ReplayPorts {
	/** One capture by id, or `null` when it has aged out of the log. */
	readonly byId: (id: string) => Promise<CapturedDetail | null>
	/** The most recent captures, newest first. */
	readonly recent: (limit: number) => Promise<readonly CapturedDetail[]>
}

export interface ReplaySuite {
	readonly cases: readonly ReplayCase[]
	readonly skipped: number
	readonly source: string
}

export interface ReplayUseCase {
	readonly fromIds: (ids: readonly string[]) => Promise<ReplaySuite>
	readonly fromRecent: (limit: number) => Promise<ReplaySuite>
}

/** How many captures a request may ask for. Beyond this the file stops being reviewable. */
const MAX_LIMIT = 50

export function makeReplay(ports: ReplayPorts): ReplayUseCase {
	/** `missing` counts ids that aged out of the log, which are skipped rather than fatal. */
	async function suiteOf(details: readonly CapturedDetail[], missing = 0): Promise<ReplaySuite> {
		const cases = replayCasesOf(details)
		return {
			cases,
			skipped: missing + details.length - cases.length,
			source: vitestSource(cases),
		}
	}

	return {
		async fromIds(ids) {
			const asked = ids.slice(0, MAX_LIMIT)
			const found = await Promise.all(asked.map((id) => ports.byId(id)))
			const details = found.filter((detail): detail is CapturedDetail => detail !== null)
			return suiteOf(details, asked.length - details.length)
		},

		async fromRecent(limit) {
			const safe = Math.min(Math.max(Math.trunc(limit) || 10, 1), MAX_LIMIT)
			return suiteOf(await ports.recent(safe))
		},
	}
}
