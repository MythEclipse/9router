/**
 * Hermes settings across one profile, or every profile at once.
 *
 * Hermes keeps its configuration in `config.yaml` and its key in `.env`, both per profile home.
 * `domain/hermes-yaml` already knows every block — model, delegation, auxiliary roles, speech to
 * text — and `domain/hermes-profiles` knows which directory a profile name means. This file is
 * the three verbs over them, plus the policies the route used to hold inline:
 *
 * - **Write nothing into a profile the operator did not create.** A named profile home is made by
 *   `hermes profile create`; this code creates the default home when asked but never fabricates a
 *   named one.
 * - **Only touch the blocks this install wrote.** A model block pointing at another provider is
 *   the operator's own configuration and survives a reset.
 * - **`.env` carries more than our key.** Per-profile env files hold bot tokens and channel
 *   credentials, so only the `OPENAI_API_KEY` line is ever upserted, and only when the caller
 *   supplied a key.
 */

import { resetHermesSettings } from "./hermes-reset.ts"
import { writeHermesSettings } from "./hermes-write.ts"

export { resetHermesSettings } from "./hermes-reset.ts"
export type {
	HermesAnswer,
	HermesFilesPort,
	HermesHomeView,
	HermesProfileSummary,
} from "./hermes-types.ts"
export { writeHermesSettings } from "./hermes-write.ts"

import { homeExists, homeFor, notFound, profileOf, upsertEnvVar } from "./hermes-helpers.ts"
import type {
	HermesAnswer,
	HermesFilesPort,
	HermesHomeView,
	HermesProfileSummary,
	Selection,
} from "./hermes-types.ts"

export { upsertEnvVar }

import { InvalidProfileNameError } from "../../domain/hermes-profiles.ts"
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
	upsertModelBlock,
	upsertStt9Router,
} from "../../domain/hermes-yaml.ts"

/**
 * The whole settings screen for one profile.
 *
 * An uninstalled Hermes answers 200 with `installed: false`, because the screen renders an
 * explanation rather than an error page — the same tolerance the other tools have.
 */
export async function readHermesSettings(
	profile: unknown,
	port: HermesFilesPort,
): Promise<HermesAnswer> {
	try {
		if (!(await port.isInstalled())) {
			return {
				status: 200,
				body: { installed: false, settings: null, message: "Hermes Agent is not installed" },
			}
		}

		const target = homeFor(profile, port)
		if ("status" in target) return target
		const { home } = target
		if (!(await homeExists(home, port))) return notFound(home)

		const yaml = await port.readConfig(home)
		const model = parseModelBlock(yaml)
		const delegation = parseDelegationBlock(yaml)
		const auxiliary = parseAuxRoles(yaml)
		const stt = parseSttBlock(yaml)

		return {
			status: 200,
			body: {
				installed: true,
				profile: profileOf(home),
				settings: { model, delegation, auxiliary, stt },
				has9Router:
					has9RouterConfig(model) ||
					has9RouterConfig(delegation) ||
					Object.values(auxiliary).some(has9RouterConfig),
				has9RouterStt: is9RouterStt(stt),
				configPath: home.configPath,
			},
		}
	} catch (error) {
		return {
			status: 500,
			body: {
				error:
					error instanceof InvalidProfileNameError ? error.message : "Failed to check hermes settings",
			},
		}
	}
}

/** One slot a write touches: `default`, `delegation`, or an auxiliary role. */

const truthy = (value: unknown): boolean => value === true || value === "true" || value === "1"

/**
 * The slots a write should touch.
 *
 * `selections` is the bag of roles the screen sends — `default` plus any auxiliary or delegation
 * slot. A legacy CLI caller sends a bare `model`, which means the default role; an entry without
 * both fields is dropped rather than guessed at.
 */
function selectionsOf(input: { model?: unknown; selections?: unknown }): Selection[] {
	const raw = input.selections
	const isSelection = (value: unknown): value is Selection => {
		const candidate = value as Selection | null
		return Boolean(candidate?.role && candidate?.model)
	}
	if (Array.isArray(raw) && raw.some(isSelection)) return raw.filter(isSelection)
	return typeof input.model === "string" && input.model
		? [{ role: "default", model: input.model }]
		: []
}

/**
 * Applies endpoint and key to a single profile.
 *
 * Each role block is upserted by name, so the operator's other roles and their own YAML survive.
 * The audio section is the subtlety: disabling audio removes *only* the wiring this endpoint
 * wrote — a user's own STT provider choice is left alone, which is why the check is `is9RouterStt`
 * before `removeStt9Router` and not simply "remove the block".
 */
export async function listHermesProfiles(
	port: HermesFilesPort,
): Promise<{ profiles: HermesProfileSummary[] }> {
	return { profiles: await port.listProfiles() }
}

/** The env key this flow is allowed to touch. */
export const HERMES_API_KEY_ENV = "OPENAI_API_KEY"
