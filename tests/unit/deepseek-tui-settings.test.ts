import { describe, expect, it } from "vitest"
import {
	resetToolSettings,
	writeToolSettings,
} from "../../apps/api/src/application/cli-tools/manage-tool-settings.ts"

/**
 * DeepSeek TUI differs from every other tool in this batch: it owns its whole `config.toml`, so
 * a save replaces the file and a reset writes the tool's default. Both rules are asserted here
 * because either could quietly regress into the merge/delete behaviour of its neighbours.
 *
 * The port is rebuilt here rather than imported from the host, so the test states the contract
 * the host must satisfy instead of depending on where the host reads its paths from.
 */

function harness(initial: Record<string, unknown> | null) {
	let written = ""
	return {
		writtenText: () => written,
		deps: {
			isInstalled: async () => true,
			config: {
				path: "/home/u/.deepseek/config.toml",
				format: "toml" as const,
				read: async () => initial,
				readForWrite: async () => initial ?? {},
				write: async (text: string) => {
					written = text
				},
				baseUrlSuffix: "with-v1" as const,
				installKeys: ["9router"],
				// The reset value goes through the same serialiser as a save.
				resetTo: () => ({ toml: 'provider = "deepseek"\n' }),
				// `serialise` only ever sees the config, never the form — the host stashes the
				// rendered document in `apply` and hands it back here.
				serialise: (config: Record<string, unknown>) => String(config.toml ?? ""),
				apply: (
					_c: Record<string, unknown>,
					input: { baseUrl: string; apiKey: string; model: string },
				) => ({
					toml: [
						'provider = "openai"',
						"",
						"[providers.openai]",
						`base_url = "${input.baseUrl}"`,
						`api_key = "${input.apiKey}"`,
						`model = "${input.model}"`,
						"",
					].join("\n"),
				}),
			},
			notInstalledMessage: "not installed",
			appliedMessage: "applied",
			resetMessage: "reset",
		},
	}
}

describe("deepseek-tui save", () => {
	it("replaces the file instead of merging into it", async () => {
		const h = harness({ provider: "deepseek" })
		const answer = await writeToolSettings(
			{ baseUrl: "http://localhost:20128/v1", apiKey: "sk-1", model: "gpt-5" },
			h.deps,
		)
		expect(answer.status).toBe(200)
		// A merge would keep `provider = "deepseek"` and produce a file the tool cannot read.
		expect(h.writtenText()).toBe(
			[
				'provider = "openai"',
				"",
				"[providers.openai]",
				'base_url = "http://localhost:20128/v1"',
				'api_key = "sk-1"',
				'model = "gpt-5"',
				"",
			].join("\n"),
		)
	})

	it("requires a model, not just a base url", async () => {
		const h = harness({})
		const answer = await writeToolSettings({ baseUrl: "http://localhost:20128" }, h.deps)
		expect(answer.status).toBe(400)
		expect(h.writtenText()).toBe("")
	})
})

describe("deepseek-tui reset", () => {
	it("restores the tool's own default rather than deleting the file", async () => {
		const h = harness({ provider: "openai" })
		const answer = await resetToolSettings(h.deps)
		expect(answer.status).toBe(200)
		// An empty file is a tool that will not start, so the default has to be written back.
		expect(h.writtenText()).toContain('provider = "deepseek"')
	})
})
