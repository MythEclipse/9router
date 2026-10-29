/**
 * Codex profiles: one `~/.codex/<name>.config.toml` per profile, named by the operator.
 *
 * The name becomes a filename and the model becomes a quoted TOML value, so both are validated
 * here rather than at the filesystem. Nothing in this file touches disk — the route lists, writes
 * and deletes; these rules say what may be listed, written or deleted.
 */

/** The provider every profile this screen writes should point at. */
export const CODEX_PROFILE_PROVIDER = "9router"

/** The file suffix a profile uses, and the one file in that directory that is not a profile. */
const PROFILE_SUFFIX = ".config.toml"
const BASE_CONFIG_FILE = "config.toml"

/**
 * Whether a profile name may become a file name.
 *
 * Restricted to `[a-zA-Z0-9_-]`: the name is also typed as `codex -p <name>` on a command line,
 * so a space or a dot would produce a profile that cannot be invoked. `config` is refused because
 * `config.config.toml` reads like the base file and would be edited by mistake.
 */
export function isValidProfileName(name: unknown): name is string {
	if (typeof name !== "string") return false
	return /^[a-zA-Z0-9_-]+$/.test(name) && name.length <= 64 && name.toLowerCase() !== "config"
}

/**
 * Whether a model string may be written into the profile's TOML.
 *
 * The value is emitted inside double quotes on one line, so a quote or a newline would end the
 * string and let the rest of the input become TOML.
 */
export function isValidCodexModel(model: unknown): model is string {
	if (typeof model !== "string") return false
	return model.trim().length > 0 && model.length <= 256 && !/[\r\n"]/.test(model)
}

/** The name a form should be stored under, before validation. */
export function normaliseProfileName(name: unknown): string {
	return typeof name === "string" ? name.trim().toLowerCase() : ""
}

/** The file name for a profile. */
export function codexProfileFile(name: string): string {
	return `${name}${PROFILE_SUFFIX}`
}

/**
 * The profile name a directory entry represents, or null when it is not a profile file.
 *
 * `config.toml` is excluded explicitly: it is the base config and ends with the same suffix, so a
 * filter on the suffix alone would list it as a profile called `config`.
 */
export function profileNameFromFile(file: string): string | null {
	if (file === BASE_CONFIG_FILE) return null
	if (!file.endsWith(PROFILE_SUFFIX)) return null
	const name = file.slice(0, -PROFILE_SUFFIX.length)
	return name.length > 0 ? name : null
}

/** The TOML a new profile file should contain. */
export function codexProfileToml(name: string, model: string): string {
	return `# codex -p ${name}\nmodel = "${model}"\nmodel_provider = "${CODEX_PROFILE_PROVIDER}"\n`
}

/**
 * The model already in a profile file, or "" when it has none.
 *
 * Reads both quote styles a hand-edited file may use, because the operator is expected to edit
 * these files directly — the profile still works, it just reports no model until rewritten.
 */
export function readProfileModel(toml: string): string {
	const match = toml.match(/^\s*model\s*=\s*(["'])([^"\n]+)\1/m)
	return match?.[2] ?? ""
}

/** One profile as the screen lists it. */
export interface CodexProfile {
	name: string
	model: string
	command: string
}

/** The profile fields a screen shows for a name and model. */
export function codexProfile(name: string, model: string): CodexProfile {
	return { name, model, command: `codex -p ${name}` }
}
