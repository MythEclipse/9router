/** Hermes settings: reset flow. */
import {
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
} from "../../domain/hermes-yaml.ts"
import { homeExists, homeFor, notFound, PROVIDER_NAME } from "./hermes-helpers.ts"
import type { HermesAnswer, HermesFilesPort } from "./hermes-types.ts"

export async function resetHermesSettings(
	body: unknown,
	port: HermesFilesPort,
): Promise<HermesAnswer> {
	const target = homeFor((body as { profile?: unknown } | null)?.profile, port)
	if ("status" in target) return target
	const { home } = target
	if (!(await homeExists(home, port))) return notFound(home)

	try {
		if (await port.configMissing(home)) {
			return {
				status: 200,
				body: { success: true, profile: home.name, message: "No config file to reset" },
			}
		}

		let yaml = await port.readConfig(home)
		const auxiliaryRemoved: string[] = []
		const kept: string[] = []

		let modelRemoved = false
		const main = parseModelBlock(yaml)
		if (main && isCustomBlock(main)) {
			yaml = removeModelBlock(yaml)
			modelRemoved = true
		} else if (main) {
			kept.push("model")
		}

		let delegationRemoved = false
		const delegation = parseDelegationBlock(yaml)
		if (delegation && isCustomBlock(delegation)) {
			yaml = removeDelegationBlock(yaml)
			delegationRemoved = true
		} else if (delegation) {
			kept.push("delegation")
		}

		for (const [role, cfg] of Object.entries(parseAuxRoles(yaml))) {
			if (isCustomBlock(cfg)) {
				yaml = removeAuxRole(yaml, role)
				auxiliaryRemoved.push(role)
			}
		}

		let sttRemoved = false
		const stt = parseSttBlock(yaml)
		if (stt && is9RouterStt(stt)) {
			yaml = removeStt9Router(yaml)
			sttRemoved = true
			// The operator's own keys inside the block (language, local, …) survive the
			// removal, so the remainder is reported as kept like any other kept section.
			if (parseSttBlock(yaml)) kept.push("stt")
		} else if (stt) {
			kept.push("stt")
		}

		await port.writeConfig(home, yaml.replace(/^\n+/, ""))

		const scope = home.isDefault ? "" : ` in profile "${home.name}"`
		return {
			status: 200,
			body: {
				success: true,
				profile: home.name,
				removed: {
					model: modelRemoved,
					delegation: delegationRemoved,
					auxiliary: auxiliaryRemoved,
					stt: sttRemoved,
				},
				kept,
				message: `${PROVIDER_NAME} model blocks removed${scope}`,
			},
		}
	} catch (error) {
		return {
			status: 500,
			body: { error: error instanceof Error ? error.message : "Failed to reset hermes settings" },
		}
	}
}
