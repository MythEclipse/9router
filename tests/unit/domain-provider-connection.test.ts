import { describe, expect, it } from "vitest"
import {
	applyProxyConfig,
	applyProxyPoolChoice,
	applyWriteOnlySecret,
	chooseConnectionName,
	defaultConnectionName,
	nextKeyOrdinal,
	readProxyConfig,
	readProxyPoolChoice,
	readWriteOnlySecret,
} from "../../apps/api/src/domain/provider-connection.ts"

describe("readProxyConfig", () => {
	it("reports absent when the body mentions no proxy field", () => {
		expect(readProxyConfig({})).toEqual({ kind: "absent" })
		expect(readProxyConfig({ name: "x", apiKey: "k" })).toEqual({ kind: "absent" })
	})

	it("reports absent for a missing body", () => {
		expect(readProxyConfig(undefined)).toEqual({ kind: "absent" })
	})

	it("reads a complete set", () => {
		expect(
			readProxyConfig({
				connectionProxyEnabled: true,
				connectionProxyUrl: " http://proxy:8080 ",
				connectionNoProxy: " localhost ",
			}),
		).toEqual({ kind: "set", enabled: true, url: "http://proxy:8080", noProxy: "localhost" })
	})

	it("treats a present but non-boolean enabled as off", () => {
		const config = readProxyConfig({ connectionProxyEnabled: "yes", connectionProxyUrl: "http://p" })
		expect(config).toEqual({ kind: "set", enabled: false, url: "http://p", noProxy: "" })
	})

	it("refuses enabling without a URL", () => {
		expect(readProxyConfig({ connectionProxyEnabled: true })).toEqual({
			kind: "invalid",
			message: "Connection proxy URL is required when connection proxy is enabled",
		})
	})

	it("refuses enabling with a whitespace-only URL", () => {
		expect(readProxyConfig({ connectionProxyEnabled: true, connectionProxyUrl: "   " }).kind).toBe(
			"invalid",
		)
	})

	it("allows a URL with the proxy disabled", () => {
		expect(
			readProxyConfig({ connectionProxyEnabled: false, connectionProxyUrl: "http://p" }),
		).toEqual({ kind: "set", enabled: false, url: "http://p", noProxy: "" })
	})

	it("counts a lone noProxy as a proxy statement", () => {
		expect(readProxyConfig({ connectionNoProxy: "localhost" }).kind).toBe("set")
	})
})

describe("applyProxyConfig", () => {
	it("leaves stored fields untouched when the caller said nothing", () => {
		const stored = { connectionProxyEnabled: true, connectionProxyUrl: "http://old" }
		expect(applyProxyConfig(stored, { kind: "absent" })).toEqual(stored)
	})

	it("leaves stored fields untouched when the config is invalid", () => {
		const stored = { connectionProxyEnabled: true, connectionProxyUrl: "http://old" }
		expect(applyProxyConfig(stored, { kind: "invalid", message: "x" })).toEqual(stored)
	})

	it("writes all three fields when the caller stated them", () => {
		expect(
			applyProxyConfig(
				{ keep: 1, connectionProxyUrl: "http://old" },
				{ kind: "set", enabled: false, url: "", noProxy: "" },
			),
		).toEqual({
			keep: 1,
			connectionProxyEnabled: false,
			connectionProxyUrl: "",
			connectionNoProxy: "",
		})
	})

	it("starts from an empty object when nothing is stored", () => {
		expect(
			applyProxyConfig(null, { kind: "set", enabled: true, url: "http://p", noProxy: "" }),
		).toEqual({ connectionProxyEnabled: true, connectionProxyUrl: "http://p", connectionNoProxy: "" })
	})

	it("does not mutate the stored object", () => {
		const stored = { keep: 1 }
		applyProxyConfig(stored, { kind: "set", enabled: true, url: "http://p", noProxy: "" })
		expect(stored).toEqual({ keep: 1 })
	})
})

describe("readProxyPoolChoice", () => {
	it("reports absent for undefined", () => {
		expect(readProxyPoolChoice(undefined)).toEqual({ kind: "absent" })
	})

	it.each([null, "", "   ", "__none__"])("reports cleared for %j", (value) => {
		expect(readProxyPoolChoice(value)).toEqual({ kind: "cleared" })
	})

	it("trims a real id", () => {
		expect(readProxyPoolChoice("  pool-1 ")).toEqual({ kind: "set", proxyPoolId: "pool-1" })
	})

	it("keeps a numeric id as a string", () => {
		expect(readProxyPoolChoice(7)).toEqual({ kind: "set", proxyPoolId: "7" })
	})
})

