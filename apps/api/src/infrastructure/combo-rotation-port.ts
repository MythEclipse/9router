/**
 * Combo rotation adapter.
 *
 * Rotation state — which member a combo served last — lives in the gateway's
 * module memory, not the database. The API process cannot reach that map
 * directly, and pretending otherwise by importing the gateway module here would
 * create a second copy that resets nothing the gateway reads.
 *
 * So this adapter does the only honest thing available: it POSTs an invalidation
 * to the gateway. When no gateway URL is configured the reset is a no-op, which
 * is correct for a standalone API or a test.
 */
import type { ComboRotationPort } from "../application/dependencies.ts"

export interface RotationAdapterOptions {
	/** Base URL of the running gateway, e.g. `http://127.0.0.1:20128`. */
	readonly gatewayUrl?: string
	readonly fetchImpl?: typeof fetch
	/** Reported so a silent fan-out failure is visible in the API log. */
	readonly onError?: (error: unknown) => void
}

export function createComboRotationPort(options: RotationAdapterOptions = {}): ComboRotationPort {
	const doFetch = options.fetchImpl ?? fetch
	const base = options.gatewayUrl?.replace(/\/+$/, "")

	return {
		reset(comboName: string) {
			if (!base) return
			// Fire and forget: the caller has already committed its write and must
			// not fail because the gateway is restarting. A stale rotation entry is
			// recoverable; a failed save is not.
			void doFetch(`${base}/api/internal/combo-rotation/reset`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ comboName }),
			}).catch((error) => options.onError?.(error))
		},
	}
}
