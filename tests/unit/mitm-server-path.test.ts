import { describe, expect, test } from "vitest"
import { pickMitmServerPath } from "../../apps/web/src/mitm/manager.ts"

const CANDIDATES = [
	"/app/node_modules/9router/src/mitm/server.js",
	"/app/node_modules/9router/src/mitm/server.ts",
	"/app/src/mitm/server.js",
	"/app/src/mitm/server.ts",
	"/src/mitm/server.js",
	"/src/mitm/server.ts",
]

const only =
	(...present: string[]) =>
	(candidate: string) =>
		present.includes(candidate)

describe("pickMitmServerPath", () => {
	test("a bundled server.js is preferred over the source it came from", () => {
		// The child is `node <path>`; node cannot execute TypeScript, so the bundle wins.
		const answer = pickMitmServerPath(
			CANDIDATES,
			only("/app/src/mitm/server.js", "/app/src/mitm/server.ts"),
		)
		expect(answer).toBe("/app/src/mitm/server.js")
	})

	test("a .ts-only tree still resolves, which is the bug this replaced", () => {
		// The standalone build copies src/ as source, so server.ts is all that exists there.
		const answer = pickMitmServerPath(CANDIDATES, only("/app/src/mitm/server.ts"))
		expect(answer).toBe("/app/src/mitm/server.ts")
	})

	test("the sibling directory is searched before the cwd variants", () => {
		const answer = pickMitmServerPath(
			CANDIDATES,
			only("/app/node_modules/9router/src/mitm/server.ts", "/src/mitm/server.js"),
		)
		expect(answer).toBe("/app/node_modules/9router/src/mitm/server.ts")
	})

	test("nothing present falls back to the first candidate rather than undefined", () => {
		// Returning undefined would reach spawn() as an empty path and report ENOENT
		// against a directory, which names no cause.
		expect(pickMitmServerPath(CANDIDATES, () => false)).toBe(CANDIDATES[0])
	})
})
