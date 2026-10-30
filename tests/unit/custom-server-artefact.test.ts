/**
 * `apps/web/custom-server.js` is generated from `custom-server.ts` by
 * `scripts/copy-standalone-assets.mjs` on every build, which rewrites it in place and then copies it
 * into the standalone bundle. It is a build artefact, and a build artefact must not be tracked.
 *
 * It was tracked anyway. `.gitignore` had `/custom-server.js`, anchored at the repository root; when
 * the monorepo split moved the file to `apps/web/`, the pattern stopped matching and the next commit
 * swept the artefact in. From then on it drifted: at one point the `.ts` declared `MIGRATIONS_DIR`
 * twice while the committed `.js` did not contain it at all, so `package.json`'s `start` ran a
 * launcher missing the migration-journal block that fixes a 500 on every database-backed route.
 *
 * Nothing noticed. `typecheck` does not read it, no test imported it, and the diff a rebuild
 * produces looks like formatter churn. Green gates and a clean-looking diff are not evidence.
 *
 * So the assertion is about provenance, not content: the file must be ignorable, and if it is
 * tracked that is the bug. Content equality would be the wrong check — the build's output is not
 * formatted while the committed copy was, so the two could never agree byte-for-byte even when
 * healthy.
 */
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const repoRoot = join(__dirname, "..", "..")
const artefact = "apps/web/custom-server.js"

function git(args: readonly string[]): string {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()
}

describe("a generated launcher is not committed", () => {
	it("git ignores the artefact, so a build cannot sweep it into a commit", () => {
		// `check-ignore` exits 1 when the path is not ignored, which is the failure we care about.
		expect(() => git(["check-ignore", "-q", artefact])).not.toThrow()
	})

	it("the artefact is not tracked", () => {
		// Asking git rather than the filesystem: the file legitimately exists on disk after a build,
		// and its presence is not the problem — being in the index is.
		const tracked = git(["ls-files", "--", artefact])
		expect(tracked).toBe("")
	})

	it("its source is tracked, so the artefact can always be regenerated", () => {
		expect(git(["ls-files", "apps/web/custom-server.ts"]).length).toBeGreaterThan(0)
	})
})
