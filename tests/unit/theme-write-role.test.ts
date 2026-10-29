import { describe, expect, it } from "vitest"
import { makeSetTheme } from "../../apps/api/src/application/settings/theme.ts"
import { refuseThemeWrite } from "../../apps/api/src/domain/theme.ts"

/**
 * Who may write the site-wide theme, and where the role comes from.
 *
 * The `theme.set` procedure used to accept `role` in its input, justified by "the
 * dashboard role is only present in the Next cookie, so the route passes it through
 * explicitly". That was true before `SessionClaims` carried `role`. Once a caller can
 * state its own role, the rule it feeds is defeated: `refuseThemeWrite` refuses only
 * an empty role and `"apikey"`, so an API-key session writes the site-wide theme by
 * sending `role: "admin"`.
 *
 * The procedure now reads the role from the session. These cases pin the rule itself,
 * so the fix cannot be undone by loosening `refuseThemeWrite` later.
 */
describe("the theme write rule", () => {
	it("refuses a caller with no role", () => {
		expect(refuseThemeWrite(null)).toBe("no-session")
		expect(refuseThemeWrite(undefined)).toBe("no-session")
		expect(refuseThemeWrite("")).toBe("no-session")
	})

	it("refuses a key session, which is the whole point of the rule", () => {
		expect(refuseThemeWrite("apikey")).toBe("api-key-session")
	})

	it("allows a password session", () => {
		expect(refuseThemeWrite("admin")).toBeNull()
	})

	it("is exact-literal, so a near-miss role does not slip through", () => {
		// Not a claim about what should happen — a record of what does. The rule compares
		// the exact string, which is why the procedure must pass the real session role
		// rather than one assembled from input.
		expect(refuseThemeWrite("APIKEY")).toBeNull()
		expect(refuseThemeWrite("apikey ")).toBeNull()
	})
})

describe("the theme use-case enforces the rule before writing", () => {
	/** Records every write, so a refusal can be shown to have written nothing. */
	function settingsSpy() {
		const writes: Array<{ theme: string }> = []
		return { writes, port: { update: async (value: { theme: string }) => void writes.push(value) } }
	}

	it("refuses a key session without touching settings", async () => {
		const { writes, port } = settingsSpy()
		const setTheme = makeSetTheme(port as never)
		await expect(setTheme({ role: "apikey" }, "dark")).rejects.toMatchObject({ code: "FORBIDDEN" })
		expect(writes).toEqual([])
	})

	it("refuses an anonymous caller without touching settings", async () => {
		const { writes, port } = settingsSpy()
		const setTheme = makeSetTheme(port as never)
		await expect(setTheme({ role: null }, "dark")).rejects.toMatchObject({ code: "UNAUTHORIZED" })
		expect(writes).toEqual([])
	})

	it("writes once for a password session", async () => {
		const { writes, port } = settingsSpy()
		const setTheme = makeSetTheme(port as never)
		await expect(setTheme({ role: "admin" }, "dark")).resolves.toEqual({ theme: "dark", ok: true })
		expect(writes).toEqual([{ theme: "dark" }])
	})
})
