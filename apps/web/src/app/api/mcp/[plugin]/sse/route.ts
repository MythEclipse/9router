import {
	isPluginRefusal,
	MCP_SSE_HEADERS,
	mcpEndpointFrame,
	resolvePlugin,
} from "9router-api/domain/mcp-bridge"
import { registerSession, unregisterSession } from "@/lib/mcp/stdioSseBridge"
import { LOCAL_STDIO_PLUGINS } from "@/shared/constants/coworkPlugins"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/mcp/[plugin]/sse - subscribe to one preset stdio plugin's stream.
 *
 * Only preset plugins may be named: the segment indexes the bridge registry, which spawns a child,
 * so the preset list is the whole defence against an arbitrary spawn.
 */
export async function GET(_request, { params }) {
	const { plugin } = await params
	const found = resolvePlugin(plugin, LOCAL_STDIO_PLUGINS)
	if (isPluginRefusal(found)) {
		return new Response(found.refusal.message, { status: found.refusal.status })
	}

	const encoder = new TextEncoder()
	let sid: string | undefined

	const stream = new ReadableStream({
		start(controller) {
			const send = (chunk: string) => controller.enqueue(encoder.encode(chunk))
			sid = registerSession(plugin, send)
			// MCP SSE handshake: tell the client where to POST messages.
			send(mcpEndpointFrame(plugin, sid))
		},
		cancel() {
			// The last session leaving kills the child; skipping this leaks one process per visit.
			if (sid) unregisterSession(plugin, sid)
		},
	})

	return new Response(stream, { headers: MCP_SSE_HEADERS })
}
