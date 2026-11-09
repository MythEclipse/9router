// REAL: Command Code live upstream calls.
//
// Exercises the two things the offline unit tests cannot prove: that the identity
// headers + envelope this repo builds are accepted by /alpha/generate, and that a
// multi-turn tool conversation whose role:"tool" turn omits the tool name (what
// Claude Code and the OpenAI SDK actually send) no longer crashes the data path.
//
// Skips itself when there is no key, so a plain suite run never reaches the network.
// Supply one with COMMANDCODE_API_KEY, or by running `commandcode login` first —
// auto-import reads the same file.
//
//   RUN_REAL=1 bunx vitest run --config tests/vitest.config.ts tests/translator/real/commandcode.real.test.ts
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CommandCodeExecutor } from "../../../apps/web/open-sse/executors/commandcode.ts"
import { openaiToCommandCodeRequest } from "../../../apps/web/open-sse/translator/request/openai-to-commandcode.ts"

/** The key, from the environment or from the CLI's own auth file. */
function apiKey(): string | null {
	const fromEnv = process.env.COMMANDCODE_API_KEY
	if (fromEnv) return fromEnv
	const authPath = join(homedir(), ".commandcode", "auth.json")
	if (!existsSync(authPath)) return null
	try {
		const parsed = JSON.parse(readFileSync(authPath, "utf8")) as { apiKey?: unknown }
		return typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? parsed.apiKey.trim() : null
	} catch {
		return null
	}
}

const KEY = apiKey()
const MODEL = process.env.COMMANDCODE_MODEL || "deepseek/deepseek-v4-flash"

/**
 * TokenRecorder-free SSE drain: the upstream answers NDJSON/SSE, and all the cases
 * below need is the accumulated text to prove a real completion came back.
 */
async function drain(response: Response): Promise<string> {
	if (!response.body) return ""
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let out = ""
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		out += decoder.decode(value, { stream: true })
		if (out.includes("[DONE]")) break
	}
	return out
}

describe.skipIf(!KEY)("CommandCode live upstream", () => {
	it("authenticates and completes a plain turn", async () => {
		const body = openaiToCommandCodeRequest(
			MODEL,
			{ messages: [{ role: "user", content: "Say 'halo' and nothing else." }], max_tokens: 30 },
			true,
			{ _clientSessionId: "live-basic-session" },
		)

		const result = await new CommandCodeExecutor().execute({
			model: MODEL,
			body,
			credentials: { apiKey: KEY },
			stream: true,
		})

		expect(result.response.status).toBe(200)
		const text = await drain(result.response)
		expect(text.length).toBeGreaterThan(0)
	}, 60_000)

	it("survives a tool turn that omits the tool name", async () => {
		const body = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{ role: "user", content: "What is the time?" },
					{
						role: "assistant",
						content: "Let me check.",
						tool_calls: [
							{
								id: "call_time_1",
								type: "function",
								function: { name: "get_time", arguments: "{}" },
							},
						],
					},
					// No name property - exactly what Claude Code and the OpenAI SDK send.
					{ role: "tool", tool_call_id: "call_time_1", content: "12:00 PM" },
				],
				max_tokens: 30,
			},
			true,
			{ _clientSessionId: "live-tool-session" },
		)

		// The name the client dropped is recovered from the assistant turn.
		expect((body.params.messages[2].content as unknown[])[0]).toMatchObject({
			type: "tool-result",
			toolName: "get_time",
		})

		const result = await new CommandCodeExecutor().execute({
			model: MODEL,
			body,
			credentials: { apiKey: KEY },
			stream: true,
		})

		expect(result.response.status).toBe(200)
		const text = await drain(result.response)
		expect(text.length).toBeGreaterThan(0)
	}, 60_000)
})
