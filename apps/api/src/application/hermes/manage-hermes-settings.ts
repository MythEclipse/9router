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
	upsertEnvVar,
	upsertModelBlock,
	upsertStt9Router,
} from "../../domain/hermes-yaml.ts"

/** The provider name this install writes into every block. */
const PROVIDER_NAME = "9router"
const API_KEY_ENV = "OPENAI_API_KEY"

/** One resolved profile home, as this layer passes it back to the port. */
export interface HermesHomeView {
	readonly name: string
	readonly dir: string
	readonly configPath: string
	readonly envPath: string
	readonly isDefault: boolean
}

/** One profile as the screen lists it. */
export interface HermesProfileSummary {
	readonly name: string
	readonly dir: string
	readonly isDefault: boolean
	readonly displayName: string | null
	readonly command: string
	readonly alias: string | null
	readonly model: string | null
	readonly baseUrl: string | null
	readonly has9Router: boolean
}

/** The file operations the Hermes flow needs, per profile home. */
export interface HermesFilesPort {
	/**
	 * The directory a profile name means, or the refusal.
	 *
	 * Returns the refusal rather than throwing so this layer can answer 400 with the message the
	 * domain chose, instead of catching an error type it would have to know about.
	 */
	readonly resolve: (profile: unknown) => { home: HermesHomeView } | { error: string }
	/** True when the named profile's home is a directory that exists. */
	readonly dirExists: (dir: string) => Promise<boolean>
	/** `config.yaml`, or "" when absent. Other failures are real and propagate. */
	readonly readConfig: (home: HermesHomeView) => Promise<string>
	/** `.env`, or "" when absent. */
	readonly readEnv: (home: HermesHomeView) => Promise<string>
	/** Creates the directory when the home is the default one, then writes `config.yaml`. */
	readonly writeConfig: (home: HermesHomeView, yaml: string) => Promise<void>
	/** Upserts only the API key line, and only when a key was supplied. */
	readonly writeEnvKey: (home: HermesHomeView, apiKey: string) => Promise<void>
	/** Used by `reset` to tell "no config yet" from a real read failure. */
	readonly configMissing: (home: HermesHomeView) => Promise<boolean>
	readonly isInstalled: () => Promise<boolean>
	/** Every profile on this machine, default first. */
	readonly listProfiles: () => Promise<HermesProfileSummary[]>
}

/** A flat answer, matching the other CLI-tool answers. */
export interface HermesAnswer {
	readonly status: number
	readonly body: Record<string, unknown>
}

/** The profile fields the screen shows. */
const profileOf = (home: HermesHomeView) => ({
	name: home.name,
	dir: home.dir,
	isDefault: home.isDefault,
})

/** An absent named home is a 404; the default home always counts as present. */
const homeExists = async (home: HermesHomeView, port: HermesFilesPort): Promise<boolean> =>
	home.isDefault || port.dirExists(home.dir)

const notFound = (home: HermesHomeView): HermesAnswer => ({
	status: 404,
	body: { error: `Hermes profile "${home.name}" not found` },
})

/** Resolves a profile name, or the answer to return instead. */
const homeFor = (
	profile: unknown,
	port: HermesFilesPort,
): { home: HermesHomeView } | HermesAnswer => {
	const resolved = port.resolve(profile)
	return "error" in resolved ? { status: 400, body: { error: resolved.error } } : resolved
}

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
interface Selection {
	readonly role: string
	readonly model: string
}

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

/**
 * Every profile on this machine.
 *
 * The list is whatever the host's directory walk found — the rule about which directory counts as
 * a profile lives in `domain/hermes-profiles` (`isProfileHome`), and the walk itself is host code
 * because it is filesystem access. Answering with an empty list rather than an error keeps the
 * picker usable on a machine where Hermes was never installed.
 */
export async function listHermesProfiles(
	port: HermesFilesPort,
): Promise<{ profiles: HermesProfileSummary[] }> {
	return { profiles: await port.listProfiles() }
}

/** The env key this flow is allowed to touch. */
export const HERMES_API_KEY_ENV = API_KEY_ENV

/** The upsert the environment port uses; exported so the host need not re-implement it. */
export { upsertEnvVar }
