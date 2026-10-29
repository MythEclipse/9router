/**
 * Writing a CLI tool's settings so it points at this install.
 *
 * Twenty tools each have their own config format, but they agree on three things the routes
 * had been spelling out separately, and the copies had drifted: what a usable base URL looks
 * like, what makes a request body acceptable, and how to tell whether the file already points
 * here. Only those three live in this file; a tool's own file layout stays with that tool.
 */

/** The base URL every OpenAI-compatible tool expects, `/v1` included. */
export function normaliseBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "")
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`
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
	return { ok: true, input: { baseUrl: normaliseBaseUrl(baseUrl), apiKey, model } }
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
