import { markAccountEmptyResponse } from "../../services/auth.ts"

/**
 * Build the `onEmptyResponse` callback for a combo run.
 *
 * `combo.ts` sees only the model string, but account health is keyed by
 * connection. `lastServedConnection` is filled by the single-model path as it
 * picks a credential, so by the time a member reports an empty answer we know
 * which account produced it — and only that account takes the strike.
 */
export function emptyResponseReporter(
	lastServedConnection: { model?: string; connectionId?: string; provider?: string } | null,
) {
	return async (modelStr: string, reason: string) => {
		if (!lastServedConnection?.connectionId) return
		// Guard against a stale slot: the combo may already have moved to a different
		// member, in which case this account did not produce the empty answer.
		if (lastServedConnection.model && lastServedConnection.model !== modelStr) return
		await markAccountEmptyResponse(
			lastServedConnection.connectionId,
			lastServedConnection.provider ?? null,
			reason,
		)
	}
}
