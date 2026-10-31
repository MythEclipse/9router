/**
 * The config export, and the two properties that make it usable: no credential, stable bytes.
 *
 * An export is meant to be committed and pasted into issues. A single leaked `accessToken`
 * turns a convenience feature into an incident, and an unstable key order turns every diff
 * into noise. Both are asserted here rather than trusted.
 */

import { makeConfigExport } from "9router-api/application/settings/config-export"
import {
	CONFIG_EXPORT_VERSION,
	configDocument,
	configFilename,
	configJson,
	isSecretField,
	REDACTED,
	redactSecrets,
	SECRET_FIELD_NAMES,
} from "9router-api/domain/config-export"
import { describe, expect, it } from "vitest"

const NOW = new Date("2026-10-31T09:00:00.000Z")

describe("isSecretField", () => {
	it("matches whole names, case-insensitively", () => {
		expect(isSecretField("accessToken")).toBe(true)
		expect(isSecretField("ACCESSTOKEN")).toBe(true)
		expect(isSecretField("key")).toBe(true)
		expect(isSecretField("password")).toBe(true)
	})

	it("does not match a field that merely mentions a secret", () => {
		// `keyId` and `keyName` identify a key and belong in a diff; `key` is the credential.
		expect(isSecretField("keyId")).toBe(false)
		expect(isSecretField("keyName")).toBe(false)
		expect(isSecretField("tokenLimit")).toBe(false)
		expect(isSecretField("allowedModels")).toBe(false)
	})
})

describe("redactSecrets", () => {
	it("replaces a credential at any depth", () => {
		const redacted = redactSecrets({
			providers: [{ id: "c1", accessToken: "sk-live-123", meta: { refreshToken: "rt-9" } }],
		}) as { providers: Array<Record<string, unknown>> }

		expect(redacted.providers[0]?.accessToken).toBe(REDACTED)
		expect((redacted.providers[0]?.meta as Record<string, unknown>).refreshToken).toBe(REDACTED)
		expect(JSON.stringify(redacted)).not.toContain("sk-live-123")
		expect(JSON.stringify(redacted)).not.toContain("rt-9")
	})

	it("keeps identity fields that name a key", () => {
		const redacted = redactSecrets({ keyId: "k1", keyName: "laptop", key: "sk-1" }) as Record<
			string,
			unknown
		>

		expect(redacted.keyId).toBe("k1")
		expect(redacted.keyName).toBe("laptop")
		expect(redacted.key).toBe(REDACTED)
	})

	it("keeps array length and order, so a diff stays readable", () => {
		const redacted = redactSecrets([{ key: "a" }, { name: "second" }, { key: "c" }]) as Array<
			Record<string, unknown>
		>

		expect(redacted).toHaveLength(3)
		expect(redacted[1]?.name).toBe("second")
	})

	it("leaves a null credential null rather than claiming it was redacted", () => {
		// `null` means "this connection has no token", which is different from "we hid one".
		expect(redactSecrets({ accessToken: null })).toEqual({ accessToken: null })
	})

	it("covers every name on the list", () => {
		for (const name of SECRET_FIELD_NAMES) {
			expect(redactSecrets({ [name]: "secret-value" })).toEqual({ [name]: REDACTED })
		}
	})
})

describe("configDocument", () => {
	const sections = {
		providers: [{ provider: "openai", accessToken: "sk-x", name: "work" }],
		combos: [{ name: "main", models: ["openai/gpt-5"] }],
		keys: [{ id: "k1", name: "laptop", key: "sk-live", allowedModels: "*" }],
	}

	it("stamps the version and the export time", () => {
		const document = configDocument(sections, NOW)

		expect(document.version).toBe(CONFIG_EXPORT_VERSION)
		expect(document.exportedAt).toBe(NOW.toISOString())
	})

	it("carries no credential from any section", () => {
		const text = configJson(configDocument(sections, NOW))

		expect(text).not.toContain("sk-x")
		expect(text).not.toContain("sk-live")
		expect(text).toContain(REDACTED)
	})

	it("sorts keys at every level, so an unchanged install exports identical bytes", () => {
		const a = configJson(configDocument({ providers: [{ b: 2, a: 1 }], combos: [], keys: [] }, NOW))
		const b = configJson(configDocument({ providers: [{ a: 1, b: 2 }], combos: [], keys: [] }, NOW))

		expect(a).toBe(b)
		expect(a.indexOf('"a"')).toBeLessThan(a.indexOf('"b"'))
	})

	it("ends with a newline and indents by two, so the diff is line-based", () => {
		const text = configJson(configDocument(sections, NOW))

		expect(text.endsWith("\n")).toBe(true)
		expect(text).toContain('\n  "version"')
	})
})

describe("configFilename", () => {
	it("is dated, so two exports cannot collide", () => {
		expect(configFilename(NOW)).toBe("9router-config-2026-10-31.json")
	})
})

describe("makeConfigExport", () => {
	const sources = {
		providers: async () => [{ provider: "openai", accessToken: "sk-x" }],
		combos: async () => [{ name: "main" }],
		keys: async () => [{ id: "k1", key: "sk-live" }],
	}

	it("answers a downloadable document with the three sections", async () => {
		const answer = await makeConfigExport(sources).export()

		expect(answer.filename).toBe("9router-config-2026-10-31.json")
		expect(answer.contentType).toContain("application/json")
		const parsed = JSON.parse(answer.body) as { sections: Record<string, unknown[]> }
		expect(parsed.sections.providers).toHaveLength(1)
		expect(parsed.sections.combos).toHaveLength(1)
		expect(parsed.sections.keys).toHaveLength(1)
		expect(answer.body).not.toContain("sk-live")
	})

	it("refuses a missing source instead of exporting an empty section", async () => {
		// An export that silently has no providers reads exactly like an install with none.
		await expect(
			makeConfigExport({ ...sources, combos: undefined as never }).export(),
		).rejects.toMatchObject({ code: "INTERNAL" })
	})
})
