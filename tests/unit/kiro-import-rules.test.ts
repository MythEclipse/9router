import { describe, expect, test } from "vitest"
import {
	KIRO_IMPORT_REFUSAL_STATUS,
	kiroImportPayload,
	kiroImportRefusalMessage,
	kiroImportSummary,
} from "../../apps/api/src/domain/kiro-import"

const BLOB = { access_token: "a", refresh_token: "r" }

describe("kiroImportPayload", () => {
	test("all three envelope keys are unwrapped", () => {
		// CLIProxyAPI exports `cliProxyAuth`; hand-written callers send `auth` or `json`.
		expect(kiroImportPayload({ cliProxyAuth: BLOB })).toEqual(BLOB)
		expect(kiroImportPayload({ auth: BLOB })).toEqual(BLOB)
		expect(kiroImportPayload({ json: BLOB })).toEqual(BLOB)
	})

	test("a bare blob is passed through, so the normaliser can name the missing field", () => {
		expect(kiroImportPayload(BLOB)).toEqual(BLOB)
		expect(kiroImportPayload(BLOB)).toBe(BLOB)
	})

	test("the first envelope key wins when several are present", () => {
		expect(kiroImportPayload({ cliProxyAuth: BLOB, auth: { other: true } })).toEqual(BLOB)
	})

	test("a non-object body survives instead of throwing here", () => {
		// The normaliser is the component that rejects it; this function must not pre-empt that.
		expect(kiroImportPayload("text")).toBe("text")
		expect(kiroImportPayload(null)).toBe(null)
	})
})

describe("kiroImportRefusalMessage", () => {
	test("the normaliser's sentence is forwarded, because it names the field", () => {
		expect(kiroImportRefusalMessage(new Error("token_endpoint must use https"))).toBe(
			"token_endpoint must use https",
		)
	})

	test("an empty or non-Error throw still answers with a sentence", () => {
		expect(kiroImportRefusalMessage(new Error(""))).toBe("CLIProxyAPI import failed")
		expect(kiroImportRefusalMessage(undefined)).toBe("CLIProxyAPI import failed")
		expect(kiroImportRefusalMessage(null)).toBe("CLIProxyAPI import failed")
	})

	test("a thrown string is used as-is", () => {
		expect(kiroImportRefusalMessage("only external_idp is supported")).toBe(
			"only external_idp is supported",
		)
	})

	test("a bad payload is a 400, not a 500 — the request was wrong", () => {
		expect(KIRO_IMPORT_REFUSAL_STATUS).toBe(400)
	})
})

describe("kiroImportSummary", () => {
	const connection = {
		id: "conn_1",
		provider: "kiro",
		email: "a@b.c",
		accessToken: "ACCESS",
		refreshToken: "REFRESH",
	}

	test("it names the account that landed", () => {
		expect(kiroImportSummary(connection)).toEqual({
			success: true,
			connection: { id: "conn_1", provider: "kiro", email: "a@b.c" },
		})
	})

	test("it never echoes the tokens it just stored", () => {
		// An import response is the last place a refresh token should reappear.
		const body = JSON.stringify(kiroImportSummary(connection))
		expect(body).not.toContain("ACCESS")
		expect(body).not.toContain("REFRESH")
	})
})
