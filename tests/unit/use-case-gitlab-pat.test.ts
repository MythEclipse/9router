import { describe, expect, it, vi } from "vitest"
import { importGitlabPat } from "../../apps/api/src/application/oauth/gitlab-pat.ts"
import {
	GITLAB_DEFAULT_BASE,
	gitlabDisplayName,
	gitlabUserOf,
	gitlabVerifyFailure,
	isBlockedUrlError,
	readGitlabPatInput,
} from "../../apps/api/src/domain/gitlab-pat.ts"

describe("readGitlabPatInput", () => {
	it("defaults the base URL to gitlab.com when none was typed", () => {
		const read = readGitlabPatInput({ token: "glpat-abc" })
		expect(read.input).toEqual({ token: "glpat-abc", baseUrl: GITLAB_DEFAULT_BASE })
	})

	it("trims the token, because a pasted token usually carries trailing space", () => {
		expect(readGitlabPatInput({ token: "  glpat-abc \n" }).input?.token).toBe("glpat-abc")
	})

	it("drops a trailing slash so the verification path never doubles it", () => {
		const read = readGitlabPatInput({ token: "t", baseUrl: "https://git.example.com/" })
		expect(read.input?.baseUrl).toBe("https://git.example.com")
	})

	it("keeps a self-hosted host as typed", () => {
		const read = readGitlabPatInput({ token: "t", baseUrl: " https://git.internal.corp " })
		expect(read.input?.baseUrl).toBe("https://git.internal.corp")
	})

	it("refuses an empty token before any request is made", () => {
		// GitLab would answer 401 mentioning scopes, which sends the operator to the wrong
		// place — the real mistake is that no token was supplied.
		expect(readGitlabPatInput({ token: "   " })).toEqual({
			ok: false,
			error: "Personal Access Token is required",
		})
	})

	it("refuses a missing or non-object body", () => {
		expect(readGitlabPatInput(null).ok).toBe(false)
		expect(readGitlabPatInput({}).ok).toBe(false)
		expect(readGitlabPatInput({ token: 42 }).ok).toBe(false)
	})
})

describe("gitlabUserOf", () => {
	it("reads the identity fields a connection row needs", () => {
		const user = gitlabUserOf({ email: "a@b.c", name: "Ada", username: "ada" })
		expect(user).toEqual({ email: "a@b.c", name: "Ada", username: "ada" })
	})

	it("falls back to public_email when the primary address is hidden", () => {
		expect(gitlabUserOf({ public_email: "pub@b.c" }).email).toBe("pub@b.c")
	})

	it("answers empty strings rather than undefined, so the row stays well-typed", () => {
		expect(gitlabUserOf({})).toEqual({ email: "", name: "", username: "" })
	})
})

describe("gitlabDisplayName", () => {
	it("prefers the full name, then the username, then the email", () => {
		expect(gitlabDisplayName({ name: "Ada", username: "ada", email: "a@b.c" })).toBe("Ada")
		expect(gitlabDisplayName({ name: "", username: "ada", email: "a@b.c" })).toBe("ada")
		expect(gitlabDisplayName({ name: "", username: "", email: "a@b.c" })).toBe("a@b.c")
	})
})

describe("gitlabVerifyFailure", () => {
	it("keeps GitLab's own text, which names the missing scope", () => {
		expect(gitlabVerifyFailure(401, "401 Unauthorized")).toBe(
			"GitLab token verification failed: 401 Unauthorized",
		)
	})

	it("falls back to the status when the body is empty", () => {
		expect(gitlabVerifyFailure(502, "  ")).toBe("GitLab token verification failed: HTTP 502")
	})
})

describe("isBlockedUrlError", () => {
	it("recognises the SSRF guard's refusal", () => {
		expect(isBlockedUrlError(new Error("Blocked URL: 169.254.169.254"))).toBe(true)
	})

	it("does not mistake a network failure for a refused host", () => {
		expect(isBlockedUrlError(new Error("fetch failed"))).toBe(false)
		expect(isBlockedUrlError(null)).toBe(false)
	})
})

