import { describe, expect, it } from "vitest"
import {
	adminOnlyAttempt,
	dropBlankOidcSecret,
	loginGateView,
	mayRevertSettings,
	passwordChangeOf,
	publicSettings,
	refusesAdminOnlyWrite,
	revertIsEmpty,
	revertPatchOf,
	sideEffectsOf,
	stripProtectedKeys,
} from "../../apps/api/src/domain/settings.ts"

describe("stripProtectedKeys", () => {
	it("removes the password a body must never set", () => {
		expect(stripProtectedKeys({ password: "hash", theme: "dark" })).toEqual({ theme: "dark" })
	})

	it("removes the encrypted sudo secret", () => {
		expect(stripProtectedKeys({ mitmSudoEncrypted: "x" })).toEqual({})
	})

	it("leaves everything else alone", () => {
		const body = { comboStrategy: "round-robin", outboundProxyEnabled: true }
		expect(stripProtectedKeys(body)).toEqual(body)
	})

	it("does not mutate the caller's object", () => {
		const body = { password: "hash" }
		stripProtectedKeys(body)
		expect(body.password).toBe("hash")
	})
})

describe("adminOnlyAttempt", () => {
	it("finds the theme", () => {
		expect(adminOnlyAttempt({ theme: "dark" })).toBe("theme")
	})

	it("answers null when the field is absent", () => {
		expect(adminOnlyAttempt({ comboStrategy: "x" })).toBeNull()
	})

	it("does not count an untouched form field as an attempt", () => {
		expect(adminOnlyAttempt({ theme: undefined })).toBeNull()
	})

	it("counts an explicit null as an attempt", () => {
		expect(adminOnlyAttempt({ theme: null })).toBe("theme")
	})
})

describe("refusesAdminOnlyWrite", () => {
	it("refuses a key-signed session", () => {
		expect(refusesAdminOnlyWrite("apikey")).toBe(true)
	})

	it("allows an administrator", () => {
		expect(refusesAdminOnlyWrite("admin")).toBe(false)
	})

	it("allows a session with no role recorded", () => {
		expect(refusesAdminOnlyWrite(null)).toBe(false)
		expect(refusesAdminOnlyWrite(undefined)).toBe(false)
	})
})

describe("publicSettings", () => {
	it("never sends the password hash", () => {
		expect(publicSettings({ password: "hash", theme: "dark" })).not.toHaveProperty("password")
	})

	it("never sends the OIDC client secret", () => {
		expect(publicSettings({ oidcClientSecret: "s3cret" })).not.toHaveProperty("oidcClientSecret")
	})

	it("reports hasPassword as a boolean, not the hash itself", () => {
		expect(publicSettings({ password: "hash" }).hasPassword).toBe(true)
		expect(publicSettings({}).hasPassword).toBe(false)
	})

	it("derives oidcConfigured only when all three fields are present", () => {
		const full = { oidcIssuerUrl: "https://idp", oidcClientId: "id", oidcClientSecret: "secret" }
		expect(publicSettings(full).oidcConfigured).toBe(true)
		expect(publicSettings({ ...full, oidcClientSecret: "" }).oidcConfigured).toBe(false)
		expect(publicSettings({ ...full, oidcClientId: "" }).oidcConfigured).toBe(false)
		expect(publicSettings({ ...full, oidcIssuerUrl: "" }).oidcConfigured).toBe(false)
	})

	it("keeps the ordinary settings it was given", () => {
		expect(publicSettings({ theme: "dark", comboStrategy: "sticky" })).toMatchObject({
			theme: "dark",
			comboStrategy: "sticky",
		})
	})
})

describe("passwordChangeOf", () => {
	it("does nothing when no new password was sent", () => {
		expect(passwordChangeOf({}, true)).toEqual({ kind: "none" })
	})

	it("requires the current password when one is stored", () => {
		expect(passwordChangeOf({ newPassword: "new" }, true)).toEqual({
			kind: "refuse",
			message: "Current password required",
			status: 400,
		})
	})

	it("asks the caller to verify the current password rather than guessing", () => {
		expect(passwordChangeOf({ newPassword: "new", currentPassword: "given" }, true)).toEqual({
			kind: "verify",
			current: "given",
			newPassword: "new",
		})
	})

	it("refuses a non-text current password without a comparison", () => {
		expect(passwordChangeOf({ newPassword: "new", currentPassword: 42 }, true)).toMatchObject({
			kind: "refuse",
			status: 401,
		})
	})

	it("sets the first password without asking for a current one", () => {
		expect(passwordChangeOf({ newPassword: "first" }, false)).toEqual({
			kind: "set",
			newPassword: "first",
		})
	})

	it("accepts the setup wizard's placeholder as the first current password", () => {
		expect(passwordChangeOf({ newPassword: "first", currentPassword: "123456" }, false)).toEqual({
			kind: "set",
			newPassword: "first",
		})
	})

	it("still refuses a non-placeholder current password on a fresh install", () => {
		expect(passwordChangeOf({ newPassword: "first", currentPassword: "typo" }, false)).toMatchObject({
			kind: "refuse",
			status: 401,
		})
	})

	it("refuses a non-text new password rather than hashing its string form", () => {
		expect(passwordChangeOf({ newPassword: 12345 }, false)).toMatchObject({
			kind: "refuse",
			status: 400,
		})
	})
})

