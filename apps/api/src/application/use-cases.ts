/**
 * Composition of every use-case over one `Dependencies` graph.
 *
 * The single place that knows which use-case exists. Routers receive this
 * object, never the database, so wiring stays centralised and a test can build
 * the same shape from fakes.
 */

import { makeCreateApiKey } from "./api-keys/create-api-key.ts"
import { makeListApiKeys, makeRevokeApiKey } from "./api-keys/manage-api-keys.ts"
import { loadChangelog } from "./changelog.ts"
import type { Dependencies } from "./dependencies.ts"
import { readLoginGate } from "./settings/login-gate.ts"

export interface UseCases {
	readonly createApiKey: ReturnType<typeof makeCreateApiKey>
	readonly listApiKeys: ReturnType<typeof makeListApiKeys>
	readonly revokeApiKey: ReturnType<typeof makeRevokeApiKey>
	readonly getChangelog: () => ReturnType<typeof loadChangelog>
	readonly getLoginGate: () => ReturnType<typeof readLoginGate>
}

export function buildUseCases(deps: Dependencies): UseCases {
	return {
		createApiKey: makeCreateApiKey(deps),
		listApiKeys: makeListApiKeys(deps),
		revokeApiKey: makeRevokeApiKey(deps),
		getChangelog: () => loadChangelog(deps.changelog),
		getLoginGate: () => readLoginGate(deps.settings),
	}
}
