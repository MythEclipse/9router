/**
 * Changelog use-case.
 *
 * The behaviour worth pinning is the fallback, not the happy path: every
 * combination of (local file present/absent/blank) x (upstream reachable/not)
 * must resolve to a body the dashboard can render without throwing.
 */
import { describe, expect, it } from "bun:test"
import { createChangelogSource, loadChangelog } from "../src/application/changelog.ts"

interface Stubs {
	local?: string | null
	official?: string | null
	throws?: boolean
}

function source({ local = null, official = null, throws = false }: Stubs) {
	return createChangelogSource({
		readFile: () => {
			if (throws || local === null) throw new Error("ENOENT")
			return local
		},
		changelogPath: "/does/not/matter/CHANGELOG.md",
		fetchText: async () => official,
	})
}

describe("changelog", () => {
	it("returns both bodies when the local file and upstream both answer", async () => {
		const result = await loadChangelog(source({ local: "# ours", official: "# upstream" }))

		expect(result).toEqual({ ok: true, official: "# upstream", custom: "# ours" })
	})

	it("treats a missing local file as absent, not as a failure", async () => {
		const result = await loadChangelog(source({ throws: true, official: "# upstream" }))

		expect(result.ok).toBe(true)
		expect(result.custom).toBeNull()
		expect(result.official).toBe("# upstream")
	})

	it("treats an unreachable upstream as absent, not as a failure", async () => {
		const result = await loadChangelog(source({ local: "# ours", official: null }))

		expect(result.ok).toBe(true)
		expect(result.custom).toBe("# ours")
		expect(result.official).toBeNull()
	})

	it("reports ok:false only when there is nothing to show", async () => {
		const result = await loadChangelog(source({ throws: true, official: null }))

		expect(result).toEqual({ ok: false, official: null, custom: null })
	})

	// A whitespace-only file is an empty document, and rendering it would show
	// the operator a blank modal with no explanation.
	it("treats a blank local file as absent", async () => {
		const result = await loadChangelog(source({ local: "   \n\t\n", official: null }))

		expect(result.ok).toBe(false)
		expect(result.custom).toBeNull()
	})

	it("treats a blank upstream body as absent", async () => {
		const result = await loadChangelog(source({ local: null, official: "  \n " }))

		expect(result.official).toBeNull()
	})
})
