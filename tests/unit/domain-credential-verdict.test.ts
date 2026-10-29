// Tests for apps/api/src/domain/credential-verdict.ts — the module under test is
// the status-reading and credential-unwrapping rules extracted from the validate
// handler.
//
// Behaviour under test: which HTTP status proves an API key good or bad for each
// provider whose reading is not the default (xai 400-is-bad, tokenplan
// 403-is-fine, blackbox 400-is-fine, cloudflare 404-is-bad, anthropic 529-is-fine),
// plus the "unwrap whatever DevTools copied" rules for web-login credentials.
//
// No existing test file covers this: those readings were a 700-line switch inside
// apps/web/src/app/api/providers/validate/route.ts. Note domain-api-key-verdict
// covers a *different* question — reading a probe result the router already made
// for the provider switch.
//
// User instruction, verbatim: "lanjut kenapa malah berhenti".

import { describe, expect, it } from "vitest"
import {
	anthropicVerdict,
	blackboxVerdict,
	cloudflareVerdict,
	mediaProbeVerdict,
	notRefused,
	readerFor,
	readServiceAccount,
	refusalMessage,
	statusOk,
	toCookieHeader,
	tokenplanVerdict,
	unwrapCredential,
	webProbeVerdict,
	xaiVerdict,
} from "../../apps/api/src/domain/credential-verdict.ts"

describe("the default readings", () => {
	it("statusOk accepts only 2xx", () => {
		expect(statusOk(200)).toBe(true)
		expect(statusOk(204)).toBe(true)
		expect(statusOk(400)).toBe(false)
		expect(statusOk(401)).toBe(false)
	})

	it("notRefused treats anything but 401/403 as a proven key", () => {
		// A 400 about a missing model or a 429 about rate limits still proves the key
		// was accepted — that is why this is the default reading.
		expect(notRefused(400)).toBe(true)
		expect(notRefused(429)).toBe(true)
		expect(notRefused(500)).toBe(true)
		expect(notRefused(401)).toBe(false)
		expect(notRefused(403)).toBe(false)
	})
})

describe("xaiVerdict", () => {
	it("reads 403 as a valid key with no credit", () => {
		expect(xaiVerdict(403)).toBe(true)
	})

	it("reads 400 as a bad key", () => {
		// xai answers 400 for a bad key, so the default reading would call it valid.
		expect(xaiVerdict(400)).toBe(false)
	})

	it("reads 200 as valid", () => {
		expect(xaiVerdict(200)).toBe(true)
	})
})

describe("tokenplanVerdict", () => {
	it("reads 403 as a valid key lacking list permission", () => {
		expect(tokenplanVerdict(403)).toBe(true)
	})

	it("reads 401 as the only proof of a bad key", () => {
		expect(tokenplanVerdict(401)).toBe(false)
		expect(tokenplanVerdict(500)).toBe(true)
	})
})

describe("blackboxVerdict", () => {
	it("reads 400 as valid", () => {
		expect(blackboxVerdict(400)).toBe(true)
	})

	it("reads 401 and 403 as invalid", () => {
		expect(blackboxVerdict(401)).toBe(false)
		expect(blackboxVerdict(403)).toBe(false)
	})
})

describe("cloudflareVerdict", () => {
	it("reads 404 as invalid, because it means the account id is wrong", () => {
		expect(cloudflareVerdict(404)).toBe(false)
	})

	it("reads 400 as valid", () => {
		expect(cloudflareVerdict(400)).toBe(true)
	})
})

describe("anthropicVerdict", () => {
	it("reads 529 as valid: the key is fine, the service is busy", () => {
		expect(anthropicVerdict(529)).toBe(true)
	})

	it("reads 401 as invalid", () => {
		expect(anthropicVerdict(401)).toBe(false)
	})
})

describe("web and media probe readings", () => {
	it("both refuse only 401 and 403", () => {
		for (const read of [webProbeVerdict, mediaProbeVerdict]) {
			expect(read(200)).toBe(true)
			expect(read(404)).toBe(true)
			expect(read(401)).toBe(false)
			expect(read(403)).toBe(false)
		}
	})
})

