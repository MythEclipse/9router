import { describe, expect, it } from "vitest"
import {
	anthropicModelsBaseUrl,
	modelsEndpoint,
	modelsTokenOf,
	readModelList,
	resolverModels,
	resolverWarning,
	shouldRefreshOn,
	trimTrailingSlash,
} from "../../apps/api/src/domain/model-list.ts"

describe("modelsEndpoint", () => {
	it("appends /models to a bare base URL", () => {
		expect(modelsEndpoint("https://api.example.com/v1")).toBe("https://api.example.com/v1/models")
	})

	it("does not double the slash when the base URL ends in one", () => {
		expect(modelsEndpoint("https://api.example.com/v1/")).toBe("https://api.example.com/v1/models")
	})

	it("collapses several trailing slashes", () => {
		expect(trimTrailingSlash("https://api.example.com/v1///")).toBe("https://api.example.com/v1")
	})
})

describe("anthropicModelsBaseUrl", () => {
	it("leaves a version root alone", () => {
		expect(anthropicModelsBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1")
	})

	it("strips the full message endpoint back to the version root", () => {
		expect(anthropicModelsBaseUrl("https://api.example.com/v1/messages")).toBe(
			"https://api.example.com/v1",
		)
	})

	it("strips the message endpoint even with a trailing slash", () => {
		expect(anthropicModelsBaseUrl("https://api.example.com/v1/messages/")).toBe(
			"https://api.example.com/v1",
		)
	})

	it("only strips a whole trailing segment, not a mid-path match", () => {
		expect(anthropicModelsBaseUrl("https://api.example.com/messages-proxy/v1")).toBe(
			"https://api.example.com/messages-proxy/v1",
		)
	})

	it("leaves the version in place so /models lands beside it", () => {
		const base = anthropicModelsBaseUrl("https://api.example.com/v1/messages")
		expect(modelsEndpoint(base)).toBe("https://api.example.com/v1/models")
	})
})

describe("readModelList", () => {
	it("reads OpenAI's data array", () => {
		expect(readModelList({ data: [{ id: "gpt" }] })).toEqual([{ id: "gpt" }])
	})

	it("reads Gemini's models array", () => {
		expect(readModelList({ models: [{ name: "gemini" }] })).toEqual([{ name: "gemini" }])
	})

	it("prefers data when both are present", () => {
		expect(readModelList({ data: [1], models: [2] })).toEqual([1])
	})

	it("answers an empty list rather than an error for an empty answer", () => {
		expect(readModelList({})).toEqual([])
		expect(readModelList({ data: [] })).toEqual([])
	})

	it("answers an empty list for a non-object answer", () => {
		expect(readModelList(null)).toEqual([])
		expect(readModelList("nope")).toEqual([])
		expect(readModelList([1, 2])).toEqual([])
	})

	it("does not treat a non-array data field as a list", () => {
		expect(readModelList({ data: "gpt" })).toEqual([])
	})
})

describe("modelsTokenOf", () => {
	it("prefers the copilot token over everything else", () => {
		expect(
			modelsTokenOf({
				providerSpecificData: { copilotToken: "copilot" },
				accessToken: "access",
				apiKey: "key",
			}),
		).toBe("copilot")
	})

	it("falls back to the access token", () => {
		expect(modelsTokenOf({ accessToken: "access", apiKey: "key" })).toBe("access")
	})

	it("falls back to the API key", () => {
		expect(modelsTokenOf({ apiKey: "key" })).toBe("key")
	})

	it("ignores an empty copilot token rather than answering it", () => {
		expect(modelsTokenOf({ providerSpecificData: { copilotToken: "" }, apiKey: "key" })).toBe("key")
	})

	it("answers null when there is no credential at all", () => {
		expect(modelsTokenOf({})).toBeNull()
		expect(modelsTokenOf({ providerSpecificData: {} })).toBeNull()
	})
})

describe("shouldRefreshOn", () => {
	it("argues with 401 and 403", () => {
		expect(shouldRefreshOn(401, true)).toBe(true)
		expect(shouldRefreshOn(403, true)).toBe(true)
	})

	it("does not retry without a refresh token", () => {
		expect(shouldRefreshOn(401, false)).toBe(false)
		expect(shouldRefreshOn(403, false)).toBe(false)
	})

	it("does not retry statuses a new token cannot change", () => {
		expect(shouldRefreshOn(400, true)).toBe(false)
		expect(shouldRefreshOn(404, true)).toBe(false)
		expect(shouldRefreshOn(429, true)).toBe(false)
		expect(shouldRefreshOn(500, true)).toBe(false)
	})
})

describe("resolverModels", () => {
	it("carries no warning when there is none", () => {
		expect(resolverModels([1])).toEqual({ kind: "models", models: [1] })
	})

	it("keeps the warning so the fallback is visible", () => {
		expect(resolverModels([], "boom")).toEqual({
			kind: "models",
			models: [],
			warning: "boom",
		})
	})
})

describe("resolverWarning", () => {
	it("names the label before the detail", () => {
		expect(resolverWarning("Codex models", "401 Unauthorized")).toBe("Codex models: 401 Unauthorized")
	})
})
