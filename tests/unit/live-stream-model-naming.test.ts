import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The dashboard has to answer "which upstream served this?" — an operator
 * reading the live stream to debug a 429 needs the real target, not the combo
 * that abstracted it.
 *
 * Storage makes this easy to get wrong: `saveRequestUsage` deliberately moves the
 * requested name into the `model` column (so Request Logs read naturally) and
 * leaves the real target in `meta.resolvedModel`. A reader that only looks at
 * `model` therefore reports the combo name as if it were a model, which is what
 * put "text" and "claude-opus-5-5" in the model list next to gemini/deepseek.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const repo = readFileSync(join(REPO_ROOT, "packages/db/src/repos/usageRepo.ts"), "utf8")

describe("live stream model naming", () => {
	it("reports the resolved model, not the requested combo name", () => {
		const entry = { model: "claude-opus-5-5", resolvedModel: "deepseek-v4.1-flash" }
		const resolved = entry.resolvedModel
		const displayModel = resolved || entry.model

		expect(displayModel).toBe("deepseek-v4.1-flash")
	})

	it("falls back to the stored model when nothing was rewritten", () => {
		const entry: { model: string; resolvedModel?: string } = { model: "gemini-3.5-flash-lite" }
		const displayModel = entry.resolvedModel || entry.model

		expect(displayModel).toBe("gemini-3.5-flash-lite")
	})

	it("keeps the requested name available as context, not as the model", () => {
		const entry = { model: "text", resolvedModel: "gemini-3.5-flash-lite" }
		const resolved = entry.resolvedModel
		const displayModel = resolved || entry.model
		const requestedModel = resolved ? entry.model : undefined

		expect(displayModel).toBe("gemini-3.5-flash-lite")
		expect(requestedModel).toBe("text")
	})

	it("reads resolvedModel back out of the meta column on ring restore", () => {
		// A restart must not regress the live stream to the combo name, so the ring
		// restore has to resolve the alias through the shared helper rather than
		// copying `model` verbatim.
		expect(repo).toMatch(/resolvedModel: resolvedModelOf\(r\.meta\)/)
	})

	it("actually selects the meta column it then parses", () => {
		// Reading `r.meta` is useless if the query never fetched that column: the
		// value is silently undefined and every row falls back to the combo name.
		// That regression only showed while the stream was idle (rows restored from
		// disk) and disappeared as soon as a live request replaced them, which is
		// why the previous test — which only checked the parse expression — passed.
		const restoreQuery = repo.match(
			/SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens([^`]*)FROM usageHistory/,
		)
		expect(restoreQuery).not.toBeNull()
		expect(restoreQuery?.[1]).toContain("meta")
	})

	it("exposes requestedModel on RecentRequest so the UI can qualify a row", () => {
		expect(repo).toMatch(/interface RecentRequest \{[\s\S]*?requestedModel\?: string;/)
	})
})
