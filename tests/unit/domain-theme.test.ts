import { describe, expect, it } from "vitest"
import { DEFAULT_THEME, normalizeTheme, refuseThemeWrite } from "../../apps/api/src/domain/theme.ts"

describe("normalizeTheme", () => {
	it("keeps dark", () => {
		expect(normalizeTheme("dark")).toBe("dark")
	})

	it("reads every other value as the default", () => {
		// Total on purpose: this is applied to every page on load, so a value
		// written by an older build must not blank the site.
		for (const input of [undefined, null, "", "DARK", "light", 0, {}, []]) {
			expect(normalizeTheme(input), String(input)).toBe(DEFAULT_THEME)
		}
	})
})

describe("refuseThemeWrite", () => {
	it("surfaces the two distinct reasons as distinct values", () => {
		// The route answers 401 and 403 respectively; collapsing them would make
		// a signed-in key holder see "sign in", which is wrong advice.
		expect(refuseThemeWrite(null)).toBe("no-session")
		expect(refuseThemeWrite(undefined)).toBe("no-session")
		expect(refuseThemeWrite("apikey")).toBe("api-key-session")
	})

	it("permits a password session", () => {
		expect(refuseThemeWrite("admin")).toBeNull()
		expect(refuseThemeWrite("owner")).toBeNull()
	})
})