describe("readerFor", () => {
	it("gives each exception its own reading", () => {
		expect(readerFor("xai")).toBe(xaiVerdict)
		expect(readerFor("xiaomi-tokenplan")).toBe(tokenplanVerdict)
		expect(readerFor("blackbox")).toBe(blackboxVerdict)
		expect(readerFor("cloudflare-ai")).toBe(cloudflareVerdict)
		expect(readerFor("anthropic")).toBe(anthropicVerdict)
	})

	it("gives an unknown provider the default reading", () => {
		expect(readerFor("openai")(400)).toBe(true)
		expect(readerFor("openai")(401)).toBe(false)
	})
})

describe("refusalMessage", () => {
	it("names the account when a 404 could have been the account id", () => {
		expect(refusalMessage("cloudflare-ai")).toMatch(/Account ID/)
	})

	it("names the configuration when Azure could have been misconfigured", () => {
		expect(refusalMessage("azure")).toMatch(/Azure configuration/)
	})

	it("falls back to the plain message", () => {
		expect(refusalMessage("openai")).toBe("Invalid API key")
	})
})

describe("readServiceAccount", () => {
	const complete = JSON.stringify({
		type: "service_account",
		client_email: "a@b.iam.gserviceaccount.com",
		private_key: "-----BEGIN-----\nx\n-----END-----",
		project_id: "p",
	})

	it("accepts a complete service-account file without any network call", () => {
		expect(readServiceAccount(complete)).toEqual({ isServiceAccount: true, valid: true })
	})

	it("rejects one missing a required field", () => {
		const partial = JSON.stringify({ type: "service_account", client_email: "a@b" })
		expect(readServiceAccount(partial)).toEqual({ isServiceAccount: true, valid: false })
	})

	it("reports a raw key as not a service account, so the caller probes it", () => {
		expect(readServiceAccount("AIzaSy-not-json")).toEqual({ isServiceAccount: false })
	})

	it("reports other JSON as not a service account", () => {
		expect(readServiceAccount(JSON.stringify({ type: "authorized_user" }))).toEqual({
			isServiceAccount: false,
		})
	})

	it("reports a JSON scalar as not a service account", () => {
		expect(readServiceAccount("42")).toEqual({ isServiceAccount: false })
	})
})

describe("unwrapCredential", () => {
	it("passes a bare token through", () => {
		expect(unwrapCredential("  token-123  ")).toBe("token-123")
	})

	it("reads the token out of a JSON envelope", () => {
		expect(unwrapCredential(JSON.stringify({ value: "abc" }))).toBe("abc")
		expect(unwrapCredential(JSON.stringify({ access_token: "def" }))).toBe("def")
	})

	it("reads userToken out of a pasted cookie string", () => {
		expect(unwrapCredential("a=1; userToken=xyz; b=2")).toBe("xyz")
	})

	it("strips a Bearer prefix in either case", () => {
		expect(unwrapCredential("Bearer abc")).toBe("abc")
		expect(unwrapCredential("authorization: bearer abc")).toBe("abc")
	})

	it("strips surrounding quotes", () => {
		expect(unwrapCredential('"abc"')).toBe("abc")
	})

	it("keeps the raw text when the JSON does not parse", () => {
		expect(unwrapCredential("{not json")).toBe("{not json")
	})
})

describe("toCookieHeader", () => {
	it("joins a cookie map into a header value", () => {
		expect(toCookieHeader(JSON.stringify({ a: "1", b: "2" }))).toBe("a=1; b=2")
	})

	it("reads a nested cookies map", () => {
		expect(toCookieHeader(JSON.stringify({ cookies: { a: "1" } }))).toBe("a=1")
	})

	it("drops empty values", () => {
		expect(toCookieHeader(JSON.stringify({ a: "1", b: "  " }))).toBe("a=1")
	})

	it("names a bare __Secure-1PSID value", () => {
		expect(toCookieHeader("abc")).toBe("__Secure-1PSID=abc")
	})

	it("leaves an already-named cookie alone", () => {
		expect(toCookieHeader("__Secure-1PSID=abc")).toBe("__Secure-1PSID=abc")
	})
})
