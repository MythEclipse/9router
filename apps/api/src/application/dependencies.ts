/**
 * Use-case dependency container.
 *
 * Every side effect a use-case needs arrives here. Use-cases never import a
 * database, a cache, or a framework — which is what makes them testable with
 * plain fakes and keeps the composition root the single wiring point.
 */
import type { IApiKeyRepository } from "../domain/api-key.ts"
import type { ChangelogSource } from "./changelog.ts"
import type { SettingsPort } from "./settings/login-gate.ts"

export interface IActivityRepository {
	record(entry: {
		action: string
		subject: string
		payload?: Record<string, unknown>
		at: Date
	}): Promise<void>
}

export interface Dependencies {
	readonly apiKeys: IApiKeyRepository
	readonly activity: IActivityRepository
	readonly changelog: ChangelogSource
	readonly settings: SettingsPort
	readonly now: () => Date
	/** Injected so tests can pin key material instead of hoping. */
	readonly randomId: () => string
}
