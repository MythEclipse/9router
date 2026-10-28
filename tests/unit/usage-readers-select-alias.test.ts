import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The same rows reach the dashboard from several readers: the in-memory ring,
 * the stats aggregate, and the request log. They must agree on the model name,
 * or one of them overwrites the others and the name appears to change on its own.
 *
 * These assertions are about the SQL, because that is where the bug hid: a reader
 * that parses `meta` without selecting it gets `undefined`, falls back to the
 * combo name, and looks correct in every unit test that feeds it fake rows.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const repo = readFileSync(join(REPO_ROOT, "packages/db/src/repos/usageRepo.ts"), "utf8")

/** Every `SELECT ... FROM usageHistory` that yields rows carrying a model name. */
function displayQueries(source: string): string[] {
	return source
		.split("\n")
		.filter(
			(l) =>
				l.includes("SELECT") &&
				l.includes("FROM usageHistory") &&
				l.includes("model") &&
				l.includes("tokens"),
		)
}

describe("every reader selects the alias column", () => {
	it("includes meta in every query whose rows get labelled", () => {
		const queries = displayQueries(repo)
		expect(queries.length).toBeGreaterThanOrEqual(3)
		const missing = queries.filter((q) => !q.includes("meta"))
		expect(missing).toEqual([])
	})

	it("labels those rows through the shared helper", () => {
		// Reading `r.meta` directly is how the four readers drifted apart.
		expect(repo).not.toMatch(/parseJson<Record<string, unknown>>\(r\.meta/)
	})
})
