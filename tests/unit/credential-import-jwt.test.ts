/**
 * Reading a JWT's payload without asking the issuer.
 *
 * Module under test: `apps/api/src/domain/credential-import.ts`, functions `jwtPayloadOf` and
 * `codexClaimsOf` (lines 119-157). No test file is named after `credential-import`; the file is
 * touched only by `tests/unit/use-case-import-token.test.ts`, which exercises the use-case around
 * it. `jwtPayloadOf` appears in none of the 694 test files.
 *
 * Why this file exists: the base64url step is where this silently goes wrong. A JWT payload is
 * URL-safe base64 with the padding removed, and `Buffer.from(…, "base64")` accepts a malformed tail
 * without complaint — it just returns fewer bytes, `JSON.parse` throws, and the token is reported as
 * "not a JWT". The caller cannot tell that apart from a real non-JWT string, so a Codex token with
 * URL-safe characters in its payload would be stored with no email, no workspace and no expiry, and
 * nothing would say why.
 *
 * User's verbatim instruction: "lanjut lupakan prompt saya sebelumnya tentang writeup karena salah
 * kirim" — continue the work, and disregard the earlier write-up instruction, sent by mistake.
 */

import { codexClaimsOf, jwtPayloadOf } from "9router-api/domain/credential-import"
import { describe, expect, it } from "vitest"

/** Base64url of a JSON payload, the way an issuer writes it: no padding, `-` and `_` for `+` and `/`. */
function jwtWith(payload: unknown): string {
	const json = JSON.stringify(payload)
	const b64 = Buffer.from(json, "utf8").toString("base64url")
	return `header.${b64}.signature`
}

describe("the payload of a JWT", () => {
	it("decodes the URL-safe alphabet without translating it first", () => {
		// `Buffer` accepts `-` and `_` directly. This pins that, because a decoder that stopped
		// accepting them would silently turn every token into "not a JWT": no email, no workspace,
		// no expiry, and no error to explain it.
		const bytes = Buffer.from([0xfb, 0xff, 0xbf]).toString("base64url")
		expect(bytes).toContain("-")
		expect(Buffer.from(bytes, "base64").toString("hex")).toBe("fbffbf")
	})

	it("decodes a segment whose padding the issuer stripped", () => {
		const unpadded = Buffer.from('{"a":"x"}', "utf8").toString("base64url")
		expect(unpadded).not.toContain("=")
		expect(Buffer.from(unpadded, "base64").toString("utf8")).toBe('{"a":"x"}')
	})

	it("reads a token whose payload needs no padding", () => {
		expect(jwtPayloadOf(jwtWith({ a: "x" }))).toEqual({ a: "x" })
	})

	it("reads every payload length, because padding is stripped by the issuer", () => {
		for (const value of ["", "a", "ab", "abc", "abcd", "abcde", "abcdef"]) {
			expect(jwtPayloadOf(jwtWith({ v: value }))).toEqual({ v: value })
		}
	})

	it("reads a payload whose base64 contains URL-safe characters", () => {
		// Characters whose UTF-8 bytes produce `+` and `/` in standard base64 are the ones a
		// replacement-free decode gets wrong. `?` (0x3f) and `~` (0x7e) do it.
		const payload = { q: "???", t: "~~~", u: "ÿþý" }
		expect(jwtPayloadOf(jwtWith(payload))).toEqual(payload)
	})

	it("returns null when the string is not three parts", () => {
		for (const token of ["", "abc", "a.b", "a.b.c.d"]) {
			expect(jwtPayloadOf(token)).toBeNull()
		}
	})

	it("rejects a four-part string even when its second part decodes", () => {
		// Without the exact-length check, `a.<valid payload>.c.d` would be read as a JWT: the
		// second segment parses, so nothing downstream would notice the shape was wrong.
		const valid = Buffer.from('{"a":"x"}', "utf8").toString("base64url")
		expect(jwtPayloadOf(`a.${valid}.c.d`)).toBeNull()
	})

	it("returns null when the payload is not base64 of JSON", () => {
		expect(jwtPayloadOf("a.not-json.c")).toBeNull()
		expect(jwtPayloadOf("a.!!!.c")).toBeNull()
	})

	it("returns null when the payload decodes to a non-object", () => {
		for (const value of ["text", 42, null, true]) {
			expect(
				jwtPayloadOf(`a.${Buffer.from(JSON.stringify(value)).toString("base64url")}.c`),
			).toBeNull()
		}
	})
})

describe("what a Codex token says about its account", () => {
	const full = {
		"https://api.openai.com/auth": { chatgpt_account_id: "ws-1", chatgpt_plan_type: "pro" },
		"https://api.openai.com/profile": { email: "op@example.com" },
		exp: 1_800_000_000,
	}

	it("reads the workspace, the plan and the expiry out of their namespaced claims", () => {
		expect(codexClaimsOf(jwtWith(full))).toEqual({
			email: "op@example.com",
			chatgptAccountId: "ws-1",
			chatgptPlanType: "pro",
			expiresAtEpoch: 1_800_000_000,
		})
	})

	it("falls back from the profile email to a top-level email, then to the username", () => {
		expect(codexClaimsOf(jwtWith({ email: "top@example.com" })).email).toBe("top@example.com")
		expect(codexClaimsOf(jwtWith({ preferred_username: "user1" })).email).toBe("user1")
	})

	it("prefers the profile email over the top-level one", () => {
		const token = jwtWith({
			email: "top@example.com",
			"https://api.openai.com/profile": { email: "p@x" },
		})
		expect(codexClaimsOf(token).email).toBe("p@x")
	})

	it("a non-JWT token is still importable, carrying no claims", () => {
		const claims = codexClaimsOf("sk-not-a-jwt")
		expect(claims).toEqual({
			email: null,
			chatgptAccountId: null,
			chatgptPlanType: null,
			expiresAtEpoch: null,
		})
	})

	it("an empty string is not read as an email", () => {
		expect(codexClaimsOf(jwtWith({ email: "" })).email).toBeNull()
	})

	it("a non-numeric exp is not read as an expiry", () => {
		expect(codexClaimsOf(jwtWith({ exp: "1800000000" })).expiresAtEpoch).toBeNull()
	})

	it("missing namespaced claims yield nulls rather than throwing", () => {
		const claims = codexClaimsOf(jwtWith({}))
		expect(claims.chatgptAccountId).toBeNull()
		expect(claims.chatgptPlanType).toBeNull()
	})
})
