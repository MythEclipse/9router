import { describe, expect, it } from "vitest"
import type { SettingsPort } from "../../apps/api/src/application/settings/login-gate.ts"
import { makeGetTheme, makeSetTheme } from "../../apps/api/src/application/settings/theme.ts"
import { DEFAULT_THEME } from "../../apps/api/src/domain/theme.ts"

function fakeSettings(initial: Record<string, unknown> = {}): SettingsPort & {
	stored: Record<string, unknown>
} {
	const port = {
		stored: { ...initial } as Record<string, unknown>,
		async read() {
			return port.stored as never
		},
		async update(changes: Record<string, unknown>) {
			port.stored = { ...port.stored, ...changes }
		},
	}
	return port
}

describe("getTheme", () => {
	it("returns the stored dark value", async () => {
		await expect(makeGetTheme(fakeSettings({ theme: "dark" }))()).resolves.toEqual({
			theme: "dark",
		})
	})

	it("falls back to the default for an absent or unusable value", async () => {
		await expect(makeGetTheme(fakeSettings())()).resolves.toEqual({ theme: DEFAULT_THEME })
		await expect(makeGetTheme(fakeSettings({ theme: "chartreuse" }))()).resolves.toEqual({
			theme: DEFAULT_THEME,
		})
	})
})

describe("setTheme", () => {
	it("stores dark for a password session", async () => {
		const settings = fakeSettings()
		await expect(makeSetTheme(settings)({ role: "admin" }, "dark")).resolves.toEqual({
			theme: "dark",
			ok: true,
		})
		expect(settings.stored.theme).toBe("dark")
	})

	it("normalises an unknown value instead of rejecting the write", async () => {
		const settings = fakeSettings({ theme: "dark" })
		await expect(makeSetTheme(settings)({ role: "admin" }, "nonsense")).resolves.toEqual({
			theme: DEFAULT_THEME,
			ok: true,
		})
		expect(settings.stored.theme).toBe(DEFAULT_THEME)
	})

	it("refuses without a session, and writes nothing", async () => {
		const settings = fakeSettings({ theme: "dark" })
		await expect(makeSetTheme(settings)(null, "glass")).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		})
		expect(settings.stored.theme).toBe("dark")
	})

	it("refuses a key-signed session with FORBIDDEN, not UNAUTHORIZED", async () => {
		// A key holder is signed in; telling them to sign in would be wrong advice.
		const settings = fakeSettings({ theme: "dark" })
		await expect(makeSetTheme(settings)({ role: "apikey" }, "glass")).rejects.toMatchObject({
			code: "FORBIDDEN",
		})
		expect(settings.stored.theme).toBe("dark")
	})
})