describe("dropBlankOidcSecret", () => {
	it("drops an empty secret so the stored one survives", () => {
		expect(dropBlankOidcSecret({ oidcClientSecret: "" })).toEqual({})
	})

	it("drops a whitespace-only secret", () => {
		expect(dropBlankOidcSecret({ oidcClientSecret: "   " })).toEqual({})
	})

	it("keeps a real secret", () => {
		expect(dropBlankOidcSecret({ oidcClientSecret: "abc" })).toEqual({ oidcClientSecret: "abc" })
	})

	it("leaves a body without the field untouched", () => {
		expect(dropBlankOidcSecret({ theme: "dark" })).toEqual({ theme: "dark" })
	})
})

describe("sideEffectsOf", () => {
	it("owes nothing for an unrelated change", () => {
		expect(sideEffectsOf({ theme: "dark" })).toEqual({
			applyOutboundProxy: false,
			resetComboRotation: false,
			resetProxyHealth: false,
			reconfigureAutoPing: false,
		})
	})

	it("applies the proxy for any of its three fields", () => {
		for (const key of ["outboundProxyEnabled", "outboundProxyUrl", "outboundNoProxy"]) {
			expect(sideEffectsOf({ [key]: "x" }).applyOutboundProxy).toBe(true)
		}
	})

	it("resets combo rotation for any strategy field", () => {
		for (const key of ["comboStrategy", "comboStickyRoundRobinLimit", "comboStrategies"]) {
			expect(sideEffectsOf({ [key]: "x" }).resetComboRotation).toBe(true)
		}
	})

	it("resets proxy health when the provider strategies change", () => {
		expect(sideEffectsOf({ providerStrategies: {} }).resetProxyHealth).toBe(true)
	})

	it("reconfigures auto-ping for either provider", () => {
		expect(sideEffectsOf({ claudeAutoPing: true }).reconfigureAutoPing).toBe(true)
		expect(sideEffectsOf({ codexAutoPing: true }).reconfigureAutoPing).toBe(true)
	})

	it("can owe several at once", () => {
		const owed = sideEffectsOf({
			comboStrategy: "x",
			providerStrategies: {},
			claudeAutoPing: true,
		})
		expect(owed.resetComboRotation).toBe(true)
		expect(owed.resetProxyHealth).toBe(true)
		expect(owed.reconfigureAutoPing).toBe(true)
	})
})

describe("loginGateView", () => {
	it("defaults both gates to on when the fields are missing", () => {
		expect(loginGateView({})).toMatchObject({
			requireLogin: true,
			tunnelDashboardAccess: true,
		})
	})

	it("turns a gate off only for an explicit false", () => {
		expect(loginGateView({ requireLogin: false }).requireLogin).toBe(false)
		expect(loginGateView({ requireLogin: "no" }).requireLogin).toBe(true)
	})

	it("answers empty strings rather than undefined for the two URLs", () => {
		expect(loginGateView({})).toMatchObject({ tunnelUrl: "", tailscaleUrl: "" })
	})

	it("passes a set URL through", () => {
		expect(loginGateView({ tunnelUrl: "https://t.example.com" }).tunnelUrl).toBe(
			"https://t.example.com",
		)
	})
})

describe("mayRevertSettings", () => {
	it("refuses an unauthenticated caller", () => {
		expect(mayRevertSettings(null)).toBe(false)
		expect(mayRevertSettings(undefined)).toBe(false)
		expect(mayRevertSettings("")).toBe(false)
	})

	it("refuses a key-signed session", () => {
		expect(mayRevertSettings("apikey")).toBe(false)
	})

	it("allows a password sign-in", () => {
		expect(mayRevertSettings("admin")).toBe(true)
	})
})

describe("revertPatchOf", () => {
	const snapshot = { theme: "dark", comboStrategy: "sticky", requireLogin: true }

	it("restores every key when no subset was asked for", () => {
		expect(revertPatchOf(snapshot, undefined)).toEqual(snapshot)
	})

	it("restores every key for an empty subset", () => {
		expect(revertPatchOf(snapshot, [])).toEqual(snapshot)
	})

	it("restores only the keys asked for", () => {
		expect(revertPatchOf(snapshot, ["theme"])).toEqual({ theme: "dark" })
	})

	it("does not invent a key the snapshot lacks", () => {
		expect(revertPatchOf(snapshot, ["nope"])).toEqual({})
	})

	it("does not mutate the snapshot", () => {
		revertPatchOf(snapshot, ["theme"])
		expect(snapshot).toHaveProperty("comboStrategy")
	})
})

describe("revertIsEmpty", () => {
	it("treats an empty patch as nothing to restore", () => {
		expect(revertIsEmpty({})).toBe(true)
	})

	it("treats one restored key as something", () => {
		expect(revertIsEmpty({ theme: "dark" })).toBe(false)
	})
})
