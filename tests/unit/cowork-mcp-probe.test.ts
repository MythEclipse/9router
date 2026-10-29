import { describe, expect, it } from "vitest"
import {
	parseSseReply,
	probeErrorText,
	readToolList,
	requiresAuthStatus,
} from "../../apps/api/src/domain/cowork-mcp-probe.ts"

/**
 * A probe answers in one of two shapes and may report "needs credentials" instead of a tool list.
 * Reading it wrong shows an empty plugin, or an error where the operator should have been told to
 * authenticate — both are visible only against a live server, which is why they are pinned here.
 */

describe("requiresAuthStatus", () => {
	it("reads 401 and 403 as an auth requirement, not a failure", () => {
		expect(requiresAuthStatus(401)).toBe(true)
		expect(requiresAuthStatus(403)).toBe(true)
	})

	it("leaves other statuses to the error path", () => {
		expect(requiresAuthStatus(200)).toBe(false)
		expect(requiresAuthStatus(500)).toBe(false)
	})
})

describe("parseSseReply", () => {
	it("finds the reply with the requested id", () => {
		const body = [
			"event: message",
			'data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}',
			"",
			'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search"}]}}',
		].join("\n")
		const reply = parseSseReply(body, 2)
		expect(readToolList(reply)).toEqual([{ name: "search", description: "" }])
	})

	it("does not read a notification as the tool list", () => {
		// A notification with a result-like payload must not be mistaken for the reply.
		const body =
			'data: {"jsonrpc":"2.0","method":"notifications/x","result":{"tools":[{"name":"wrong"}]}}'
		expect(parseSseReply(body, 2)).toBe(null)
	})

	it("skips keep-alives and malformed lines rather than throwing", () => {
		const body = ["data: ping", "data: ", ": comment", 'data: {"id":2,"result":{"tools":[]}}'].join(
			"\n",
		)
		expect(readToolList(parseSseReply(body, 2))).toEqual([])
	})

	it("answers null when the reply never arrives", () => {
		expect(parseSseReply("", 2)).toBe(null)
		expect(parseSseReply('data: {"id":1,"result":{}}', 2)).toBe(null)
	})
})

describe("readToolList", () => {
	it("keeps name and description, and tolerates a missing description", () => {
		const reply = {
			result: {
				tools: [
					{ name: "search", description: "Find things" },
					{ name: "fetch" },
					{ description: "no name" },
					null,
					{ name: "" },
				],
			},
		}
		expect(readToolList(reply)).toEqual([
			{ name: "search", description: "Find things" },
			{ name: "fetch", description: "" },
		])
	})

	it("answers an empty list for a reply of any other shape", () => {
		expect(readToolList(null)).toEqual([])
		expect(readToolList({})).toEqual([])
		expect(readToolList({ result: { tools: "nope" } })).toEqual([])
	})
})

describe("probeErrorText", () => {
	it("names a timeout as a timeout rather than as an abort", () => {
		const abort = new Error("The operation was aborted")
		abort.name = "AbortError"
		// "AbortError" would tell the operator nothing about what to change.
		expect(probeErrorText(abort)).toBe("timeout")
	})

	it("passes a real message through, and never answers an empty string", () => {
		expect(probeErrorText(new Error("ECONNREFUSED"))).toBe("ECONNREFUSED")
		expect(probeErrorText("a string")).toBe("Unknown error")
		expect(probeErrorText(undefined)).toBe("Unknown error")
	})
})
