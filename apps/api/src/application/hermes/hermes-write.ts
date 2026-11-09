/** Hermes settings: write flow. */
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
	removeStt9Router,
	upsertAuxRole,
	upsertDelegationBlock,
	upsertEnvVar,
	upsertModelBlock,
	upsertStt9Router,
} from "../../domain/hermes-yaml.ts"
import {
	API_KEY_ENV,
	homeExists,
	homeFor,
	notFound,
	PROVIDER_NAME,
	profileOf,
} from "./hermes-helpers.ts"
import type { HermesAnswer, HermesFilesPort, Selection } from "./hermes-types.ts"

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
export async function writeHermesSettings(
	body: unknown,
	port: HermesFilesPort,
): Promise<HermesAnswer> {
	const input = (body ?? {}) as {
		baseUrl?: unknown
		apiKey?: unknown
		model?: unknown
		selections?: unknown
		audio?: { enabled?: unknown; model?: unknown }
		applyToAll?: unknown
		profile?: unknown
	}

	const selections = selectionsOf(input)
	const defaultSelection = selections.find((s) => s.role === "default")
	if (!input.baseUrl || (!defaultSelection && !input.audio)) {
		return { status: 400, body: { error: "baseUrl and model are required" } }
	}

	const audioEnabled = truthy(input.audio?.enabled)
	const audioModel = typeof input.audio?.model === "string" ? input.audio.model.trim() : ""
	if (audioEnabled && !audioModel) {
		return {
			status: 400,
			body: { error: "audio.model is required when enabling audio transcription" },
		}
	}

	const baseUrl = String(input.baseUrl)
	const normalisedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`
	const apiKey = typeof input.apiKey === "string" ? input.apiKey : ""

	// A bulk apply refreshes endpoint and key only; the audio wiring is per-profile and follows
	// the single-profile path below.
	if (truthy(input.applyToAll)) {
		return applyToAllProfiles({
			port,
			normalisedBaseUrl,
			apiKey,
			model: defaultSelection?.model,
		})
	}

	const target = homeFor(input.profile, port)
	if ("status" in target) return target
	const { home } = target
	if (!(await homeExists(home, port))) return notFound(home)

	try {
		let yaml = await port.readConfig(home)
		for (const { role, model } of selections) {
			if (role === "default") {
				yaml = upsertModelBlock(yaml, buildModelBlock(model, normalisedBaseUrl))
			} else if (role === "delegation") {
				yaml = upsertDelegationBlock(yaml, buildDelegationBlock(model, normalisedBaseUrl))
			} else {
				yaml = upsertAuxRole(yaml, role, buildAuxRoleBlock(role, model, normalisedBaseUrl))
			}
		}

		if (input.audio) {
			if (audioEnabled) {
				yaml = upsertStt9Router(yaml, audioModel, normalisedBaseUrl)
			} else if (is9RouterStt(parseSttBlock(yaml))) {
				yaml = removeStt9Router(yaml)
			}
		}

		await port.writeConfig(home, yaml)
		await port.writeEnvKey(home, apiKey)

		return {
			status: 200,
			body: {
				success: true,
				message: home.isDefault
					? "Hermes settings applied successfully!"
					: `Hermes settings applied to profile "${home.name}"!`,
				profile: profileOf(home),
				stt9Router: is9RouterStt(parseSttBlock(yaml)),
				configPath: home.configPath,
			},
		}
	} catch (error) {
		return {
			status: 500,
			body: { error: error instanceof Error ? error.message : "Failed to update hermes settings" },
		}
	}
}

/**
 * Refreshes exactly the blocks each profile already has, and wires up the ones with no model.
 *
 * The three outcomes are the policy:
 *
 * - a main model this install wrote is refreshed, along with its delegation and auxiliary blocks
 *   *if those are ours too*;
 * - a main model on another provider is **reported, never rewritten** — that is the operator's
 *   choice, and silently repointing it would break their setup;
 * - a profile with no main model is wired up from the model in this request.
 *
 * Models stay per-profile: the request's model only fills a gap, it never overwrites one. A
 * profile that fails is reported as `failed` with its reason and does not stop the others.
 */
async function applyToAllProfiles(options: {
	port: HermesFilesPort
	normalisedBaseUrl: string
	apiKey: string
	model: string | undefined
}): Promise<HermesAnswer> {
	const { port, normalisedBaseUrl, apiKey, model } = options
	const profiles = await port.listProfiles()
	const results: Record<string, unknown>[] = []

	for (const profile of profiles) {
		const resolved = port.resolve(profile.name)
		if ("error" in resolved) {
			results.push({ profile: profile.name, status: "failed", reason: resolved.error })
			continue
		}
		const { home } = resolved

		try {
			let yaml = await port.readConfig(home)
			const main = parseModelBlock(yaml)

			if (main?.default && isCustomBlock(main)) {
				yaml = upsertModelBlock(yaml, buildModelBlock(main.default, normalisedBaseUrl))
				const delegation = parseDelegationBlock(yaml)
				if (delegation?.model && isCustomBlock(delegation)) {
					yaml = upsertDelegationBlock(yaml, buildDelegationBlock(delegation.model, normalisedBaseUrl))
				}
				for (const [role, cfg] of Object.entries(parseAuxRoles(yaml))) {
					if (cfg?.model && isCustomBlock(cfg)) {
						yaml = upsertAuxRole(yaml, role, buildAuxRoleBlock(role, cfg.model, normalisedBaseUrl))
					}
				}
				await port.writeConfig(home, yaml)
				await port.writeEnvKey(home, apiKey)
				results.push({ profile: profile.name, status: "updated", model: main.default })
			} else if (main?.default) {
				results.push({
					profile: profile.name,
					status: "skipped",
					reason: `main model uses provider "${main.provider || "unknown"}" — configure this profile individually`,
				})
			} else if (model) {
				yaml = upsertModelBlock(yaml, buildModelBlock(model, normalisedBaseUrl))
				await port.writeConfig(home, yaml)
				await port.writeEnvKey(home, apiKey)
				results.push({ profile: profile.name, status: "updated", model })
			} else {
				results.push({
					profile: profile.name,
					status: "skipped",
					reason: "no main model configured",
				})
			}
		} catch (error) {
			results.push({
				profile: profile.name,
				status: "failed",
				reason: error instanceof Error ? error.message : "unknown error",
			})
		}
	}

	const updated = results.filter((r) => r.status === "updated").length
	return {
		status: 200,
		body: {
			success: updated > 0,
			bulk: true,
			results,
			updated,
			skipped: results.length - updated,
			message: `Updated endpoint on ${updated} profile(s)`,
		},
	}
}

/**
 * Removes the blocks this install wrote, keeping everything else.
 *
 * Every removal is conditional on `isCustomBlock` — a model, delegation or auxiliary block owned
 * by another provider is this profile's own configuration. `kept` names what survived so the
 * screen can say so instead of leaving the operator wondering.
 *
 * A profile with no `config.yaml` answers success with "No config file to reset": there is
 * nothing to do, and a 404 would read as if the profile were missing.
 */
