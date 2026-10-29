import { describe, expect, test } from "vitest"
import {
	DEFAULT_OIDC_SCOPES,
	DEFAULT_SAML_ISSUER,
	escapeXml,
	isHttpUrl,
	isProbeRefusal,
	oidcProbeInput,
	oidcProbeOutcome,
	oidcProbeSucceeded,
	oidcRedirectUri,
	oidcSecretRejection,
	passwordResetPatch,
	passwordResetResponse,
	probeAccess,
	samlEndpoints,
	samlMetadataErrorBody,
	samlProbeInput,
	submittedOrSaved,
} from "../../apps/api/src/domain/sso-probe"

describe("probeAccess", () => {
	test("a public dashboard lets the probe through", () => {
		// The operator chose to run without auth; the probe is no more sensitive than settings.
		expect(probeAccess(false, false)).toBe(null)
	})

	test("a login-required dashboard needs a session", () => {
		expect(probeAccess(true, true)).toBe(null)
		expect(probeAccess(true, false)).toEqual({ status: 401, message: "Unauthorized" })
	})
})

describe("submittedOrSaved", () => {
	test("an absent key falls back to the saved value", () => {
		expect(submittedOrSaved({}, "samlCert", "SAVED")).toBe("SAVED")
		expect(submittedOrSaved(null, "samlCert", "saved")).toBe("saved")
	})

	test("an explicitly blanked key does NOT fall back", () => {
		// This is the whole point: `||` would resurrect the old certificate after it was cleared.
		expect(submittedOrSaved({ samlCert: "" }, "samlCert", "SAVED")).toBe("")
		expect(submittedOrSaved({ samlCert: null }, "samlCert", "SAVED")).toBe("")
	})

	test("a submitted value wins and is trimmed", () => {
		expect(submittedOrSaved({ samlCert: "  NEW  " }, "samlCert", "SAVED")).toBe("NEW")
	})

	test("undefined and null become an empty string, not the text 'undefined'", () => {
		expect(submittedOrSaved({}, "k", undefined)).toBe("")
		expect(submittedOrSaved({}, "k", null)).toBe("")
		expect(submittedOrSaved({ k: 0 }, "k", "x")).toBe("0")
	})
})

describe("isHttpUrl", () => {
	test("http and https are accepted", () => {
		expect(isHttpUrl("https://idp.example.com/sso")).toBe(true)
		expect(isHttpUrl("http://localhost:8080")).toBe(true)
	})

	test("a bare hostname is not a URL", () => {
		expect(isHttpUrl("idp.example.com")).toBe(false)
	})

	test("a non-http scheme is refused, because this value is handed to a redirect", () => {
		// `new URL("javascript:...")` parses fine — the scheme check is load-bearing.
		expect(isHttpUrl("javascript:alert(1)")).toBe(false)
		expect(isHttpUrl("data:text/html,x")).toBe(false)
		expect(isHttpUrl("file:///etc/passwd")).toBe(false)
	})
})

describe("samlProbeInput", () => {
	const saved = {
		samlEntryPoint: "https://idp/sso",
		samlIssuer: "urn:custom",
		samlCert: "CERT",
	}

	test("saved values are used when the body is empty", () => {
		const answer = samlProbeInput({}, saved)
		expect(isProbeRefusal(answer)).toBe(false)
		if (!isProbeRefusal(answer)) {
			expect(answer.body).toEqual({
				entryPoint: "https://idp/sso",
				issuer: "urn:custom",
				certificate: "CERT",
			})
		}
	})

	test("a missing entry point is refused first", () => {
		const answer = samlProbeInput({}, null)
		expect(isProbeRefusal(answer)).toBe(true)
		if (isProbeRefusal(answer)) expect(answer.refusal.message).toContain("samlEntryPoint")
	})

	test("an invalid URL is refused before the certificate is looked at", () => {
		// One field at a time: reporting three problems makes for three rounds of fixing.
		const answer = samlProbeInput({ samlEntryPoint: "nope" }, saved)
		expect(isProbeRefusal(answer)).toBe(true)
		if (isProbeRefusal(answer)) expect(answer.refusal.message).toContain("valid URL")
	})

	test("the default issuer applies when none is given", () => {
		const answer = samlProbeInput({}, { samlEntryPoint: "https://idp/sso", samlCert: "CERT" })
		if (!isProbeRefusal(answer)) expect(answer.body.issuer).toBe(DEFAULT_SAML_ISSUER)
	})

	test("a cleared certificate is required, not resurrected", () => {
		const answer = samlProbeInput({ samlCert: "" }, saved)
		expect(isProbeRefusal(answer)).toBe(true)
		if (isProbeRefusal(answer)) expect(answer.refusal.message).toContain("samlCert")
	})
})

