/**
 * The CLI-tool registry and the name-keyed procedure boundary.
 *
 * Before this table existed, sixteen routes each built their own `ToolSettingsDeps` inline. The
 * migration collapsed them into one table, so a transcription error now affects every caller
 * instead of one route — and a wrong message is exactly the kind of defect no type checker
 * catches and no route test asserts.
 *
 * So these tests pin three things:
 *
 * - every registered tool resolves to a bundle with the fields the use-case dereferences;
 * - `isCliToolName` and `cliToolHost` agree, since a name that passes the guard but resolves to
 *   nothing is a 500 at the moment an operator clicks Save;
 * - the shape is the ones the tools shipped with, not text retyped from memory. The `smelt`
 *   reset message was in fact transcribed wrong during this migration and caught by comparing
 *   against the routes, not by any test.
 */
import { describe, expect, test } from "bun:test"

// The registry imports `cliToolHosts`, which probes the filesystem only when called. Importing
// it here installs nothing and writes nothing.
const { CLI_TOOL_NAMES, cliToolHost, isCliToolName } = await import(
	"../../apps/web/src/lib/cliToolRegistry.ts"
)

describe("every registered tool resolves to a usable host bundle", () => {
	test("the registry names sixteen tools", () => {
		expect(CLI_TOOL_NAMES.length).toBe(16)
	})

	for (const tool of CLI_TOOL_NAMES) {
		test(`${tool} resolves with a config port and three messages`, () => {
			const host = cliToolHost(tool)
			expect(host).toBeDefined()
			// The fields the use-case dereferences; a missing one is a TypeError mid-write.
			expect(typeof host?.isInstalled).toBe("function")
			expect(host?.config).toBeDefined()
			expect(typeof host?.notInstalledMessage).toBe("string")
			expect(typeof host?.appliedMessage).toBe("string")
			expect(typeof host?.resetMessage).toBe("string")
			// An empty message renders as a blank toast, which reads as a silent success.
			expect(host?.notInstalledMessage).not.toBe("")
			expect(host?.appliedMessage).not.toBe("")
			expect(host?.resetMessage).not.toBe("")
		})
	}
})

describe("the guard and the lookup agree", () => {
	for (const tool of CLI_TOOL_NAMES) {
		test(`${tool} passes the guard and resolves`, () => {
			expect(isCliToolName(tool)).toBe(true)
			expect(cliToolHost(tool)).toBeDefined()
		})
	}

	test("an unknown name fails the guard and resolves to nothing", () => {
		// Both halves matter: the guard backs the oRPC enum, the lookup backs the handler.
		expect(isCliToolName("nope")).toBe(false)
		expect(cliToolHost("nope")).toBeUndefined()
	})

	test("a prototype key is not a tool", () => {
		// `Object.hasOwn` rather than `in`: with `in`, `toString` passes the guard and the
		// handler then calls a nonexistent config port on a prototype function.
		expect(isCliToolName("toString")).toBe(false)
		expect(isCliToolName("constructor")).toBe(false)
		expect(cliToolHost("constructor")).toBeUndefined()
	})
})

describe("the four tools outside the generic flow are not claimed", () => {
	test("claude, cowork, devin and hermes have their own shapes", () => {
		// Naming them here would promise a `ToolConfigPort` they do not implement. `claude`
		// speaks an `env` block; the other three do their own file work inline.
		for (const tool of ["claude", "cowork", "devin", "hermes"]) {
			expect(isCliToolName(tool)).toBe(false)
		}
	})
})

describe("a host bundle is built fresh per call", () => {
	test("two lookups do not share their side-write list", () => {
		// The arrays are per-invocation lists; sharing one would let a later caller observe an
		// earlier one's entries.
		const first = cliToolHost("kilo")
		const second = cliToolHost("kilo")
		expect(first).not.toBe(second)
		expect(first?.sideWrites).not.toBe(second?.sideWrites)
	})
})
