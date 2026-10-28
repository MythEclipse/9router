import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Wraps the endpoint page's render self-check in the suite.
 *
 * The check itself is a standalone .mjs because it needs a bundler and a React stub;
 * running it from here is what stops it rotting — a self-check nobody invokes is
 * documentation, not a gate.
 */
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")
const script = path.join(repoRoot, "src/app/(dashboard)/dashboard/endpoint/renderSelfCheck.mjs")

describe("endpoint page render self-check", () => {
	it("renders the page body without a dangling reference", () => {
		// A non-zero exit is the failure signal; execFileSync throws on it.
		const out = execFileSync("node", [script], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: 180_000,
		})
		expect(out).toContain("checks passed")
		expect(out).not.toContain("FAIL")
	}, 200_000)
})
