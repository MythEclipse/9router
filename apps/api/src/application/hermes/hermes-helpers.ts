/** Hermes settings: shared helpers. */
import {
	buildAuxRoleBlock,
	buildDelegationBlock,
	buildModelBlock,
	has9RouterConfig,
	is9RouterStt,
	isCustomBlock,
	parseAuxRoles,
	parseDelegationBlock,
	parseModelBlock,
	parseSttBlock,
	removeAuxRole,
	removeDelegationBlock,
	removeModelBlock,
	removeStt9Router,
	upsertAuxRole,
	upsertDelegationBlock,
	upsertEnvVar,
	upsertModelBlock,
	upsertStt9Router,
} from "../../domain/hermes-yaml.ts"

export { upsertEnvVar }

import type { HermesAnswer, HermesFilesPort, HermesHomeView } from "./hermes-types.ts"

/** The provider name this install writes into every block. */
export const PROVIDER_NAME = "9router"
export const API_KEY_ENV = "OPENAI_API_KEY"

/** The profile fields the screen shows. */
export const profileOf = (home: HermesHomeView) => ({
	name: home.name,
	dir: home.dir,
	isDefault: home.isDefault,
})

/** An absent named home is a 404; the default home always counts as present. */
export const homeExists = async (home: HermesHomeView, port: HermesFilesPort): Promise<boolean> =>
	home.isDefault || port.dirExists(home.dir)

export const notFound = (home: HermesHomeView): HermesAnswer => ({
	status: 404,
	body: { error: `Hermes profile "${home.name}" not found` },
})

/** Resolves a profile name, or the answer to return instead. */
export const homeFor = (
	profile: unknown,
	port: HermesFilesPort,
): { home: HermesHomeView } | HermesAnswer => {
	const resolved = port.resolve(profile)
	return "error" in resolved ? { status: 400, body: { error: resolved.error } } : resolved
}
