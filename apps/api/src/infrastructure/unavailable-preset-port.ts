/**
 * Preset port for a process that owns no client catalogs.
 *
 * `apps/api` does not import `open-sse`, so it cannot build Cursor or Claude
 * preset lists. Rather than reimplement them — which is exactly the duplication
 * this migration removes — it reports every source as unknown, so the procedure
 * answers 400 instead of inventing a half-correct list.
 *
 * `apps/web` supplies the real adapter.
 */
import type { ComboPresetPort } from "../application/dependencies.ts"

export function createUnavailablePresetPort(): ComboPresetPort {
	return {
		isSource() {
			return false
		},
		async list() {
			return []
		},
	}
}
