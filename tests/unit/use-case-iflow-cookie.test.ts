import { describe, expect, it, vi } from "vitest"
import { importIflowCookie } from "../../apps/api/src/application/oauth/iflow-cookie.ts"
import {
	cookieForRequest,
	cookieForStorage,
	IFLOW_APIKEY_URL,
	iflowEnvelopeFailure,
	iflowKeyName,
	iflowRefreshedKey,
	maskedIflowKey,
	readIflowCookie,
} from "../../apps/api/src/domain/iflow-cookie.ts"

describe("readIflowCookie", () => {
	it("accepts a cookie that carries BXAuth", () => {
		expect(readIflowCookie({ cookie: "BXAuth=abc; other=1" })).toEqual({
			ok: true,
			cookie: "BXAuth=abc; other=1",
		})
	})

	it("trims the pasted cookie", () => {
		expect(readIflowCookie({ cookie: "  BXAuth=abc  " }).cookie).toBe("BXAuth=abc")
	})

	it("refuses an empty cookie", () => {
		expect(readIflowCookie({ cookie: "  " })).toEqual({
			ok: false,
			error: "Cookie is required",
		})
	})

	it("refuses a cookie from another site, which would fail confusingly later", () => {
		expect(readIflowCookie({ cookie: "session=abc" })).toEqual({
			ok: false,
			error: "Cookie must contain BXAuth field",
		})
	})

	it("refuses a body that is not an object", () => {
		expect(readIflowCookie(null).ok).toBe(false)
		expect(readIflowCookie({ cookie: 123 }).ok).toBe(false)
	})
})

describe("cookieForRequest", () => {
	it("adds the terminator the platform splits on", () => {
		expect(cookieForRequest("BXAuth=abc")).toBe("BXAuth=abc;")
	})

	it("leaves an already-terminated cookie alone", () => {
		expect(cookieForRequest("BXAuth=abc;")).toBe("BXAuth=abc;")
	})
})

describe("cookieForStorage", () => {
	it("keeps only BXAuth, so other sites' sessions are not persisted", () => {
		expect(cookieForStorage("BXAuth=abc; utm=xyz; session=secret;")).toBe("BXAuth=abc;")
	})

	it("answers empty when there is nothing worth storing", () => {
		expect(cookieForStorage("utm=xyz;")).toBe("")
	})
})

describe("iflow envelope reading", () => {
	it("reads the key name", () => {
		expect(iflowKeyName({ name: "my-key" })).toBe("my-key")
	})

	it("answers empty for a missing name", () => {
		expect(iflowKeyName({})).toBe("")
		expect(iflowKeyName(undefined)).toBe("")
	})

	it("treats only an explicit success as success", () => {
		expect(iflowEnvelopeFailure({ success: true })).toBeNull()
		expect(iflowEnvelopeFailure({ success: false, message: "expired" })).toBe("expired")
		expect(iflowEnvelopeFailure({})).toBe("")
	})

	it("reads the refreshed key and its expiry", () => {
		expect(iflowRefreshedKey({ apiKey: "sk-1", name: "n", expireTime: 123 })).toEqual({
			apiKey: "sk-1",
			name: "n",
			expireTime: 123,
		})
		expect(iflowRefreshedKey({}).apiKey).toBe("")
	})
})

describe("maskedIflowKey", () => {
	it("shows only the prefix, enough to tell two connections apart", () => {
		expect(maskedIflowKey("sk-1234567890abcdef")).toBe("sk-1234567...")
	})

	it("does not throw on a short key", () => {
		expect(maskedIflowKey("sk-1")).toBe("sk-1...")
	})
})

/** A fetch whose answers are scripted per call, recording each request. */
function scriptedFetch(answers: { ok: boolean; status?: number; body?: unknown; text?: string }[]) {
	const calls: { url: string; init?: RequestInit }[] = []
	let index = 0
	const impl = vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({ url, init })
		const answer = answers[index++] ?? { ok: false, status: 500, text: "no answer scripted" }
		return {
			ok: answer.ok,
			status: answer.status ?? (answer.ok ? 200 : 401),
			json: async () => answer.body,
			text: async () => answer.text ?? "",
		}
	})
	return { impl: impl as unknown as typeof globalThis.fetch, calls }
}

const OK_NAME = { ok: true, body: { success: true, data: { name: "desk" } } }
const OK_KEY = {
	ok: true,
	body: { success: true, data: { apiKey: "sk-1234567890abcd", name: "desk", expireTime: 99 } },
}

function deps(fetchImpl: typeof globalThis.fetch) {
	return {
		fetchImpl,
		createConnection: vi.fn(async (input: Record<string, unknown>) => ({
			id: "conn-1",
			provider: "iflow",
			email: String(input.email),
		})),
	}
}

