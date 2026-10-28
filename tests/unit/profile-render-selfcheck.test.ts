import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Runs the profile page's render self-check from the suite.
 *
 * The check needs a bundler and a React stub, so it lives in its own .mjs; running it
 * from here is what keeps it honest. The page is 2,100 lines with no error boundary,
 * so a dangling reference renders a blank profile and nothing else reports it.
 */
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")
const script = path.join(
	repoRoot,
	"apps/web/src/app/(dashboard)/dashboard/profile/renderSelfCheck.mjs",
)

describe("profile page render self-check", () => {
	it("renders the page body without a dangling reference", () => {
		const out = execFileSync("node", [script], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: 180_000,
		})
		expect(out).toContain("checks passed")
		expect(out).not.toContain("FAIL")
	}, 200_000)
})
