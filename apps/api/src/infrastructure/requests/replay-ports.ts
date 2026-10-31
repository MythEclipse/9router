/**
 * The replay ports: the observability log, read by id or by page.
 *
 * No filtering beyond the limit lives here. A capture that has aged out of the log answers
 * `null`, and the use-case counts it as skipped rather than failing the whole export — a stale
 * bookmark should not cost the operator the other forty cases.
 */
import { getRequestDetailById, getRequestDetails } from "@9router/db/repos/requestDetailsRepo"
import type { ReplayPorts } from "../../application/requests/replay.ts"
import type { CapturedDetail } from "../../domain/replay-case.ts"

export function replayPorts(): ReplayPorts {
	return {
		byId: async (id) => (await getRequestDetailById(id)) as CapturedDetail | null,

		recent: async (limit) => {
			const page = await getRequestDetails({ page: 1, pageSize: limit })
			return page.details as CapturedDetail[]
		},
	}
}
