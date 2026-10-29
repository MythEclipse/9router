/**
 * The shape of the custom-plugin settings.
 *
 * GET and PUT wrote the same normalisation out twice, field by field, and that
 * duplication is why they could disagree: the reader built its result from the
 * stored settings, the writer from the request body, and neither had a name for
 * "what a well-formed entry looks like". A plugin that arrived with `models:
 * "gpt-4o"` (a string, not an array) was silently dropped to `[]` instead of
 * being reported, so the caller's typo looked like a plugin with no models.
 *
 * Unknown keys are dropped rather than preserved: the plugin list is a closed
 * catalogue, and storing a key nobody reads would make the settings row grow
 * without bound across renames.
 */

/** One plugin's settings as the dashboard models them. */
export interface CustomPluginEntry {
	readonly enabled: boolean
	/** Model ids the plugin applies to; empty means "no opinion". */
	readonly models: readonly string[]
}

export type CustomPlugins = Readonly<Record<string, CustomPluginEntry>>

export interface PluginNormalisation {
	readonly customPlugins: CustomPlugins
	/** Keys the caller sent that are not in the catalogue, for the 400 body. */
	readonly unknownKeys: readonly string[]
}

/**
 * Normalise whatever is stored or submitted into the catalogue's shape.
 *
 * Total on purpose: a partially-written settings row (one entry missing,
 * another with the wrong type) yields a usable snapshot for every catalogue
 * key instead of throwing at page load. Refusing to render the settings page
 * because one entry is malformed would hide the others.
 */
export function normaliseCustomPlugins(
	raw: unknown,
	catalogue: readonly string[],
): PluginNormalisation {
	const source = isPlainObject(raw) ? raw : {}
	const known = new Set(catalogue)
	const customPlugins: Record<string, CustomPluginEntry> = {}

	for (const key of catalogue) {
		customPlugins[key] = normaliseEntry(source[key])
	}

	return {
		customPlugins,
		unknownKeys: Object.keys(source).filter((key) => !known.has(key)),
	}
}

function normaliseEntry(raw: unknown): CustomPluginEntry {
	if (!isPlainObject(raw)) return { enabled: false, models: [] }
	return {
		enabled: raw.enabled === true,
		// Non-string members are dropped rather than stringified: a number or a
		// nested object here would otherwise reach the router as a model id.
		models: Array.isArray(raw.models)
			? raw.models.filter((model): model is string => typeof model === "string" && model.length > 0)
			: [],
	}
}

/**
 * Whether a request body is shaped like a plugin payload at all.
 *
 * The route tested `!customPlugins || typeof !== "object"`, which accepts an
 * array and a `Date` — both reach the normaliser as objects with no catalogue
 * keys, so a body of `[1,2,3]` answered 200 and stored every plugin as
 * disabled. That is a silent wipe, not a validation failure.
 */
export function isPluginPayload(raw: unknown): raw is { customPlugins: unknown } {
	if (!isPlainObject(raw)) return false
	return isPlainObject(raw.customPlugins)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
