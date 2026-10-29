/**
 * jcode's `config.toml`: a nested `providers` table this screen owns one entry of.
 *
 * Round-tripping through a TOML parser is the honest option, but it rewrites the whole document
 * — comments, ordering, quote style — every save. Instead the entry is spliced in textually, and
 * what makes that safe is that jcode's entry is flat: no nested tables, no arrays, so it can be
 * recognised and replaced as a run of `key = value` lines under one header.
 */

/** The provider key this install writes into jcode's config. */
export const JCODE_PROVIDER_ID = "9router"

/** The variable jcode reads the key from; the TOML only names the file that holds it. */
export const JCODE_KEY_ENV = "JCODE_9ROUTER_API_KEY"

export interface JcodeProviderInput {
	baseUrl: string
	model: string
}

const HEADER = `providers.${JCODE_PROVIDER_ID}`

/** The entry, as jcode's `providers` table expects it. */
export function jcodeProviderBlock({ baseUrl, model }: JcodeProviderInput): string {
	return [
		`[${HEADER}]`,
		'type = "openai-compatible"',
		`base_url = "${baseUrl}"`,
		'auth = "bearer"',
		`api_key_env = "${JCODE_KEY_ENV}"`,
		'env_file = "provider-9router.env"',
		`default_model = "${model}"`,
		"requires_api_key = true",
	].join("\n")
}

/** Line index of our `[providers.9router]` header, or -1. */
function findHeader(lines: string[]): number {
	return lines.findIndex((line) => line.trim() === `[${HEADER}]`)
}

/**
 * Drops our entry, stopping at the next table header.
 *
 * Anything below another `[header]` belongs to that table, so the splice can never eat it.
 */
export function removeJcodeProvider(toml: string): string {
	const lines = toml.split("\n")
	const start = findHeader(lines)
	if (start === -1) return toml

	let end = start + 1
	while (end < lines.length && !/^\s*\[/.test(lines[end] ?? "")) end++
	return [...lines.slice(0, start), ...lines.slice(end)].join("\n")
}

/** Replaces our entry, leaving every other table byte-identical. */
export function withJcodeProvider(toml: string, baseUrl: string, model: string): string {
	const cleaned = removeJcodeProvider(toml).trimEnd()
	const block = jcodeProviderBlock({ baseUrl, model })
	return cleaned ? `${cleaned}\n\n${block}\n` : `${block}\n`
}

/** Whether the config already points at this install, by our key or by host. */
export function jcodeHasThisInstall(toml: string): boolean {
	if (!toml) return false
	return (
		toml.includes(`[${HEADER}]`) ||
		toml.includes("localhost:20128") ||
		toml.includes("127.0.0.1:20128")
	)
}
