/**
 * Config-as-code: the install's routing configuration, as a document a human reviews in a
 * diff.
 *
 * Two rules, both about what an export must *not* be:
 *
 * 1. **It must not carry a credential.** The records this reads hold OAuth access tokens,
 *    refresh tokens, API keys and provider secrets. A config export is meant to be committed,
 *    pasted into an issue and diffed between machines, so every secret is replaced with a
 *    marker and the replacement happens here — in the one function every export passes
 *    through — rather than at each call site where one of them will eventually be forgotten.
 *
 * 2. **It must be byte-stable.** Keys are sorted at every level. Without that, two exports of
 *    an unchanged install produce different documents, every commit looks like a change, and
 *    the diff stops being a review tool.
 *
 * Redaction matches **whole key names, case-insensitively** — not substrings. `keyId` and
 * `keyName` identify a key and are useful in a diff; `key` is the credential. A substring rule
 * would redact the identity fields too and make the export useless for its purpose.
 */

/** Field names whose *value* is a credential. Exact match, case-insensitive. */
export const SECRET_FIELD_NAMES: readonly string[] = [
	"key",
	"apikey",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"authtoken",
	"sessiontoken",
	"bearer",
	"pat",
	"password",
	"secret",
	"clientsecret",
	"privatekey",
	"cookie",
	"machineid",
]

/** What a redacted value reads as. Visible in a diff, obviously not a credential. */
export const REDACTED = "<redacted>"

/** A credential field, by exact name. */
export function isSecretField(name: string): boolean {
	return SECRET_FIELD_NAMES.includes(name.toLowerCase())
}

/**
 * The same structure with every credential replaced.
 *
 * Arrays keep their length and their order — a diff that reorders connections is a diff nobody
 * can read — and a non-object value is returned untouched.
 */
export function redactSecrets(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactSecrets)
	if (value === null || typeof value !== "object") return value

	const out: Record<string, unknown> = {}
	for (const [name, field] of Object.entries(value as Record<string, unknown>)) {
		out[name] =
			isSecretField(name) && field !== null && field !== undefined ? REDACTED : redactSecrets(field)
	}
	return out
}

/** Keys sorted at every level, so the document is a function of the data alone. */
function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys)
	if (value === null || typeof value !== "object") return value
	const source = value as Record<string, unknown>
	const out: Record<string, unknown> = {}
	for (const name of Object.keys(source).sort()) out[name] = sortKeys(source[name])
	return out
}

/** The document's version. Bumped when a section's shape changes, never silently. */
export const CONFIG_EXPORT_VERSION = 1

export interface ConfigSections {
	readonly providers: readonly unknown[]
	readonly combos: readonly unknown[]
	readonly keys: readonly unknown[]
}

export interface ConfigDocument {
	readonly version: number
	readonly exportedAt: string
	readonly sections: ConfigSections
}

/**
 * The export document: redacted, sorted, and stamped.
 *
 * `exportedAt` is the only field that changes between two exports of an unchanged install, and
 * that is deliberate — a reader has to be able to tell when a file was taken.
 */
export function configDocument(sections: ConfigSections, now: Date): ConfigDocument {
	return sortKeys({
		version: CONFIG_EXPORT_VERSION,
		exportedAt: now.toISOString(),
		sections: redactSecrets({
			providers: sections.providers,
			combos: sections.combos,
			keys: sections.keys,
		}) as ConfigSections,
	}) as ConfigDocument
}

/** The document as JSON text: two spaces, trailing newline, keys already sorted. */
export function configJson(document: ConfigDocument): string {
	return `${JSON.stringify(document, null, 2)}\n`
}

/** The download's filename, dated so two exports cannot collide. */
export function configFilename(now: Date): string {
	return `9router-config-${now.toISOString().slice(0, 10)}.json`
}
