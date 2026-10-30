/**
 * Probing an MCP server for its tool list.
 *
 * The probe is three JSON-RPC calls — `initialize`, `notifications/initialized`, `tools/list` —
 * and what they *mean* is already in `domain/cowork-mcp-probe`. This file is the sequence, plus
 * the two decisions the route made inline:
 *
 * - a server that answers 401 or 403 is reported as "requires auth" rather than as a failure,
 *   so the screen stops asking instead of showing a red error for a correct answer;
 * - `notifications/initialized` is sent but its failure is ignored, because it is required by
 *   the spec and some servers refuse it anyway — the `tools/list` that follows is what counts.
 *
 * The fetch arrives as a parameter rather than being called directly: a remote caller must go
 * through the SSRF guard's fetch, while a local caller keeps its self-hosted MCP server on
 * loopback. The choice needs the request headers, so it is made by the caller of this function.
 */

import {
	MCP_PROBE_TIMEOUT_MS,
	type McpProbeResult,
	parseSseReply,
	probeErrorText,
	readToolList,
	requiresAuthStatus,
} from "../../domain/cowork-mcp-probe.ts"

/** The protocol version and content types every call sends. */
const PROTOCOL_VERSION = "2025-06-18"
const PROBE_HEADERS = {
	"Content-Type": "application/json",
	Accept: "application/json, text/event-stream",
	"MCP-Protocol-Version": PROTOCOL_VERSION,
}

/** A fetch that has already been chosen for the caller — guarded or unrestricted. */
export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * Reads the tool list off one MCP server.
 *
 * A timeout is reported by name rather than as an abort: `probeErrorText` already maps an
 * `AbortError` to "timeout", and a screen that says "aborted" reads like a bug in this server
 * rather than a slow one over there.
 */
export async function probeMcpServer(url: string, fetchFor: ProbeFetch): Promise<McpProbeResult> {
	const abort = new AbortController()
	const timer = setTimeout(() => abort.abort(), MCP_PROBE_TIMEOUT_MS)

	try {
		const initRes = await fetchFor(url, {
			method: "POST",
			headers: PROBE_HEADERS,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "9router", version: "1" },
				},
			}),
			signal: abort.signal,
		})

		if (requiresAuthStatus(initRes.status)) return { requiresAuth: true, tools: [] }
		if (!initRes.ok) return { error: `init ${initRes.status}`, tools: [] }

		const sessionId = initRes.headers.get("mcp-session-id") || ""
		// The body is read and discarded so the connection can be reused.
		await initRes.text().catch(() => undefined)

		const listHeaders: Record<string, string> = { ...PROBE_HEADERS }
		// A server that issued a session expects it back; one that did not must never receive
		// the header with an empty value, which reads as a malformed session rather than none.
		if (sessionId) listHeaders["mcp-session-id"] = sessionId

		await fetchFor(url, {
			method: "POST",
			headers: listHeaders,
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
			signal: abort.signal,
		}).catch(() => undefined)

		const listRes = await fetchFor(url, {
			method: "POST",
			headers: listHeaders,
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
			signal: abort.signal,
		})

		if (requiresAuthStatus(listRes.status)) return { requiresAuth: true, tools: [] }

		// A compliant server may answer over an event stream; a simpler one answers one JSON
		// body. Both are accepted because both are common in the wild.
		const contentType = listRes.headers.get("content-type") || ""
		const reply = contentType.includes("text/event-stream")
			? parseSseReply(await listRes.text(), 2)
			: await listRes.json().catch(() => null)

		return { tools: readToolList(reply) }
	} catch (error) {
		return { error: probeErrorText(error), tools: [] }
	} finally {
		clearTimeout(timer)
	}
}

/** A flat answer, matching the other CLI-tool answers. */
/**
 * A refusal carries `{ error }` alone, which is the body the route has always answered for a
 * missing or rejected URL: there is no tool list to show, and an empty one would render as
 * "connected, exposes nothing" instead of "this was refused".
 */
export type McpProbeRefusalBody = { readonly error: string }

export interface McpProbeAnswer {
	readonly status: number
	readonly body: McpProbeResult | McpProbeRefusalBody
}

/**
 * The procedure body: validate the URL, decide whether it may be private, probe.
 *
 * `url required` and `URL not allowed` keep their own messages and both are 400, because the
 * screen shows them next to the URL field and "not allowed" is the one the operator must act on.
 *
 * There is deliberately no `try`/`catch` around the probe. `probeMcpServer` already turns every
 * thrown fetch into `{ error, tools: [] }` and answers 200, so a catch here could never run —
 * and a 500 would tell the operator this side is broken when the server on the other end refused
 * the connection.
 */
export async function probeCoworkMcpTools(
	body: unknown,
	options: {
		/** The fetch this caller is allowed to use; the SSRF choice is made by the host. */
		readonly fetchFor: ProbeFetch
		/** Whether this caller may reach a non-public URL, e.g. a self-hosted server on loopback. */
		readonly allowPrivateUrl: boolean
		/** Throws when the URL is not public; only called when `allowPrivateUrl` is false. */
		readonly assertPublicUrl: (url: string) => void
	},
): Promise<McpProbeAnswer> {
	const url = (body as { url?: unknown } | null)?.url
	if (!url || typeof url !== "string") {
		return { status: 400, body: { error: "url required", tools: [] } }
	}

	if (!options.allowPrivateUrl) {
		try {
			options.assertPublicUrl(url)
		} catch {
			return { status: 400, body: { error: "URL not allowed" } }
		}
	}

	return { status: 200, body: await probeMcpServer(url, options.fetchFor) }
}
