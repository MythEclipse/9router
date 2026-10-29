import { describe, expect, it } from "vitest"

import {
	ANTHROPIC_COMPATIBLE,
	CUSTOM_EMBEDDING,
	DEFAULT_QUOTA_PATH,
	findDuplicate,
	OPENAI_COMPATIBLE,
	sanitizeBaseUrl,
	sanitizeQuotaPath,
	validateApiType,
	validateNodeFields,
} from "../../apps/api/src/domain/provider-node.ts"

describe("sanitizeBaseUrl", () => {
	it("strips a trailing slash for every type", () => {
		// Create only did this for openai-compatible, so `https://x/v1/` was stored
		// with the slash for the other two types and dialled as `.../v1//models`.
		for (const type of [OPENAI_COMPATIBLE, ANTHROPIC_COMPATIBLE, CUSTOM_EMBEDDING]) {
			expect(sanitizeBaseUrl(type, "https://api.example.com/v1/")).toBe("https://api.example.com/v1")
		}
	})

	it("drops a pasted /messages from an anthropic base URL", () => {
		// The router appends /messages itself; keeping it dials /messages/messages.
		expect(sanitizeBaseUrl(ANTHROPIC_COMPATIBLE, "https://api.anthropic.com/v1/messages")).toBe(
			"https://api.anthropic.com/v1",
		)
	})

	it("drops a pasted /embeddings from an embedding base URL", () => {
		expect(sanitizeBaseUrl(CUSTOM_EMBEDDING, "https://api.openai.com/v1/embeddings")).toBe(
			"https://api.openai.com/v1",
		)
	})

	it("leaves a /messages on a non-anthropic type alone", () => {
		// Only the anthropic router appends that suffix; stripping it elsewhere
		// would break a gateway that genuinely lives under /messages.
		expect(sanitizeBaseUrl(OPENAI_COMPATIBLE, "https://x/v1/messages")).toBe("https://x/v1/messages")
	})

	it("falls back to the type default when absent or blank", () => {
		expect(sanitizeBaseUrl(OPENAI_COMPATIBLE, null)).toBe("https://api.openai.com/v1")
		expect(sanitizeBaseUrl(ANTHROPIC_COMPATIBLE, "   ")).toBe("https://api.anthropic.com/v1")
	})

	it("trims surrounding whitespace", () => {
		expect(sanitizeBaseUrl(OPENAI_COMPATIBLE, "  https://x/v1  ")).toBe("https://x/v1")
	})
})

describe("sanitizeQuotaPath", () => {
	it("defaults to /credits", () => {
		expect(sanitizeQuotaPath(undefined)).toBe(DEFAULT_QUOTA_PATH)
		expect(sanitizeQuotaPath("")).toBe(DEFAULT_QUOTA_PATH)
		expect(sanitizeQuotaPath("   ")).toBe(DEFAULT_QUOTA_PATH)
	})

	it("adds the leading slash a bare path needs", () => {
		expect(sanitizeQuotaPath("credits")).toBe("/credits")
		expect(sanitizeQuotaPath("v1/usage")).toBe("/v1/usage")
	})

	it("keeps an absolute URL as given", () => {
		// Some nodes serve credits from another host, so rewriting it breaks them.
		expect(sanitizeQuotaPath("https://billing.example.com/credits")).toBe(
			"https://billing.example.com/credits",
		)
	})

	it("keeps a path that already starts with a slash", () => {
		expect(sanitizeQuotaPath("/quota/credits")).toBe("/quota/credits")
	})
})

describe("findDuplicate", () => {
	const nodes = [
		{ id: "n1", name: "Local Ollama", prefix: "ollama-local" },
		{ id: "n2", name: "Work Gateway", prefix: "work" },
	]

	it("refuses a prefix another node uses", () => {
		expect(findDuplicate(nodes, { name: "New", prefix: "work" })).toEqual({
			code: "CONFLICT",
			message: "A provider with this prefix already exists",
		})
	})

	it("refuses a name another node uses", () => {
		expect(findDuplicate(nodes, { name: "Local Ollama", prefix: "new" })).toEqual({
			code: "CONFLICT",
			message: "A provider with this name already exists",
		})
	})

	it("compares case-insensitively", () => {
		// `Work` and `work` render as two chips but route to one place.
		expect(findDuplicate(nodes, { name: "x", prefix: "WORK" })).not.toBeNull()
		expect(findDuplicate(nodes, { name: "LOCAL OLLAMA", prefix: "y" })).not.toBeNull()
	})

	it("lets a node keep its own name and prefix on update", () => {
		// This is the check update was missing entirely: without `exceptId`, every
		// save of an unchanged node reported a conflict with itself.
		expect(findDuplicate(nodes, { name: "Work Gateway", prefix: "work", exceptId: "n2" })).toBeNull()
	})

	it("still refuses a genuine clash on update", () => {
		expect(findDuplicate(nodes, { name: "x", prefix: "work", exceptId: "n1" })).not.toBeNull()
	})

	it("accepts a fresh name and prefix", () => {
		expect(findDuplicate(nodes, { name: "Fresh", prefix: "fresh" })).toBeNull()
	})

	it("accepts anything when nothing exists yet", () => {
		expect(findDuplicate([], { name: "a", prefix: "a" })).toBeNull()
	})
})

describe("validateNodeFields", () => {
	it("requires a non-blank name", () => {
		expect(validateNodeFields({ name: "", prefix: "p" })?.message).toBe("Name is required")
		expect(validateNodeFields({ name: "   ", prefix: "p" })?.message).toBe("Name is required")
		expect(validateNodeFields({ name: 42, prefix: "p" })?.message).toBe("Name is required")
	})

	it("requires a non-blank prefix", () => {
		expect(validateNodeFields({ name: "n", prefix: "" })?.message).toBe("Prefix is required")
		expect(validateNodeFields({ name: "n", prefix: null })?.message).toBe("Prefix is required")
	})

	it("accepts a complete pair", () => {
		expect(validateNodeFields({ name: "n", prefix: "p" })).toBeNull()
	})
})

describe("validateApiType", () => {
	it("refuses a missing or unknown apiType for an openai-compatible node", () => {
		expect(validateApiType(OPENAI_COMPATIBLE, undefined)?.code).toBe("VALIDATION")
		expect(validateApiType(OPENAI_COMPATIBLE, "completions")?.code).toBe("VALIDATION")
	})

	it("accepts chat and responses", () => {
		expect(validateApiType(OPENAI_COMPATIBLE, "chat")).toBeNull()
		expect(validateApiType(OPENAI_COMPATIBLE, "responses")).toBeNull()
	})

	it("ignores apiType for the other two types", () => {
		// An embedding node has no chat path, so the field is meaningless there and
		// must not be required.
		expect(validateApiType(CUSTOM_EMBEDDING, undefined)).toBeNull()
		expect(validateApiType(ANTHROPIC_COMPATIBLE, "nonsense")).toBeNull()
	})
})
