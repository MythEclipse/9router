/**
 * Reading an MCP server's answer to `tools/list`.
 *
 * The probe itself is three HTTP calls the route makes; what it *means* is here. The two things
 * worth naming are the auth verdict — a 401 means "this server needs OAuth, stop asking" rather
 * than a failure — and the SSE parsing, because a compliant server may answer over an event
 * stream while a simpler one answers with one JSON body.
 */

/** How long a probe may take before the server is reported as a timeout. */
export const MCP_PROBE_TIMEOUT_MS = 8000

/** One tool as the screen lists it. */
export interface McpTool {
	name: string
	description: string
}

/** What a probe concluded. */
export interface McpProbeResult {
	tools: McpTool[]
	requiresAuth?: boolean
	error?: string
}

/** Whether a status means "this server wants credentials", not "this server is broken". */
export function requiresAuthStatus(status: number): boolean {
	return status === 401 || status === 403
}

/**
 * Reads the JSON-RPC reply with id 2 out of an SSE body.
 *
 * A server may send several messages, including notifications before the reply, so the id is what
 * identifies the answer — taking the first `result` would read a notification as the tool list.
 */
export function parseSseReply(body: string, id: number): unknown | null {
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue
		try {
			const message = JSON.parse(line.replace(/^data:\s*/, "")) as { id?: number; result?: unknown }
			if (message?.id === id && message.result) return message
		} catch {
			// A non-JSON `data:` line is not an error: servers emit keep-alives and comments.
		}
	}
	return null
}

/** The tool list out of a parsed `tools/list` reply, tolerating a malformed one. */
export function readToolList(reply: unknown): McpTool[] {
	const tools = (reply as { result?: { tools?: unknown } } | null)?.result?.tools
	if (!Array.isArray(tools)) return []
	return tools
		.map((tool) => {
			const candidate = tool as { name?: unknown; description?: unknown } | null
			if (typeof candidate?.name !== "string" || !candidate.name) return null
			return {
				name: candidate.name,
				description: typeof candidate.description === "string" ? candidate.description : "",
			}
		})
		.filter((tool): tool is McpTool => tool !== null)
}

/** The error text for a thrown probe, naming a timeout as such rather than as an abort. */
export function probeErrorText(error: unknown): string {
	if (error instanceof Error) {
		return error.name === "AbortError" ? "timeout" : error.message
	}
	return "Unknown error"
}
