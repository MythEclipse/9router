import {
	isPluginRefusal,
	MCP_FORWARD_FAILURE_STATUS,
	MCP_MESSAGE_ACCEPTED_STATUS,
	resolvePlugin,
} from "9router-api/domain/mcp-bridge"
import { NextResponse } from "next/server"
import { sendToChild } from "@/lib/mcp/stdioSseBridge"
import { LOCAL_STDIO_PLUGINS } from "@/shared/constants/coworkPlugins"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/mcp/[plugin]/message - forward one JSON-RPC message to the plugin's child process.
 *
 * `?sessionId=` is accepted and ignored on purpose: the child's stdin is shared by every session,
 * so the id decides nothing here. See `domain/mcp-bridge.ts`.
 */
export async function POST(request, { params }) {
	const { plugin } = await params
	const found = resolvePlugin(plugin, LOCAL_STDIO_PLUGINS)
	if (isPluginRefusal(found)) {
		return NextResponse.json({ error: found.refusal.message }, { status: found.refusal.status })
	}

	try {
		sendToChild(plugin, await request.json())
		return new Response(null, { status: MCP_MESSAGE_ACCEPTED_STATUS })
	} catch (e) {
		// The bridge is not running — the child exited between subscribe and this POST, so the
		// client has to resubscribe rather than resend. That is a 502, not a 500.
		return NextResponse.json({ error: e.message }, { status: MCP_FORWARD_FAILURE_STATUS })
	}
}
