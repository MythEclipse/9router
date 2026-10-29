// Tests for apps/api/src/application/providers/web-login.ts — the module under test
// drives a browser login end to end and stores the harvested credential.
//
// Behaviour under test: which row a re-login refreshes, the duplicate cleanup, the
// credential never leaving the process, and the failure modes that must report a
// message instead of throwing.
//
// No existing test file covers this: the flow lived inside the four handlers of
// apps/web/src/app/api/providers/web-login/route.ts.
//
// User instruction, verbatim: "lanjut kenapa malah berhenti".

import { describe, expect, it, vi } from "vitest"
import type { WebLoginSession } from "../../apps/api/src/application/providers/web-login.ts"
import { makeWebLogin } from "../../apps/api/src/application/providers/web-login.ts"

function harness(
	options: {
		rows?: Record<string, unknown>[]
		session?: WebLoginSession | null
		identity?: { status: string; email?: string | null; error?: string | null }
		config?: { credentialFrom?: string } | null
		createError?: { code: string; existingName?: string }
	} = {},
) {
	const sessions = new Map<string, WebLoginSession>()
	if (options.session !== null) sessions.set("gemini-web", options.session ?? { status: "pending" })

	const store = {
		list: vi.fn(async () => options.rows ?? []),
		find: vi.fn(async () => null),
		create: vi.fn(async (_fields: Record<string, unknown>) => {
			if (options.createError) throw options.createError
			return { id: "created-1" }
		}),
		update: vi.fn(async (_id: string, _fields: Record<string, unknown>) => ({ id: "updated" })),
		remove: vi.fn(async () => true),
	}
	const useCase = makeWebLogin({
		connections: store as never,
		listProviders: () => ["gemini-web"],
		listProfiles: () => ["default"],
		configOf: () => (options.config === undefined ? { credentialFrom: "cookie" } : options.config),
		statusOf: (provider) => sessions.get(provider) ?? null,
		start: vi.fn(async (provider: string, profile: string) => {
			const session: WebLoginSession = { status: "pending", profile }
			sessions.set(provider, session)
			return session
		}),
		cancel: vi.fn(() => true),
		fetchIdentity: async () => options.identity ?? { status: "valid", email: "a@b.c" },
		providerLabel: () => "Gemini",
	})
	return { useCase, store, sessions }
}

const webLoginRow = (id: string, email?: string | null) => ({
	id,
	email,
	updatedAt: "2026-01-01T00:00:00Z",
	providerSpecificData: { authMethod: "web-login" },
})

describe("available", () => {
	it("lists the providers whose login page can be driven", () => {
		const { useCase } = harness()
		expect(useCase.available()).toEqual({ providers: ["gemini-web"], profiles: ["default"] })
	})
})

describe("begin", () => {
	it("starts a session and answers 202-shaped data", async () => {
		const { useCase } = harness()
		const result = await useCase.begin({ provider: "gemini-web" })
		expect(result).toEqual({ provider: "gemini-web", profile: "default", status: "pending" })
	})

	it("refuses a provider whose login page cannot be driven", async () => {
		const { useCase } = harness({ config: null })
		await expect(useCase.begin({ provider: "nope" })).rejects.toThrow(
			'Web login not supported for "nope"',
		)
	})

	it("defaults the profile name", async () => {
		const { useCase } = harness()
		const result = await useCase.begin({ provider: " gemini-web ", profile: "  " })
		expect(result.provider).toBe("gemini-web")
		expect(result.profile).toBe("default")
	})
})

describe("abandon", () => {
	it("cancels a session", () => {
		const { useCase } = harness()
		expect(useCase.abandon("gemini-web")).toEqual({ cancelled: true })
	})

	it("refuses a missing provider", () => {
		const { useCase } = harness()
		expect(() => useCase.abandon(null)).toThrow("provider is required")
	})
})

describe("status before the login finishes", () => {
	it("reports the session without touching the store", async () => {
		const { useCase, store } = harness({ session: { status: "pending" } })
		const status = await useCase.status("gemini-web")
		expect(status.status).toBe("pending")
		expect(store.list).not.toHaveBeenCalled()
		expect(store.create).not.toHaveBeenCalled()
	})

	it("404s when no session is in progress", async () => {
		const { useCase } = harness({ session: null })
		await expect(useCase.status("gemini-web")).rejects.toMatchObject({ code: "NOT_FOUND" })
	})

	it("never returns the credential, only a short preview", async () => {
		const { useCase } = harness({
			session: { status: "pending", credential: "abcdefghijklmnopqrstuvwxyz" },
		})
		const status = await useCase.status("gemini-web")
		expect(status.credentialPreview).toBe("abcdefghij…")
		expect(JSON.stringify(status)).not.toContain("klmnop")
	})
})