describe("applyProxyPoolChoice", () => {
	it("leaves the stored pool when the caller said nothing", () => {
		expect(applyProxyPoolChoice({ proxyPoolId: "old" }, { kind: "absent" })).toEqual({
			proxyPoolId: "old",
		})
	})

	it("removes the key when cleared, rather than storing null", () => {
		const result = applyProxyPoolChoice({ proxyPoolId: "old", keep: 1 }, { kind: "cleared" })
		expect(result).toEqual({ keep: 1 })
		expect("proxyPoolId" in result).toBe(false)
	})

	it("writes the new id", () => {
		expect(applyProxyPoolChoice({ keep: 1 }, { kind: "set", proxyPoolId: "new" })).toEqual({
			keep: 1,
			proxyPoolId: "new",
		})
	})
})

describe("nextKeyOrdinal", () => {
	it("starts at 1 when the provider has no keys", () => {
		expect(nextKeyOrdinal([])).toBe(1)
	})

	it("takes the first free ordinal", () => {
		expect(nextKeyOrdinal([{ name: "Gemini #1" }, { name: "Gemini #3" }])).toBe(2)
	})

	it("skips past a contiguous run", () => {
		expect(nextKeyOrdinal([{ name: "G #1" }, { name: "G #2" }])).toBe(3)
	})

	it("reuses the ordinal of a key that is already stored", () => {
		const existing = [{ name: "Gemini #4", apiKey: "same" }, { name: "Gemini #1" }]
		expect(nextKeyOrdinal(existing, "same")).toBe(4)
	})

	it("ignores a same-key row whose name carries no ordinal", () => {
		expect(nextKeyOrdinal([{ name: "custom name", apiKey: "same" }], "same")).toBe(1)
	})

	it("ignores names without an ordinal", () => {
		expect(nextKeyOrdinal([{ name: "My key" }, { name: null }])).toBe(1)
	})

	it("ignores a zero or non-integer ordinal", () => {
		expect(nextKeyOrdinal([{ name: "G #0" }, { name: "G #x" }])).toBe(1)
	})

	it("treats a row with no apiKey as different from the caller's key", () => {
		expect(nextKeyOrdinal([{ name: "G #1" }], "")).toBe(2)
	})
})

describe("chooseConnectionName", () => {
	const base = { providerLabel: "Gemini", ordinal: 2 }

	it("prefers an explicit name", () => {
		expect(chooseConnectionName({ ...base, name: " work ", displayName: "shown" })).toBe("work")
	})

	it("falls back to the display name", () => {
		expect(chooseConnectionName({ ...base, displayName: " shown " })).toBe("shown")
	})

	it("treats a blank explicit name as absent", () => {
		expect(chooseConnectionName({ ...base, name: "   ", displayName: "shown" })).toBe("shown")
	})

	it("generates the ordinal name when nothing is given", () => {
		expect(chooseConnectionName(base)).toBe("Gemini #2")
	})

	it("treats a non-string name as absent", () => {
		expect(chooseConnectionName({ ...base, name: 42 })).toBe("Gemini #2")
	})
})

describe("defaultConnectionName", () => {
	it("formats provider and ordinal", () => {
		expect(defaultConnectionName("Gemini", 1)).toBe("Gemini #1")
	})
})

describe("readWriteOnlySecret", () => {
	it("reports absent when the field was not sent", () => {
		expect(readWriteOnlySecret(undefined)).toBe("absent")
	})

	it("reports cleared for an explicit null", () => {
		expect(readWriteOnlySecret(null)).toBe("cleared")
	})

	it("treats a blank string as absent, because the form cannot read the token back", () => {
		expect(readWriteOnlySecret("")).toBe("absent")
		expect(readWriteOnlySecret("   ")).toBe("absent")
	})

	it("carries a real value", () => {
		expect(readWriteOnlySecret("token")).toEqual({ value: "token" })
	})
})

describe("applyWriteOnlySecret", () => {
	const stored = { sessionToken: "saved", keep: 1 }

	it("leaves the stored token when the field was absent", () => {
		expect(applyWriteOnlySecret(stored, "sessionToken", "absent")).toEqual(stored)
	})

	it("removes the token when cleared", () => {
		const result = applyWriteOnlySecret(stored, "sessionToken", "cleared")
		expect(result).toEqual({ keep: 1 })
		expect("sessionToken" in result).toBe(false)
	})

	it("writes a new token", () => {
		expect(applyWriteOnlySecret(stored, "sessionToken", { value: "new" })).toEqual({
			sessionToken: "new",
			keep: 1,
		})
	})

	it("does not mutate the input", () => {
		applyWriteOnlySecret(stored, "sessionToken", "cleared")
		expect(stored).toEqual({ sessionToken: "saved", keep: 1 })
	})
})
