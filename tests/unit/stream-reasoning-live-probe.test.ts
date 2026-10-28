// Live probe: does a reasoning-only OpenAI-compatible stream survive 9router?
//
// Stands up a fake upstream that emits exactly what OpenCode/DeepSeek emit — a
// reasoning-only delta, no `content` at all — then drives 9router's own stream
// utility over it and checks that the reasoning text was both forwarded and
// accumulated. Before the fix the gate dropped every such chunk, so the client got
// an empty stream and the observability row said "[Empty streaming response]"
// despite 77 billed output tokens.
import http from "node:http"
import { it } from "vitest"
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js"

const UPSTREAM_PORT = 20991

function sse(chunks) {
	return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
}

const reasoningStream = sse([
	{
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta: { role: "assistant" } }],
	},
	{
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta: { reasoning: "step one: " } }],
	},
	{
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta: { reasoning: "step two." } }],
	},
	{
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 10, completion_tokens: 77, total_tokens: 87 },
	},
])

async function readAll(stream) {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let out = ""
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		out += decoder.decode(value, { stream: true })
	}
	return out
}

const server = http.createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/event-stream" })
	res.end(reasoningStream)
})

it("reasoning-only stream survives", async () => {
	await new Promise((resolve) => server.listen(UPSTREAM_PORT, "127.0.0.1", resolve))

	try {
		const upstream = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/v1/chat/completions`, {
			method: "POST",
			body: "{}",
		})

		let completed = null
		const transform = createPassthroughStreamWithLogger(
			"opencode",
			null,
			"deepseek-v4.1-flash-free",
			"probe",
			{ model: "deepseek-v4.1-flash-free", messages: [], stream: true },
			(contentObj, usage) => {
				completed = { contentObj, usage }
			},
			"sk-probe",
		)

		const out = await readAll(upstream.body.pipeThrough(transform))

		console.log("PROBE forwarded reasoning chunks:", /step one/.test(out) && /step two/.test(out))
		console.log("PROBE accumulated thinking:", JSON.stringify(completed?.contentObj?.thinking))
		console.log("PROBE accumulated content:", JSON.stringify(completed?.contentObj?.content))
		console.log("PROBE usage:", JSON.stringify(completed?.usage))

		const ok =
			/step one/.test(out) &&
			/step two/.test(out) &&
			completed?.contentObj?.thinking === "step one: step two." &&
			completed?.contentObj?.content === ""

		console.log(ok ? "PROBE RESULT: PASS" : "PROBE RESULT: FAIL")
		if (!ok) process.exitCode = 1
	} finally {
		server.close()
	}
})
