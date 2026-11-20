import { systemPromptText } from "../shared/cliAgentPrompt.ts"
import { composeSystemPrompt } from "../shared/nativeSystemPrompt.ts"
import { DefaultExecutor } from "./default.ts"

/**
 * CodeBuddyExecutor - talks to https://copilot.tencent.com/v2/chat/completions
 *
 * CodeBuddy is OpenAI-compatible but rejects non-stream chat requests
 * (HTTP 400, code 11101 "Non-stream chat request is currently not supported").
 * The same-format (openai→openai) translator path leaves body.stream as the
 * client sent it, so we force it true here - 9router still re-aggregates the
 * SSE into a JSON response for non-streaming clients.
 */
export class CodeBuddyExecutor extends DefaultExecutor {
	constructor() {
		super("codebuddy-cn")
	}

	transformRequest(model, body, stream, credentials) {
		const transformed = super.transformRequest(model, body, stream, credentials)
		transformed.stream = true

		// Tencent's filter rejects third-party CLI agent identities, so the system
		// prompt is rebuilt from CodeBuddy's own captured prompt. Whatever the client
		// actually asked for is appended after it rather than thrown away — the old
		// neutralise-the-whole-message rule deleted real user instructions that
		// happened to share the message with the identity line.
		if (Array.isArray(transformed.messages)) {
			const clientSystemText = transformed.messages
				.filter((m) => m && ["system", "developer"].includes(m.role))
				.map((m) => systemPromptText(m.content))
				.filter(Boolean)
				.join("\n\n")
			const composed = composeSystemPrompt("codebuddy-cn", clientSystemText, {
				modelId: model,
				modelName: model,
			})
			transformed.messages = [
				{ role: "system", content: composed.text },
				...transformed.messages.filter((m) => m && !["system", "developer"].includes(m.role)),
			]
		}

		// CodeBuddy only surfaces model reasoning when the request carries the CLI's
		// OpenAI-style params: reasoning_effort + reasoning_summary:"auto". 9router's
		// thinking pipeline sets reasoning_effort only when the client asks, and never
		// sets reasoning_summary - so reasoning never shows. Mirror the CLI here.
		const eff = transformed.reasoning_effort
		if (eff === "none" || eff === "off") {
			delete transformed.reasoning_effort // gateway has no "none" - just omit
		} else if (eff) {
			// Client explicitly asked for reasoning - mirror the CLI's reasoning_summary
			// so CodeBuddy surfaces the model's reasoning.
			transformed.reasoning_summary = "auto"
		}
		// No reasoning requested: leave both unset. Forcing reasoning_effort:"medium"
		// + reasoning_summary on plain requests makes CodeBuddy trip its content
		// filter and return an error (#2071).
		return transformed
	}
	parseError(response, bodyText) {
		if (bodyText) {
			try {
				const data = JSON.parse(bodyText)
				const msg = data?.msg || data?.message || data?.error?.message || ""
				if (data?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
					let resetsAtMs = null
					const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i)
					if (match) {
						const dp = match[1]
						const tp = match[2]
						const tz = match[3]
							? match[3].includes(":")
								? match[3].startsWith("+")
									? match[3]
									: `+${match[3]}`
								: `+${match[3].padStart(2, "0")}:00`
							: "+08:00"
						const dt = new Date(`${dp}T${tp}${tz}`)
						if (!Number.isNaN(dt.getTime())) resetsAtMs = dt.getTime()
					}
					return {
						status: 429,
						message: msg || "CodeBuddy frequency limit (6004)",
						resetsAtMs,
					}
				}
			} catch {}
		}
		return super.parseError(response, bodyText)
	}
}

export default CodeBuddyExecutor