/** A fetch that answers a fixed response, recording the URL it was given. */
function fetchAnswering(response: { ok: boolean; status?: number; body?: unknown; text?: string }) {
	const seen: string[] = []
	const impl = vi.fn(async (url: string) => {
		seen.push(url)
		return {
			ok: response.ok,
			status: response.status ?? (response.ok ? 200 : 401),
			json: async () => response.body,
			text: async () => response.text ?? "",
		}
	})
	return { impl: impl as unknown as typeof globalThis.fetch, seen }
}

describe("importGitlabPat", () => {
	const created: Record<string, unknown>[] = []
	const deps = (fetchImpl: typeof globalThis.fetch) => ({
		fetchImpl,
		createConnection: vi.fn(async (input: Record<string, unknown>) => {
			created.push(input)
			return { id: "conn-1" }
		}),
	})

	it("stores the token only after GitLab confirms it", async () => {
		const { impl, seen } = fetchAnswering({
			ok: true,
			body: { email: "a@b.c", name: "Ada", username: "ada" },
		})
		const host = deps(impl)
		const answer = await importGitlabPat({ token: " glpat-abc " }, host)

		expect(answer).toEqual({ ok: true, status: 200, body: { success: true } })
		expect(seen[0]).toBe(`${GITLAB_DEFAULT_BASE}/api/v4/user`)
		expect(host.createConnection).toHaveBeenCalledTimes(1)
	})

	it("writes the token and identity into the connection row", async () => {
		created.length = 0
		const { impl } = fetchAnswering({
			ok: true,
			body: { email: "a@b.c", name: "Ada", username: "ada" },
		})
		await importGitlabPat({ token: "glpat-abc" }, deps(impl))

		expect(created[0]).toMatchObject({
			provider: "gitlab",
			authType: "oauth",
			accessToken: "glpat-abc",
			expiresAt: null,
			email: "a@b.c",
			displayName: "Ada",
			testStatus: "active",
			providerSpecificData: {
				username: "ada",
				email: "a@b.c",
				name: "Ada",
				baseUrl: GITLAB_DEFAULT_BASE,
				authKind: "personal_access_token",
			},
		})
	})

	it("answers 401 with GitLab's message and writes nothing when the token is refused", async () => {
		const { impl } = fetchAnswering({ ok: false, status: 401, text: "401 Unauthorized" })
		const host = deps(impl)
		const answer = await importGitlabPat({ token: "bad" }, host)

		expect(answer.ok).toBe(false)
		expect(answer.status).toBe(401)
		expect(answer.body.error).toContain("GitLab token verification failed")
		expect(host.createConnection).not.toHaveBeenCalled()
	})

	it("answers 400 for an empty token, without asking GitLab at all", async () => {
		const { impl, seen } = fetchAnswering({ ok: true })
		const host = deps(impl)
		const answer = await importGitlabPat({ token: "  " }, host)

		expect(answer).toEqual({
			ok: false,
			status: 400,
			body: { error: "Personal Access Token is required" },
		})
		expect(seen).toEqual([])
		expect(host.createConnection).not.toHaveBeenCalled()
	})

	it("answers 400 for a host the SSRF guard refuses, not 500", async () => {
		// A typed base URL pointing at a metadata host is the operator's mistake.
		const refusing = (async () => {
			throw new Error("Blocked URL: http://169.254.169.254")
		}) as unknown as typeof globalThis.fetch
		const answer = await importGitlabPat(
			{ token: "t", baseUrl: "http://169.254.169.254" },
			deps(refusing),
		)

		expect(answer).toEqual({ ok: false, status: 400, body: { error: "URL not allowed" } })
	})

	it("answers 500 with the message for anything else that breaks", async () => {
		const broken = (async () => {
			throw new Error("socket hang up")
		}) as unknown as typeof globalThis.fetch
		const answer = await importGitlabPat({ token: "t" }, deps(broken))

		expect(answer).toEqual({ ok: false, status: 500, body: { error: "socket hang up" } })
	})

	it("sends the token in the Private-Token header, not the URL", async () => {
		let captured: RequestInit | undefined
		const impl = vi.fn(async (_url: string, init?: RequestInit) => {
			captured = init
			return { ok: true, status: 200, json: async () => ({}), text: async () => "" }
		}) as unknown as typeof globalThis.fetch

		await importGitlabPat({ token: "glpat-secret" }, deps(impl))
		const headers = (captured?.headers ?? {}) as Record<string, string>
		expect(headers["Private-Token"]).toBe("glpat-secret")
	})
})
