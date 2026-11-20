/**
 * Kiro must not let the model believe it has tools the caller never gave it.
 *
 * CodeWhisperer injects its own agent toolset server-side whenever a request
 * carries no `tools`. The model then behaves as if it can read files and run
 * commands, and — measured through the router on kr/claude-sonnet-4.5 — fabricates
 * the results:
 *
 *   - asked to list its tools with none declared, it named eight
 *     (read_file, write_to_file, execute_command, create_agent, web_search, …);
 *   - asked to read /etc/hostname (really "arch" on the test box) it answered
 *     "ip-172-31-24-137" and presented it as the file's contents;
 *   - asked for the model name in a real ~/.hermes/config.yaml it reported
 *     "us.anthropic.claude-sonnet-4-20250514-v1:0", which is not in the file.
 *
 * Sending `tools: []` does not suppress the injection (verified against
 * codewhisperer:generateAssistantResponse directly), but stating the absence in
 * the conversation does: the same request then answers "I cannot read that file."
 *
 * These tests pin the notice: present when the client declared no tools, absent
 * when it did, and never duplicated across a replayed conversation.
 */
import { describe, expect, it } from "vitest"

import { canonicalizeKiroConversation } from "../../apps/web/open-sse/translator/concerns/kiroConversation.js"

/** Minimal user turn, as the kiro translator builds it. */
function userTurn(content: string) {
	return { userInputMessage: { content, modelId: "claude-sonnet-4.5", origin: "AI_EDITOR" } }
}

const NOTICE = "[System note: you have no tools available"

/** Canonicalise a single user turn with the given tool specs. */
function canonicalise(content: string, toolSpecs: any[] = []) {
	return canonicalizeKiroConversation({
		history: [],
		currentMessage: userTurn(content),
		modelId: "claude-sonnet-4.5",
		toolSpecs,
		nameMap: new Map(),
	})
}

/** The content that will actually be sent as the current user turn. */
function sentContent(result: any): string {
	return result?.currentMessage?.userInputMessage?.content ?? ""
}

describe("kiro states that no tools are available", () => {
	it("adds the notice when the client declared no tools", () => {
		const out = canonicalise("Read /etc/hostname and tell me its contents.")
		expect(sentContent(out)).toContain(NOTICE)
	})

	it("keeps the user's own message after the notice", () => {
		// The notice is context, not a replacement: the request itself must survive.
		const out = canonicalise("Read /etc/hostname and tell me its contents.")
		expect(sentContent(out)).toContain("Read /etc/hostname and tell me its contents.")
	})

	it("tells the model not to claim it read or ran anything", () => {
		const out = canonicalise("Read the file.")
		const text = sentContent(out)
		expect(text).toContain("cannot read files, run commands")
		expect(text).toContain("must not claim to have done so")
	})

	it("does not add the notice when the client supplied tools", () => {
		// A real agent must keep working exactly as before.
		const tools = [
			{
				toolSpecification: {
					name: "read_file",
					description: "Read a file",
					inputSchema: { json: { type: "object", properties: {} } },
				},
			},
		]
		const out = canonicalise("Read the file.", tools)
		expect(sentContent(out)).not.toContain(NOTICE)
	})

	it("passes the declared tools through untouched", () => {
		const tools = [
			{
				toolSpecification: {
					name: "read_file",
					description: "Read a file",
					inputSchema: { json: { type: "object", properties: {} } },
				},
			},
		]
		const out = canonicalise("Read the file.", tools)
		const sent = out?.currentMessage?.userInputMessage?.userInputMessageContext?.tools ?? []
		expect(sent.length).toBe(1)
		expect(sent[0]?.toolSpecification?.name).toBe("read_file")
	})

	it("never stacks a second notice on top of an existing one", () => {
		// The conversation is replayed on every turn; the notice must not accumulate
		// into the prompt as the history grows.
		const first = canonicalise("First question.")
		const alreadyNoticed = sentContent(first)
		const second = canonicalise(alreadyNoticed)
		const occurrences = sentContent(second).split(NOTICE).length - 1
		expect(occurrences).toBe(1)
	})
})