describe("saving on success", () => {
	it("creates a connection when none exists", async () => {
		const { useCase, store } = harness({
			session: { status: "success", credential: "cookie-value" },
		})
		const status = await useCase.status("gemini-web")

		expect(store.create).toHaveBeenCalledOnce()
		const fields = store.create.mock.calls[0][0]
		expect(fields).toMatchObject({
			provider: "gemini-web",
			authType: "cookie",
			name: "a@b.c",
			email: "a@b.c",
			apiKey: "cookie-value",
			isActive: true,
			// Harvested from a live session, so the credential is known good.
			testStatus: "active",
			allowOverwrite: false,
		})
		expect(status.connectionId).toBe("created-1")
	})

	it("drops the credential once it is persisted", async () => {
		const { useCase, sessions } = harness({
			session: { status: "success", credential: "cookie-value" },
		})
		await useCase.status("gemini-web")
		expect(sessions.get("gemini-web")?.credential).toBeUndefined()
	})

	it("saves only once, however many times the panel polls", async () => {
		const { useCase, store } = harness({
			session: { status: "success", credential: "cookie-value" },
		})
		await useCase.status("gemini-web")
		await useCase.status("gemini-web")
		expect(store.create).toHaveBeenCalledOnce()
	})

	it("refreshes the existing row for the same account", async () => {
		const { useCase, store } = harness({
			rows: [webLoginRow("old", "a@b.c")],
			session: { status: "success", credential: "new-cookie" },
		})
		await useCase.status("gemini-web")
		expect(store.create).not.toHaveBeenCalled()
		expect(store.update).toHaveBeenCalledWith(
			"old",
			expect.objectContaining({ apiKey: "new-cookie" }),
		)
	})

	it("deletes a duplicate row for the same account", async () => {
		const { useCase, store } = harness({
			rows: [webLoginRow("keep", "a@b.c"), webLoginRow("dup", "a@b.c")],
			session: { status: "success", credential: "c" },
		})
		await useCase.status("gemini-web")
		expect(store.remove).toHaveBeenCalledWith("dup")
		expect(store.remove).not.toHaveBeenCalledWith("keep")
	})

	it("keeps a second account's row untouched", async () => {
		const { useCase, store } = harness({
			rows: [webLoginRow("one", "one@x.com"), webLoginRow("two", "two@x.com")],
			session: { status: "success", credential: "c" },
		})
		await useCase.status("gemini-web")
		expect(store.remove).not.toHaveBeenCalled()
	})

	it("records localStorage as the token source when the config says so", async () => {
		const { useCase, store } = harness({
			config: { credentialFrom: "localStorageValue" },
			session: { status: "success", credential: "c" },
		})
		await useCase.status("gemini-web")
		const fields = store.create.mock.calls[0][0]
		expect(fields.providerSpecificData).toEqual({
			authMethod: "web-login",
			tokenSource: "localStorage",
		})
	})
})

describe("failures report a message rather than throwing", () => {
	it("marks the session failed when the identity probe rejects it", async () => {
		const { useCase, store } = harness({
			session: { status: "success", credential: "c" },
			identity: { status: "invalid", error: "probe said no" },
		})
		const status = await useCase.status("gemini-web")
		expect(status.status).toBe("error")
		expect(status.error).toBe("probe said no")
		expect(store.create).not.toHaveBeenCalled()
	})

	it("names the taken connection on a name conflict", async () => {
		const { useCase } = harness({
			session: { status: "success", credential: "c" },
			createError: { code: "PROVIDER_NAME_CONFLICT", existingName: "work" },
		})
		const status = await useCase.status("gemini-web")
		expect(status.status).toBe("error")
		expect(status.error).toContain('"work"')
	})

	it("reports a missing credential instead of saving an empty one", async () => {
		const { useCase, store } = harness({ session: { status: "success", credential: null } })
		const status = await useCase.status("gemini-web")
		expect(status.status).toBe("error")
		expect(status.error).toMatch(/No credential/)
		expect(store.create).not.toHaveBeenCalled()
	})
})
