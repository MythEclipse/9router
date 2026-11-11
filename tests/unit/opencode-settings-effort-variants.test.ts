// opencode "variants" are the effort levels 9Router itself offers for a model,
// so the CLI's picker matches the dashboard's. A save must generate them when
// they are absent and leave a user's own edits alone.
//
// Ported from tests/unit/opencode-settings-effort-variants.test.js (upstream
// 54a88d04). The upstream suite drove `POST /api/cli-tools/opencode-settings`;
// that route now delegates to the shared write-settings use-case, so the port
// drives the same use-case with the real opencode host (config port + apply).
import { describe, expect, it, vi } from "vitest"
import { getThinkingLevels } from "../../apps/web/open-sse/providers/thinkingLevels.js"

const fsMock = vi.hoisted(() => ({
	store: null as string | null,
	readFile: vi.fn(async () => {
		if (fsMock.store === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
		return fsMock.store
	}),
	writeFile: vi.fn(async (_p, content) => {
		fsMock.store = content
	}),
	mkdir: vi.fn(async () => {}),
	access: vi.fn(async () => {}),
}))

vi.mock("node:fs/promises", () => ({ default: fsMock, ...fsMock }))
vi.mock("@/app/api/cli-tools/resolveApiKey", () => ({
	resolveCliApiKey: vi.fn(async () => "test-key"),
}))

const { openCodeSettingsConfig } = await import(
	"../../apps/web/src/lib/cliToolHosts/opencodeDroid.js"
)
const { writeToolSettings } = await import(
	"../../apps/api/src/application/cli-tools/manage-tool-settings.js"
)

const post = (body) =>
	writeToolSettings(body, {
		isInstalled: async () => true,
		config: openCodeSettingsConfig,
		notInstalledMessage: "not installed",
		appliedMessage: "applied",
		resetMessage: "reset",
	})
const written = () => JSON.parse(fsMock.store as string).provider["9router"].models

describe("opencode-settings POST effort variants", () => {
	it("writes variants from the levels 9Router offers for the model", async () => {
		fsMock.store = null
		await post({ baseUrl: "http://localhost:20128", models: ["cc/claude-haiku-5-5"] })
		const levels = getThinkingLevels("claude", "claude-haiku-5-5")
		expect(Object.keys(written()["cc/claude-haiku-5-5"].variants)).toEqual(levels)
		expect(written()["cc/claude-haiku-5-5"].variants.high).toEqual({ reasoningEffort: "high" })
	})

	it("keeps variants the user already customized", async () => {
		const custom = { low: { reasoningEffort: "low" } }
		fsMock.store = JSON.stringify({
			provider: {
				"9router": {
					npm: "@ai-sdk/openai-compatible",
					options: {},
					models: { "cc/claude-haiku-5-5": { name: "x", variants: custom } },
				},
			},
		})
		await post({ baseUrl: "http://localhost:20128", models: ["cc/claude-haiku-5-5"] })
		expect(written()["cc/claude-haiku-5-5"].variants).toEqual(custom)
	})
})