describe("importIflowCookie", () => {
	it("reads the key name, then refreshes it, then saves the connection", async () => {
		const { impl, calls } = scriptedFetch([OK_NAME, OK_KEY])
		const host = deps(impl)
		const answer = await importIflowCookie({ cookie: "BXAuth=abc" }, host)

		expect(answer.ok).toBe(true)
		expect(calls).toHaveLength(2)
		expect(calls[0].url).toBe(IFLOW_APIKEY_URL)
		expect(calls[0].init?.method).toBe("GET")
		expect(calls[1].init?.method).toBe("POST")
		expect(JSON.parse(String(calls[1].init?.body))).toEqual({ name: "desk" })
		expect(host.createConnection).toHaveBeenCalledTimes(1)
	})

	it("sends the terminator the platform expects on both calls", async () => {
		const { impl, calls } = scriptedFetch([OK_NAME, OK_KEY])
		await importIflowCookie({ cookie: "BXAuth=abc" }, deps(impl))

		for (const call of calls) {
			const headers = (call.init?.headers ?? {}) as Record<string, string>
			expect(headers.Cookie).toBe("BXAuth=abc;")
		}
	})

	it("stores only BXAuth, not the whole pasted jar", async () => {
		const { impl } = scriptedFetch([OK_NAME, OK_KEY])
		const host = deps(impl)
		await importIflowCookie({ cookie: "BXAuth=abc; session=secret;" }, host)

		const written = host.createConnection.mock.calls[0][0] as Record<string, unknown>
		expect((written.providerSpecificData as Record<string, unknown>).cookie).toBe("BXAuth=abc;")
		expect(JSON.stringify(written)).not.toContain("secret")
	})

	it("masks the key in the answer", async () => {
		const { impl } = scriptedFetch([OK_NAME, OK_KEY])
		const answer = await importIflowCookie({ cookie: "BXAuth=abc" }, deps(impl))

		const connection = (answer.body as { connection: Record<string, unknown> }).connection
		expect(connection.apiKey).toBe("sk-1234567...")
		expect(JSON.stringify(answer.body)).not.toContain("sk-1234567890abcd")
	})

	it("saves the human name iFlow reported, which is not always the refreshed one", async () => {
		const { impl } = scriptedFetch([
			OK_NAME,
			{ ok: true, body: { success: true, data: { apiKey: "sk-1", name: "" } } },
		])
		const host = deps(impl)
		await importIflowCookie({ cookie: "BXAuth=abc" }, host)

		const written = host.createConnection.mock.calls[0][0] as Record<string, unknown>
		expect(written.name).toBe("desk")
		expect(written.email).toBe("desk")
	})

	it("refuses before calling anything when the cookie is empty", async () => {
		const { impl, calls } = scriptedFetch([])
		const host = deps(impl)
		const answer = await importIflowCookie({ cookie: "" }, host)

		expect(answer).toEqual({ ok: false, status: 400, body: { error: "Cookie is required" } })
		expect(calls).toEqual([])
		expect(host.createConnection).not.toHaveBeenCalled()
	})

	it("passes the platform's own status through when the cookie is refused", async () => {
		// A 403 from iFlow means the session expired; flattening it to 500 would read as a bug.
		const { impl } = scriptedFetch([{ ok: false, status: 403, text: "forbidden" }])
		const host = deps(impl)
		const answer = await importIflowCookie({ cookie: "BXAuth=abc" }, host)

		expect(answer.status).toBe(403)
		expect(String(answer.body.error)).toContain("Failed to fetch API key info")
		expect(host.createConnection).not.toHaveBeenCalled()
	})

	it("refuses when the name is missing, because the refresh cannot be addressed", async () => {
		const { impl, calls } = scriptedFetch([{ ok: true, body: { success: true, data: {} } }])
		const host = deps(impl)
		const answer = await importIflowCookie({ cookie: "BXAuth=abc" }, host)

		expect(answer).toEqual({
			ok: false,
			status: 400,
			body: { error: "Missing name in API key info" },
		})
		expect(calls).toHaveLength(1)
		expect(host.createConnection).not.toHaveBeenCalled()
	})

	it("refuses when the refresh returns no key, even though the call succeeded", async () => {
		// A connection without a key would exist and never authenticate.
		const { impl } = scriptedFetch([
			OK_NAME,
			{ ok: true, body: { success: true, data: { name: "desk" } } },
		])
		const host = deps(impl)
		const answer = await importIflowCookie({ cookie: "BXAuth=abc" }, host)

		expect(answer).toEqual({
			ok: false,
			status: 400,
			body: { error: "Missing API key in response" },
		})
		expect(host.createConnection).not.toHaveBeenCalled()
	})

	it("reports an envelope failure with the platform's message", async () => {
		const { impl } = scriptedFetch([{ ok: true, body: { success: false, message: "expired" } }])
		const answer = await importIflowCookie({ cookie: "BXAuth=abc" }, deps(impl))

		expect(answer).toEqual({
			ok: false,
			status: 400,
			body: { error: "API key fetch failed: expired" },
		})
	})

	it("answers 500 when the network itself fails", async () => {
		const broken = (async () => {
			throw new Error("getaddrinfo ENOTFOUND")
		}) as unknown as typeof globalThis.fetch
		const answer = await importIflowCookie({ cookie: "BXAuth=abc" }, deps(broken))

		expect(answer).toEqual({
			ok: false,
			status: 500,
			body: { error: "getaddrinfo ENOTFOUND" },
		})
	})
})
