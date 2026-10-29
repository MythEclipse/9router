import { describe, expect, it, vi } from "vitest"
import {
	resetClaudeSettings,
	writeClaudeSettings,
} from "../../apps/api/src/application/claude-tools/manage-claude-settings.ts"
import {
	CLAUDE_MANAGED_ENV_KEYS,
	claudeBaseUrl,
	clearClaudeSettings,
	mergeClaudeSettings,
	readClaudeSettings,
} from "../../apps/api/src/domain/claude-settings.ts"

describe("claudeBaseUrl", () => {
	it("adds /v1 exactly once", () => {
		expect(claudeBaseUrl("http://localhost:20128")).toBe("http://localhost:20128/v1")
		expect(claudeBaseUrl("http://localhost:20128/v1")).toBe("http://localhost:20128/v1")
		expect(claudeBaseUrl("http://localhost:20128/")).toBe("http://localhost:20128/v1")
	})
})

describe("readClaudeSettings", () => {
	it("refuses a payload with no env object", () => {
		// The screen always sends one, so a body without it is a client bug, not an empty form.
		expect(readClaudeSettings({}).ok).toBe(false)
		expect(readClaudeSettings(null).ok).toBe(false)
	})

	it("keeps string values and drops anything else", () => {
		const read = readClaudeSettings({ env: { A: "a", B: 42, C: null } })
		expect(read.write?.env).toEqual({ A: "a" })
	})

	it("normalises the base URL the way Claude Code expects", () => {
		const read = readClaudeSettings({ env: { ANTHROPIC_BASE_URL: "http://localhost:20128" } })
		expect(read.write?.env.ANTHROPIC_BASE_URL).toBe("http://localhost:20128/v1")
	})
})

describe("mergeClaudeSettings", () => {
	it("keeps a token the file already had, so a stale field cannot clear it", () => {
		// Reset is how a token is cleared. A blank or stale value in the form must not be.
		const merged = mergeClaudeSettings(
			{ env: { ANTHROPIC_AUTH_TOKEN: "sk-real" } },
			{ env: { ANTHROPIC_AUTH_TOKEN: "sk-stale", ANTHROPIC_BASE_URL: "http://x/v1" } },
		)
		expect(merged.env).toMatchObject({
			ANTHROPIC_AUTH_TOKEN: "sk-real",
			ANTHROPIC_BASE_URL: "http://x/v1",
		})
	})

	it("marks onboarding complete, so a working config does not show a first-run wizard", () => {
		expect(mergeClaudeSettings({}, { env: {} }).hasCompletedOnboarding).toBe(true)
	})

	it("keeps env keys this screen does not own", () => {
		const merged = mergeClaudeSettings(
			{ env: { MY_OWN_KEY: "keep" } },
			{ env: { ANTHROPIC_BASE_URL: "http://x/v1" } },
		)
		expect(merged.env).toMatchObject({ MY_OWN_KEY: "keep" })
	})

	it("removes the auto-compact key when no window was chosen", () => {
		// Claude Code derives the window from the model when the key is absent; an empty value
		// reads as a window of zero and compaction never happens.
		for (const empty of [undefined, null, "", false]) {
			const merged = mergeClaudeSettings(
				{ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" } },
				{ env: {}, autoCompactWindow: empty },
			)
			expect((merged.env as Record<string, string>).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
		}
	})

	it("writes the chosen window as a string", () => {
		const merged = mergeClaudeSettings({}, { env: {}, autoCompactWindow: 120000 })
		expect((merged.env as Record<string, string>).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("120000")
	})
})

describe("clearClaudeSettings", () => {
	it("removes only the keys this screen owns", () => {
		const cleared = clearClaudeSettings({
			env: { ANTHROPIC_BASE_URL: "http://x/v1", MY_OWN_KEY: "keep" },
			hasCompletedOnboarding: true,
		})
		expect(cleared.env).toEqual({ MY_OWN_KEY: "keep" })
	})

	it("drops an env block that would otherwise be empty", () => {
		const cleared = clearClaudeSettings({ env: { ANTHROPIC_BASE_URL: "http://x/v1" } })
		expect("env" in cleared).toBe(false)
	})

	it("names every key it says it owns", () => {
		const env: Record<string, string> = {}
		for (const key of CLAUDE_MANAGED_ENV_KEYS) env[key] = "value"
		expect(clearClaudeSettings({ env }).env).toBeUndefined()
	})
})

describe("writeClaudeSettings and resetClaudeSettings", () => {
	const portWith = (stored: Record<string, unknown>) => ({
		read: vi.fn(async () => stored),
		readForWrite: vi.fn(async () => stored),
		write: vi.fn(async () => undefined),
		writeMcp: vi.fn(async () => undefined),
		notInstalledMessage: "not installed",
	})

	it("saves and reports success", async () => {
		const port = portWith({})
		const answer = await writeClaudeSettings({ env: { ANTHROPIC_BASE_URL: "http://x" } }, port)

		expect(answer.status).toBe(200)
		expect(port.write).toHaveBeenCalled()
	})

	it("still succeeds when the MCP file cannot be written, because the settings took", async () => {
		const port = portWith({})
		port.writeMcp.mockRejectedValueOnce(new Error("permission denied"))
		const answer = await writeClaudeSettings({ env: { ANTHROPIC_BASE_URL: "http://x" } }, port)

		expect(answer.status).toBe(200)
	})

	it("refuses a write it cannot parse instead of dropping the settings", async () => {
		const port = portWith({})
		port.readForWrite.mockRejectedValueOnce(new Error("Unexpected token"))
		const answer = await writeClaudeSettings({ env: { ANTHROPIC_BASE_URL: "http://x" } }, port)

		expect(answer.status).toBe(500)
		expect(port.write).not.toHaveBeenCalled()
	})

	it("resets by writing the cleared settings back", async () => {
		const port = portWith({ env: { ANTHROPIC_BASE_URL: "http://x/v1" } })
		const answer = await resetClaudeSettings(port)

		expect(answer.status).toBe(200)
		expect(port.write).toHaveBeenCalledWith({})
	})
})
