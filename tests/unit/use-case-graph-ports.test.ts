import { describe, expect, it } from "vitest"
import { required } from "../../apps/api/src/infrastructure/requiredPort.ts"

/**
 * A port the host forgets to supply must fail at assembly, naming itself.
 *
 * That is how `cursorImport` shipped broken: the route called the port, the tests on either
 * side of it passed, and the omission surfaced as a 500 in a smoke test. The guard is this
 * function, so this is what gets tested — asserting on the whole graph would only prove that
 * some earlier port fails first.
 */
describe("required", () => {
	it("names the missing port, so the message points at the wiring to fix", () => {
		expect(() => required({ cursorImport: undefined }, "cursorImport")).toThrow(
			/The use-case graph needs cursorImport; this host did not supply it/,
		)
	})

	it("treats a null port as missing, not as a supplied one", () => {
		expect(() => required({ tunnelProbes: null }, "tunnelProbes")).toThrow(/tunnelProbes/)
	})

	it("returns the port untouched when it is there", () => {
		const port = { candidates: [] }
		expect(required({ cursorImport: port }, "cursorImport")).toBe(port)
	})
})
