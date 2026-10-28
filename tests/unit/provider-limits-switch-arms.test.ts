import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * A `switch` with a repeated `case` compiles, lints and passes every behavioural
 * test: the second branch is simply unreachable. parseQuotaData grew three identical
 * `case "cursor":` blocks this way, so the only way to catch the next one is to read
 * the source. The path is the parser's own module since it moved out of utils.ts.
 */
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")
const SOURCE = path.join(
	repoRoot,
	"src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing.ts",
)

function caseLabelsInSwitch(source: string, fnName: string): string[] {
	const start = source.indexOf(`export function ${fnName}(`)
	if (start === -1) throw new Error(`${fnName} not found`)
	const body = source.slice(start)
	return [...body.matchAll(/^\s*case\s+"([^"]+)":/gm)].map((m) => m[1])
}

describe("parseQuotaData switch", () => {
	it("has no unreachable duplicate case label", () => {
		const labels = caseLabelsInSwitch(readFileSync(SOURCE, "utf8"), "parseQuotaData")
		const seen = new Set<string>()
		const duplicates = new Set<string>()
		for (const label of labels) {
			if (seen.has(label)) duplicates.add(label)
			seen.add(label)
		}
		expect([...duplicates]).toEqual([])
	})

	it("finds the providers it is meant to parse", () => {
		// Guards against the check above silently matching nothing after a refactor
		// that moves the switch or changes its formatting.
		const labels = caseLabelsInSwitch(readFileSync(SOURCE, "utf8"), "parseQuotaData")
		expect(labels.length).toBeGreaterThan(15)
		for (const expected of ["github", "antigravity", "codex", "cursor", "groq"]) {
			expect(labels).toContain(expected)
		}
	})
})
