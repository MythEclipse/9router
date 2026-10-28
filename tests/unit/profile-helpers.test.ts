import { describe, expect, it } from "vitest"
import {
	buildOidcPayload,
	canTestOidc,
	DEFAULT_OIDC_LOGIN_LABEL,
	DEFAULT_OIDC_SCOPES,
	formatCountdown,
	getLocaleFromCookie,
	isOidcSaveAllowed,
	oidcFormFromResponse,
	oidcSaveMessage,
	oidcTestSuccessMessage,
} from "@/app/(dashboard)/dashboard/profile/profileHelpers"

const upcase = (v: string) => (v ? v.toUpperCase() : "EN")

describe("formatCountdown", () => {
	it("pads a sub-day duration as HH:MM:SS", () => {
		expect(formatCountdown(0)).toBe("00:00:00")
		expect(formatCountdown(1000)).toBe("00:00:01")
		expect(formatCountdown(65_000)).toBe("00:01:05")
		expect(formatCountdown(3_600_000)).toBe("01:00:00")
		expect(formatCountdown(23 * 3600_000 + 59 * 60_000 + 59_000)).toBe("23:59:59")
	})

	it("prefixes days once it passes a day", () => {
		expect(formatCountdown(24 * 3600_000)).toBe("1d 00:00:00")
		expect(formatCountdown(2 * 24 * 3600_000 + 3 * 3600_000)).toBe("2d 03:00:00")
	})

	it("rounds down partial seconds", () => {
		expect(formatCountdown(1999)).toBe("00:00:01")
	})

	it("clamps a past deadline to zero instead of going negative", () => {
		expect(formatCountdown(-5000)).toBe("00:00:00")
		expect(formatCountdown(-100 * 3600_000)).toBe("00:00:00")
	})

	it("treats a non-finite duration as zero rather than printing NaN", () => {
		expect(formatCountdown(NaN)).toBe("00:00:00")
		expect(formatCountdown(Infinity)).toBe("00:00:00")
		expect(formatCountdown(-Infinity)).toBe("00:00:00")
	})
})

describe("isOidcSaveAllowed", () => {
	const base = {
		authMode: "oidc",
		issuerUrl: "",
		clientId: "",
		secret: "",
		alreadyConfigured: false,
	}

	it("always allows password mode, since it only turns SSO off", () => {
		expect(isOidcSaveAllowed({ ...base, authMode: "password" })).toBe(true)
	})

	it("requires issuer, client id and secret on a first-time setup", () => {
		expect(isOidcSaveAllowed(base)).toBe(false)
		expect(isOidcSaveAllowed({ ...base, issuerUrl: "https://idp" })).toBe(false)
		expect(isOidcSaveAllowed({ ...base, issuerUrl: "https://idp", clientId: "abc" })).toBe(false)
	})

	it("allows a complete first-time setup", () => {
		expect(
			isOidcSaveAllowed({ ...base, issuerUrl: "https://idp", clientId: "abc", secret: "s3cret" }),
		).toBe(true)
	})

	it("allows an incomplete form once a secret is already stored", () => {
		// The secret is never sent back to the browser, so the field is legitimately
		// empty on later visits; requiring it again would block every other change.
		expect(isOidcSaveAllowed({ ...base, alreadyConfigured: true })).toBe(true)
	})

	it("applies the same rule to both mode", () => {
		expect(isOidcSaveAllowed({ ...base, authMode: "both" })).toBe(false)
		expect(isOidcSaveAllowed({ ...base, authMode: "both", alreadyConfigured: true })).toBe(true)
	})
})

describe("buildOidcPayload", () => {
	it("trims every field", () => {
		const payload = buildOidcPayload(
			{
				oidcIssuerUrl: "  https://idp  ",
				oidcClientId: "  abc  ",
				oidcScopes: "  openid  ",
				oidcLoginLabel: "  Sign in  ",
			},
			"  s3cret  ",
			"oidc",
		)
		expect(payload).toEqual({
			authMode: "oidc",
			ssoType: "oidc",
			oidcIssuerUrl: "https://idp",
			oidcClientId: "abc",
			oidcScopes: "openid",
			oidcLoginLabel: "Sign in",
			oidcClientSecret: "s3cret",
		})
	})

	it("fills the documented defaults for blank scopes and label", () => {
		const payload = buildOidcPayload({ oidcScopes: "   ", oidcLoginLabel: "" }, "", "oidc")
		expect(payload.oidcScopes).toBe(DEFAULT_OIDC_SCOPES)
		expect(payload.oidcLoginLabel).toBe(DEFAULT_OIDC_LOGIN_LABEL)
	})

	it("omits the secret when blank, so the stored one is kept", () => {
		const payload = buildOidcPayload({}, "   ", "oidc")
		expect(payload).not.toHaveProperty("oidcClientSecret")
		expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty("oidcClientSecret")
	})

	it("always declares ssoType oidc", () => {
		expect(buildOidcPayload({}, "x", "both").ssoType).toBe("oidc")
	})
})