describe("samlEndpoints", () => {
	test("it reports both URLs an IdP needs", () => {
		expect(samlEndpoints("https://box.example")).toEqual({
			acsUrl: "https://box.example/api/auth/saml/acs",
			metadataUrl: "https://box.example/api/auth/saml/metadata",
		})
	})
})

describe("oidcProbeInput", () => {
	const saved = {
		oidcIssuerUrl: "https://idp",
		oidcClientId: "cid",
		oidcScopes: "openid email",
		oidcClientSecret: "sec",
	}

	test("saved values are used when the body is empty", () => {
		const answer = oidcProbeInput({}, saved)
		if (!isProbeRefusal(answer)) {
			expect(answer.body).toEqual({
				issuerUrl: "https://idp",
				clientId: "cid",
				scopes: "openid email",
				clientSecret: "sec",
			})
		}
	})

	test("issuer is checked before client id", () => {
		const answer = oidcProbeInput({}, null)
		if (isProbeRefusal(answer)) expect(answer.refusal.message).toBe("Issuer URL is required")
	})

	test("a missing client id is refused", () => {
		const answer = oidcProbeInput({}, { oidcIssuerUrl: "https://idp" })
		if (isProbeRefusal(answer)) expect(answer.refusal.message).toBe("Client ID is required")
	})

	test("default scopes apply when none are given", () => {
		const answer = oidcProbeInput({}, { oidcIssuerUrl: "https://idp", oidcClientId: "cid" })
		if (!isProbeRefusal(answer)) expect(answer.body.scopes).toBe(DEFAULT_OIDC_SCOPES)
	})

	test("a cleared secret stays cleared", () => {
		const answer = oidcProbeInput({ clientSecret: "" }, saved)
		if (!isProbeRefusal(answer)) expect(answer.body.clientSecret).toBe("")
	})
})

describe("oidcProbeOutcome", () => {
	test("a rejected secret is its own outcome", () => {
		// Discovery worked; saying only "failed" sends the operator to debug their network.
		expect(oidcProbeOutcome({ tested: true, valid: false, message: "invalid_client" })).toEqual({
			kind: "secret-rejected",
			message: "invalid_client",
		})
	})

	test("an untested secret is not a rejection", () => {
		expect(oidcProbeOutcome({ tested: false }).kind).toBe("ok")
	})

	test("a validated secret is ok", () => {
		expect(oidcProbeOutcome({ tested: true, valid: true }).kind).toBe("ok")
	})

	test("only an ok outcome counts as success", () => {
		expect(oidcProbeSucceeded({ kind: "ok", tested: true, valid: true, message: "" })).toBe(true)
		expect(oidcProbeSucceeded({ kind: "secret-rejected", message: "x" })).toBe(false)
	})

	test("the rejection sentence says discovery was fine", () => {
		expect(oidcSecretRejection("bad secret")).toBe(
			"Discovery loaded, but the client secret is not valid: bad secret",
		)
	})
})

describe("oidcRedirectUri", () => {
	test("it is the callback the IdP must be given", () => {
		expect(oidcRedirectUri("https://box.example")).toBe("https://box.example/api/auth/oidc/callback")
	})
})

describe("escapeXml / samlMetadataErrorBody", () => {
	test("all five XML-significant characters are escaped", () => {
		expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;")
	})

	test("an error body is still valid XML", () => {
		// A raw `&` here breaks the document the operator is importing.
		expect(samlMetadataErrorBody("bad & cert <x>")).toBe(
			'<?xml version="1.0"?><Error>bad &amp; cert &lt;x&gt;</Error>',
		)
	})

	test("a missing message gets a readable default", () => {
		expect(samlMetadataErrorBody(undefined)).toContain("Failed to generate metadata")
		expect(samlMetadataErrorBody("")).toContain("Failed to generate metadata")
	})
})

describe("password reset", () => {
	test("it clears the hash to null, which is what re-enables the default", () => {
		expect(passwordResetPatch()).toEqual({ password: null })
	})

	test("the response never names the credential", () => {
		// This response may be logged, and the route is local-only for a reason.
		expect(passwordResetResponse()).toEqual({ success: true })
		expect(JSON.stringify(passwordResetResponse())).not.toContain("123456")
	})
})
