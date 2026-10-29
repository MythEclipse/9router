/**
 * Model availability and cooldown clearing.
 *
 * The listing and the clear used to parse the `modelLock_<model>` convention
 * independently, so the list could show a lock the clear could not find. Both
 * go through `domain/model-availability.ts` now.
 *
 * Clearing is deliberately narrow: it touches only the connections actually
 * holding that lock. An earlier shape patched every connection for the provider,
 * which reset the failure counters of a healthy connection because a *different*
 * one was cooling down.
 */
import { invalid } from "../../domain/errors.ts"
import {
	type AvailabilityConnection,
	type AvailabilityRow,
	availabilityRows,
	clearLockPatch,
	connectionsWithLock,
} from "../../domain/model-availability.ts"
import type { ProviderConnectionPort } from "./ports.ts"

export interface AvailabilityDependencies {
	readonly connections: ProviderConnectionPort
	readonly now: () => Date
}

export function makeModelAvailability({ connections, now }: AvailabilityDependencies) {
	return {
		async list(): Promise<{ models: AvailabilityRow[]; unavailableCount: number }> {
			const rows = await connections.list()
			const models = availabilityRows(rows as AvailabilityConnection[], now().getTime())
			return { models, unavailableCount: models.length }
		},

		/**
		 * Clear one model's cooldown across the provider's connections.
		 *
		 * Returns how many connections were actually patched, so the dashboard can
		 * say "nothing was cooling down" instead of always reporting success.
		 */
		async clearCooldown(input: {
			action: unknown
			provider: unknown
			model: unknown
		}): Promise<{ cleared: number }> {
			if (input.action !== "clearCooldown" || !input.provider || !input.model) {
				throw invalid("Invalid request")
			}
			const provider = String(input.provider)
			const model = String(input.model)
			const candidates = (await connections.list({ provider })) as AvailabilityConnection[]
			const locked = connectionsWithLock(candidates, model)

			await Promise.all(
				locked.map((connection) =>
					connections.update(connection.id, clearLockPatch(connection, model)),
				),
			)
			return { cleared: locked.length }
		},
	}
}

export type ModelAvailability = ReturnType<typeof makeModelAvailability>
