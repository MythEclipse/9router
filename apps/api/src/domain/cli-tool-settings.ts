/**
 * Writing a CLI tool's settings so it points at this install.
 *
 * Twenty tools each have their own config format, but they agree on three things the routes
 * had been spelling out separately, and the copies had drifted: what a usable base URL looks
 * like, what makes a request body acceptable, and how to tell whether the file already points
 * here. Only those three live in this file; a tool's own file layout stays with that tool.
 */

/**
 * How a tool wants its base URL spelled.
 *
 * Almost every OpenAI-compatible tool appends `/v1` to whatever it is given, so it must be
 * *told* the suffix. Cline is the exception: it appends nothing, so it must be told the URL
 * without it. Leaving this implicit is how the same screen ends up writing `…/v1/v1` for one
 * tool and `…/v1/chat/completions` for another.
 */
export type BaseUrlSuffix = "with-v1" | "without-v1"

/** The base URL in the spelling a tool expects. */
export function normaliseBaseUrl(baseUrl: string, suffix: BaseUrlSuffix = "with-v1"): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
	return suffix === "with-v1" ? `${trimmed}/v1` : trimmed
}

/** The hosts that identify this install. Localhost covers the default single-machine setup. */
export const THIS_INSTALL_HOSTS = ["localhost", "127.0.0.1", "9router"] as const

/**
 * Whether a stored base URL already points at this install.
 *
 * A tool's config can hold the URL in either spelling — what the operator typed, or what a
 * previous write normalised it to — and both count as configured. The comparison ignores case
 * for the same reason normalisation does: two strings that differ only there describe one
 * endpoint, and treating them as different makes the screen offer to configure a tool that is
 * already configured.
 */
export function pointsAtThisInstall(baseUrl: unknown, hosts: readonly string[]): boolean {
	if (typeof baseUrl !== "string") return false
	const value = baseUrl.trim().toLowerCase()
	return hosts.some((host) => value.includes(host.toLowerCase()))
}

/** The fields every tool's write needs, as the request carries them. */
export interface ToolSettingsInput {
	readonly baseUrl: string
	readonly apiKey: string
	readonly model: string
	/** Passed through untouched: which tool keeps a list, and in which shape, is its own business. */
	readonly models?: unknown
}

/** The result of reading a write, flat for the same reason the OAuth answers are. */
export interface ToolSettingsRead {
	readonly ok: boolean
	readonly error?: string
	readonly input?: ToolSettingsInput
}

/**
 * Reads the shared fields of a settings write.
 *
 * All three are required because a config missing any of them is one the tool will fail to
 * use — and it fails at request time, inside the tool, where the operator cannot see that the
 * cause was a settings screen that accepted half a form.
 *
 * The base URL is left as typed: which suffix it needs is the tool's business, and applying a
 * default here would silently override the one tool that wants the other spelling.
 */
export function readToolSettings(body: unknown): ToolSettingsRead {
	const fields = (body ?? {}) as Record<string, unknown>
	const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")

	const baseUrl = text(fields.baseUrl)
	const apiKey = text(fields.apiKey)
	const model = text(fields.model)
	if (!baseUrl || !apiKey || !model) {
		return { ok: false, error: "baseUrl, apiKey and model are required" }
	}
	return {
		ok: true,
		input: {
			baseUrl,
			apiKey,
			model,
			...(typeof fields.models === "undefined" ? {} : { models: fields.models }),
		},
	}
}

/**
 * Removes this install's entry from a config object, answering whether anything changed.
 *
 * Both spellings are deleted: the tool's own name for an OpenAI-compatible provider, and the
 * literal `9router` a previous version wrote. Leaving the old key behind means "reset" appears
 * not to work, because the next read still finds a configured tool.
 */
export function removeInstallEntry(
	config: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	let removed = false
	for (const key of keys) {
		if (key in config) {
			delete config[key]
			removed = true
		}
	}
	return removed
}

/** The message shown when a reset found nothing to remove. */
export const NOTHING_TO_RESET = "No settings file to reset"

/**
 * The JSON a settings file should hold, pretty-printed.
 *
 * Written with a trailing newline because these files are read by humans as often as by the
 * tool, and a file that ends mid-line shows up as a "\ No newline at end of file" diff.
 */
export function settingsFileText(config: Record<string, unknown>): string {
	return `${JSON.stringify(config, null, 2)}\n`
}

/**
 * A model entry as a tool records it, kept loose because tools add fields we never read.
 */
export type ModelEntry = Record<string, unknown>

/**
 * Reads a tool's model list, accepting the two shapes tools actually write.
 *
 * Some tools write `["gpt-4"]`, others `[{ id: "gpt-4", name: "GPT-4" }]`. Both mean the same
 * list, and a writer that only understood one would silently drop the other's models — which
 * for Pi means the model the operator selected stops existing on the next key change.
 */
export function readModelEntries(raw: unknown): ModelEntry[] {
	if (!Array.isArray(raw)) return []
	return raw.flatMap((entry) => {
		if (typeof entry === "string") return [{ id: entry }]
		if (entry && typeof entry === "object") return [entry as ModelEntry]
		return []
	})
}

/**
 * Merges the models a form sent over the models a tool already had.
 *
 * Identity is the model `id`, and an existing entry wins for every field the form did not
 * send: `contextWindow`, `maxTokens` and a `name` someone chose by hand cost the operator
 * effort, and a key rotation is not a reason to lose them.
 */
export function mergeModelEntries(existing: unknown, requested: unknown): ModelEntry[] {
	const previous = new Map<string, ModelEntry>()
	for (const entry of readModelEntries(existing)) {
		const id = entry.id
		if (typeof id === "string") previous.set(id, entry)
	}

	const incoming = readModelEntries(requested)
	if (incoming.length === 0) return [...previous.values()]

	return incoming.map((entry) => {
		const id = typeof entry.id === "string" && entry.id ? entry.id : "provider/model-id"
		const prior = previous.get(id) ?? {}
		const requestedName = typeof entry.name === "string" && entry.name !== id ? entry.name : undefined
		return { ...prior, ...entry, id, name: requestedName ?? prior.name ?? id }
	})
}
