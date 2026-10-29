import { describe, expect, test } from "vitest"
import {
	isPluginRefusal,
	MCP_FORWARD_FAILURE_STATUS,
	MCP_MESSAGE_ACCEPTED_STATUS,
	MCP_SSE_HEADERS,
	mcpEndpointFrame,
	resolvePlugin,
} from "../../apps/api/src/domain/mcp-bridge"

const PLUGINS = [{ name: "memory" }, { name: "sequential-thinking" }]

describe("resolvePlugin", () => {
	test("a preset plugin resolves", () => {
		const result = resolvePlugin("memory", PLUGINS)
		expect(isPluginRefusal(result)).toBe(false)
		if (!isPluginRefusal(result)) expect(result.plugin.name).toBe("memory")
	})

	test("an arbitrary name is refused, because the name spawns a process", () => {
		// This list is the entire defence: the segment indexes a registry that forks a child.
		for (const name of ["/bin/sh", "../../etc/passwd", "npx", "anything-else"]) {
			expect(isPluginRefusal(resolvePlugin(name, PLUGINS))).toBe(true)
		}
	})

	test("an unknown name is 404, not 400", () => {
		const result = resolvePlugin("nope", PLUGINS)
		expect(isPluginRefusal(result)).toBe(true)
		if (isPluginRefusal(result)) {
			expect(result.refusal.status).toBe(404)
			expect(result.refusal.message).toBe("Unknown plugin: nope")
		}
	})

	test("a missing or non-string name is refused", () => {
		expect(isPluginRefusal(resolvePlugin(undefined, PLUGINS))).toBe(true)
		expect(isPluginRefusal(resolvePlugin(null, PLUGINS))).toBe(true)
		expect(isPluginRefusal(resolvePlugin(7, PLUGINS))).toBe(true)
		expect(isPluginRefusal(resolvePlugin("", PLUGINS))).toBe(true)
	})

	test("an empty preset list refuses everything", () => {
		expect(isPluginRefusal(resolvePlugin("memory", []))).toBe(true)
	})
})

describe("isPluginRefusal", () => {
	test("it narrows both branches", () => {
		// apps/web builds with strict: false, so a plain discriminant check would not narrow.
		expect(isPluginRefusal(resolvePlugin("nope", PLUGINS))).toBe(true)
		expect(isPluginRefusal(resolvePlugin("memory", PLUGINS))).toBe(false)
	})
})

describe("mcpEndpointFrame", () => {
	test("it is one SSE event followed by a blank line", () => {
		expect(mcpEndpointFrame("memory", "sid-1")).toBe(
			"event: endpoint\ndata: /api/mcp/memory/message?sessionId=sid-1\n\n",
		)
	})

	test("the session id rides in the path, not a query the route reads", () => {
		// The POST side ignores it: the child's stdin is shared by every session.
		expect(mcpEndpointFrame("memory", "sid-1")).toContain("/api/mcp/memory/message?sessionId=sid-1")
	})
})

describe("statuses", () => {
	test("a forwarded message is 202, not 200", () => {
		// The child has accepted the bytes; it has not answered yet.
		expect(MCP_MESSAGE_ACCEPTED_STATUS).toBe(202)
	})

	test("a dead bridge is 502, not 500", () => {
		// The child exited between subscribe and POST; the client resubscribes rather than resends.
		expect(MCP_FORWARD_FAILURE_STATUS).toBe(502)
	})
})

describe("MCP_SSE_HEADERS", () => {
	test("the stream must not be buffered by a proxy", () => {
		expect(MCP_SSE_HEADERS["X-Accel-Buffering"]).toBe("no")
		expect(MCP_SSE_HEADERS["Cache-Control"]).toContain("no-transform")
	})

	test("it is a real event stream", () => {
		expect(MCP_SSE_HEADERS["Content-Type"]).toBe("text/event-stream")
	})
})
