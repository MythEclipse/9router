import {
	MCP_PROBE_TIMEOUT_MS,
	type McpProbeResult,
	parseSseReply,
	probeErrorText,
	readToolList,
	requiresAuthStatus,
} from "9router-api/domain/cowork-mcp-probe"
import { NextResponse } from "next/server"
import { isLocalRequest } from "@/dashboardGuard"
import { assertPublicUrl } from "@/shared/utils/ssrfGuard"

export const dynamic = "force-dynamic"

const PROBE_HEADERS = {
	"Content-Type": "application/json",
	Accept: "application/json, text/event-stream",
	"MCP-Protocol-Version": "2025-06-18",
}

/**
 * Probes an MCP server: `initialize`, then `notifications/initialized`, then `tools/list`.
 *
 * No auth header is sent — this works for authless servers, and an OAuth server answers 401,
 * which is reported as "requires auth" so the screen stops asking rather than showing a failure.
 */
async function probeMcp(url: string): Promise<McpProbeResult> {
	const abort = new AbortController()
	const timer = setTimeout(() => abort.abort(), MCP_PROBE_TIMEOUT_MS)

	try {
		const initRes = await fetch(url, {
			method: "POST",
			headers: PROBE_HEADERS,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "9router", version: "1" },
				},
			}),
			signal: abort.signal,
		})

		if (requiresAuthStatus(initRes.status)) return { requiresAuth: true, tools: [] }
		if (!initRes.ok) return { error: `init ${initRes.status}`, tools: [] }

		const sessionId = initRes.headers.get("mcp-session-id") || ""
		await initRes.text().catch(() => {})

		const listHeaders: Record<string, string> = { ...PROBE_HEADERS }
		// A server that issued a session expects it back; one that did not must not receive the
		// header with an empty value.
		if (sessionId) listHeaders["mcp-session-id"] = sessionId

		// Required by the spec before `tools/list`; a server refusing it is not fatal here.
		await fetch(url, {
			method: "POST",
			headers: listHeaders,
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
			signal: abort.signal,
		}).catch(() => {})

		const listRes = await fetch(url, {
			method: "POST",
			headers: listHeaders,
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
			signal: abort.signal,
		})

		if (requiresAuthStatus(listRes.status)) return { requiresAuth: true, tools: [] }

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

export async function POST(request: Request) {
	try {
		const body = (await request.json()) as { url?: unknown }
		const url = body.url
		if (!url || typeof url !== "string") {
			return NextResponse.json({ error: "url required" }, { status: 400 })
		}

		// SSRF guard for remote callers; a local caller keeps its self-hosted MCP servers, which
		// legitimately live on loopback.
		if (!isLocalRequest(request)) {
			try {
				assertPublicUrl(url)
			} catch {
				return NextResponse.json({ error: "URL not allowed" }, { status: 400 })
			}
		}

		return NextResponse.json(await probeMcp(url))
	} catch (error) {
		return NextResponse.json({ error: probeErrorText(error), tools: [] }, { status: 500 })
	}
}
