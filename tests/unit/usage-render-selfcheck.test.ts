import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Runs the Usage page's render self-check from the suite.
 *
 * The check needs a bundler and a React stub, so it lives in its own .mjs; running it
 * from here is what keeps it honest. It covers the two things a diff cannot show: which
 * panels a session gets, and that the live request stream draws one box per lane
 * instead of a single chat-shaped table.
 */
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")
const script = path.join(repoRoot, "apps/web/src/shared/components/usageStatsRenderSelfCheck.mjs")

describe("usage page render self-check", () => {
	it("renders the page body without a dangling reference", () => {
		const out = execFileSync("node", [script], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: 180_000,
		})
		expect(out).toContain("checks passed")
		expect(out).toContain("the live stream splits into one box per lane")
		expect(out).not.toContain("FAIL")
	}, 200_000)
})
