import { describe, expect, it } from "vitest"
import { copilotSettingsConfig } from "../../apps/web/src/lib/cliToolHosts.ts"

/**
 * Copilot reads VS Code's `chatLanguageModels.json`, where the fragment on the model URL decides
 * how the request is authenticated. Losing it authenticates wrongly and looks like a key error.
 */

describe("copilotSettingsConfig", () => {
	const write = (existing: Record<string, unknown>, models: string[], baseUrl = "http://x/v1") =>
		copilotSettingsConfig.apply(existing, {
			baseUrl,
			apiKey: "sk-1",
			model: models[0] ?? "",
			models,
		})

	it("marks the entry as an azure vendor, or VS Code offers nothing", () => {
		const written = write({ entries: [] }, ["gpt-5"], "http://x/v1")
		const entries = written.entries as Array<Record<string, unknown>>
		expect(entries[0]).toMatchObject({ name: "9Router", vendor: "azure", apiKey: "sk-1" })
	})

	it("keeps the azure fragment on every model URL", () => {
		const written = write({ entries: [] }, ["gpt-5"], "http://x/v1")
		const entries = written.entries as Array<{ models: Array<{ url: string }> }>
		expect(entries[0]?.models[0]?.url).toBe("http://x/v1/chat/completions#models.ai.azure.com")
	})

	it("keeps entries other people added to the same array", () => {
		// The file belongs to VS Code; a save replaces our entry and nothing else.
		const written = write({ entries: [{ name: "Ollama", vendor: "openai" }] }, ["gpt-5"])
		const entries = written.entries as Array<{ name: string }>
		expect(entries.map((e) => e.name)).toEqual(["Ollama", "9Router"])
	})

	it("replaces our own entry rather than appending a second one", () => {
		const written = write({ entries: [{ name: "9Router", vendor: "azure", apiKey: "old" }] }, [
			"gpt-5",
		])
		const entries = written.entries as Array<{ name: string; apiKey: string }>
		expect(entries).toHaveLength(1)
		expect(entries[0]?.apiKey).toBe("sk-1")
	})

	it("answers the base URL without the endpoint path or fragment", () => {
		// The screen shows a base URL; the file stores a full endpoint.
		const stored = {
			entries: [
				{
					name: "9Router",
					models: [{ url: "http://x/v1/chat/completions#models.ai.azure.com" }],
				},
			],
		}
		expect(copilotSettingsConfig.storedBaseUrl(stored)).toBe("http://x/v1")
	})

	it("answers null when no entry of ours exists", () => {
		expect(copilotSettingsConfig.storedBaseUrl({ entries: [{ name: "Ollama" }] })).toBeNull()
	})
})
