/**
 * Oh My Pi's `models.yml`: a hand-edited YAML file this screen owns one provider block in.
 *
 * The block is removed line by line rather than with a regular expression. A pattern that
 * anchors on `\w+:` over-matches, and one that anchors on indentation either misses an indented
 * block — so a second save appends a duplicate and the file stops being valid YAML — or
 * swallows the next provider with it. Walking the lines states the rule plainly.
 */

/** The provider id this install writes into `models.yml`. */
export const OMP_PROVIDER_ID = "9router"

const indentationOf = (line: string): number => line.length - line.trimStart().length

/** The key a line declares, when it declares one at `depth` indentation. */
function keyAt(line: string, depth: number): string | null {
	if (indentationOf(line) !== depth) return null
	const match = line.trim().match(/^([\w-]+):/)
	return match?.[1] ?? null
}

/**
 * The provider block, indented for `providers:`.
 *
 * `authHeader: true` and `disableStrictTools: true` are both required: OMP otherwise sends the
 * key as a bearer token and enforces tool schemas this install's models do not follow.
 */
export function ompProviderBlock(baseUrl: string, apiKey: string): string {
	return `  ${OMP_PROVIDER_ID}:
    baseUrl: ${baseUrl}
    apiKey: ${apiKey}
    api: openai-completions
    authHeader: true
    disableStrictTools: true
    discovery:
      type: proxy`
}

/**
 * Drops our provider block, leaving every other provider exactly as it was.
 *
 * Replacing the stale block before adding the new one is what keeps a save idempotent: without
 * it each save appends another `9router:` key and the file stops being valid YAML.
 */
export function removeOmpProvider(yaml: string): string {
	const lines = yaml.split("\n")
	const kept: string[] = []

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? ""
		if (keyAt(line, indentationOf(line)) !== OMP_PROVIDER_ID) {
			kept.push(line)
			continue
		}

		// Skip our block: every following line that is blank or indented deeper than the key.
		const depth = indentationOf(line)
		let cursor = index + 1
		while (cursor < lines.length) {
			const next = lines[cursor] ?? ""
			if (next.trim() !== "" && indentationOf(next) <= depth) break
			cursor++
		}
		index = cursor - 1
	}

	return kept.join("\n")
}

/** Adds our block under `providers:`, creating the section when the file has none. */
export function withOmpProvider(yaml: string, baseUrl: string, apiKey: string): string {
	const cleaned = removeOmpProvider(yaml)
	const block = ompProviderBlock(baseUrl, apiKey)

	if (!cleaned.trim()) return `providers:\n${block}\n`
	if (cleaned.includes("providers:")) return cleaned.replace(/providers:/, `providers:\n${block}`)
	return `${cleaned.trim()}\n\nproviders:\n${block}\n`
}

/** Whether the file already points at this install. */
export function ompHasThisInstall(yaml: string): boolean {
	if (!yaml) return false
	return yaml.includes(`${OMP_PROVIDER_ID}:`) || yaml.includes("localhost:20128")
}
