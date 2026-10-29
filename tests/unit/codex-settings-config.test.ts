import { parseTOML } from "confbox"
import { describe, expect, it } from "vitest"
import { codexSettingsConfig } from "../../apps/web/src/lib/cliToolHosts.ts"

/**
 * The two Codex rules that decide whether the generated config works: a custom provider
 * authenticates from a static header rather than `auth.json`, and the dotted TOML tables have
 * to survive a parse/write round-trip or Codex reads a different structure than it wrote.
 */

describe("codexSettingsConfig", () => {
	const write = (
		existing: Record<string, unknown>,
		input: { baseUrl: string; apiKey: string; model: string },
	) => codexSettingsConfig.apply(existing, input)

	it("carries the key as a static Authorization header", () => {
		// A custom provider ignores auth.json, so a key written there authenticates nothing.
		const written = write({}, { baseUrl: "http://x/v1", apiKey: "sk-1", model: "gpt-5" })
		const providers = written.model_providers as Record<string, Record<string, unknown>>
		expect(providers["9router"]).toMatchObject({
			base_url: "http://x/v1",
			wire_api: "responses",
			http_headers: { Authorization: "Bearer sk-1" },
		})
	})

	it("names the provider and the default subagent model", () => {
		const written = write({}, { baseUrl: "http://x/v1", apiKey: "sk-1", model: "gpt-5" })
		expect(written.model_provider).toBe("9router")
		expect(written.model).toBe("gpt-5")
		expect((written.agents as Record<string, unknown>).default_subagent_model).toBe("gpt-5")
	})

	it("drops the legacy subagent role that now means a custom agent", () => {
		const written = write(
			{ agents: { subagent: { model: "old" } } },
			{ baseUrl: "http://x/v1", apiKey: "sk-1", model: "gpt-5" },
		)
		expect((written.agents as Record<string, unknown>).subagent).toBeUndefined()
	})

	it("writes tables back as dotted keys, not as nested sections", () => {
		// The bug this guards: `[model_providers.9router]` written as a nested table becomes
		// `[model_providers]` with a sub-table, which Codex parses into a different shape.
		const written = write({}, { baseUrl: "http://x/v1", apiKey: "sk-1", model: "gpt-5" })
		const text = codexSettingsConfig.serialise?.(written) ?? ""
		expect(text).toContain("[model_providers.9router]")

		// And the round-trip keeps the entry reachable at the nested path the reader uses.
		const reparsed = parseTOML(text) as { model_providers?: Record<string, unknown> }
		expect(reparsed.model_providers?.["9router"]).toBeDefined()
		expect(codexSettingsConfig.storedBaseUrl(reparsed)).toBe("http://x/v1")
	})

	it("keeps settings this screen does not own", () => {
		const written = write(
			{ approval_policy: "never", model_providers: { other: { base_url: "http://other" } } },
			{ baseUrl: "http://x/v1", apiKey: "sk-1", model: "gpt-5" },
		)
		expect(written.approval_policy).toBe("never")
		expect((written.model_providers as Record<string, unknown>).other).toEqual({
			base_url: "http://other",
		})
	})

	it("survives a TOML round-trip without losing the header", () => {
		const written = write({}, { baseUrl: "http://x/v1", apiKey: "sk-1", model: "gpt-5" })
		const text = codexSettingsConfig.serialise?.(written) ?? ""
		const reparsed = parseTOML(text) as {
			model_providers?: Record<string, { http_headers?: Record<string, string> }>
		}
		expect(reparsed.model_providers?.["9router"]?.http_headers?.Authorization).toBe("Bearer sk-1")
	})

	it("answers no base URL for a config with no provider", () => {
		expect(codexSettingsConfig.storedBaseUrl({})).toBeNull()
	})
})