describe("oidcFormFromResponse", () => {
	const fallback = {
		authMode: "oidc",
		form: {
			oidcIssuerUrl: " https://sent ",
			oidcClientId: " sent-id ",
			oidcScopes: " ",
			oidcLoginLabel: "",
		},
	}

	it("prefers the server's echo", () => {
		const form = oidcFormFromResponse(
			{
				authMode: "both",
				oidcIssuerUrl: "https://echoed",
				oidcClientId: "echoed-id",
				oidcScopes: "openid email",
				oidcLoginLabel: "Continue with SSO",
			},
			fallback,
		)
		expect(form).toEqual({
			authMode: "both",
			oidcIssuerUrl: "https://echoed",
			oidcClientId: "echoed-id",
			oidcScopes: "openid email",
			oidcLoginLabel: "Continue with SSO",
		})
	})

	it("falls back to what was sent, trimmed, plus defaults", () => {
		const form = oidcFormFromResponse({}, fallback)
		expect(form).toEqual({
			authMode: "oidc",
			oidcIssuerUrl: "https://sent",
			oidcClientId: "sent-id",
			oidcScopes: DEFAULT_OIDC_SCOPES,
			oidcLoginLabel: DEFAULT_OIDC_LOGIN_LABEL,
		})
	})

	it("survives a null response body", () => {
		expect(oidcFormFromResponse(null, fallback).authMode).toBe("oidc")
	})
})

describe("oidcSaveMessage", () => {
	it("names the mode that was enabled", () => {
		expect(oidcSaveMessage("oidc")).toBe("OIDC login enabled")
		expect(oidcSaveMessage("both")).toBe("Password and OIDC login enabled")
		expect(oidcSaveMessage("password")).toBe("OIDC settings saved")
	})
})

describe("canTestOidc", () => {
	it("needs both an issuer and a client id", () => {
		expect(canTestOidc("https://idp", "abc")).toBe(true)
		expect(canTestOidc("https://idp", "")).toBe(false)
		expect(canTestOidc("", "abc")).toBe(false)
	})

	it("rejects whitespace-only input", () => {
		expect(canTestOidc("   ", "abc")).toBe(false)
		expect(canTestOidc("https://idp", "  ")).toBe(false)
	})

	it("does not require a secret, since a stored one may be in use", () => {
		expect(canTestOidc("https://idp", "abc")).toBe(true)
	})
})

describe("getLocaleFromCookie", () => {
	it("reads the locale and normalizes it", () => {
		expect(getLocaleFromCookie("locale=id", "locale", upcase)).toBe("ID")
	})

	it("finds the cookie among others", () => {
		expect(getLocaleFromCookie("a=1; locale=id; b=2", "locale", upcase)).toBe("ID")
	})

	it("decodes a percent-encoded value", () => {
		expect(getLocaleFromCookie("locale=zh%2DCN", "locale", upcase)).toBe("ZH-CN")
	})

	it("falls back to English without a cookie header", () => {
		expect(getLocaleFromCookie(undefined, "locale", upcase)).toBe("en")
	})

	it("falls back to English when the cookie is absent or empty", () => {
		expect(getLocaleFromCookie("a=1; b=2", "locale", upcase)).toBe("EN")
		expect(getLocaleFromCookie("locale=", "locale", upcase)).toBe("EN")
	})

	it("does not match a cookie whose name merely ends with the locale name", () => {
		expect(getLocaleFromCookie("my-locale=id", "locale", upcase)).toBe("EN")
	})
})

describe("oidcTestSuccessMessage", () => {
	it("does not claim the secret was checked when none was sent", () => {
		const msg = oidcTestSuccessMessage({ issuerUrl: "https://idp", clientSecretTested: false })
		expect(msg).toBe("Connection OK. Discovery loaded from https://idp.")
		expect(msg).not.toContain("secret")
	})

	it("says validated when the secret was tested and passed", () => {
		expect(
			oidcTestSuccessMessage({
				issuerUrl: "https://idp",
				clientSecretTested: true,
				clientSecretValid: true,
			}),
		).toBe("Connection OK. Discovery loaded from https://idp. Client secret validated too.")
	})

	it("says not checked when the secret was tested and failed", () => {
		// The test itself succeeded (discovery loaded); only the secret is unproven.
		expect(
			oidcTestSuccessMessage({
				issuerUrl: "https://idp",
				clientSecretTested: true,
				clientSecretValid: false,
			}),
		).toBe("Connection OK. Discovery loaded from https://idp. Client secret was not checked.")
	})

	it("treats an undefined clientSecretValid as not checked", () => {
		expect(oidcTestSuccessMessage({ issuerUrl: "https://idp", clientSecretTested: true })).toContain(
			"Client secret was not checked.",
		)
	})

	it("matches the nested ternary it replaced", () => {
		const legacy = (data: {
			issuerUrl?: string
			clientSecretTested?: boolean
			clientSecretValid?: boolean
		}) =>
			data.clientSecretTested
				? data.clientSecretValid === true
					? `Connection OK. Discovery loaded from ${data.issuerUrl}. Client secret validated too.`
					: `Connection OK. Discovery loaded from ${data.issuerUrl}. Client secret was not checked.`
				: `Connection OK. Discovery loaded from ${data.issuerUrl}.`
		for (const tested of [true, false, undefined]) {
			for (const valid of [true, false, undefined]) {
				const input = { issuerUrl: "https://idp", clientSecretTested: tested, clientSecretValid: valid }
				expect(oidcTestSuccessMessage(input)).toBe(legacy(input))
			}
		}
	})
})
