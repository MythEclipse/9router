/**
 * Admin surface for the memory stage.
 *
 * The stage itself is automatic, but one shared bank needs three operator verbs
 * that no client should ever reach:
 *
 *   GET  /api/memory          — health of the Hindsight service + breaker state
 *   POST /api/memory/purge    — delete one principal's retained conversations
 *   POST /api/memory/reflect  — run reflect once and return its answer
 *
 * `reflect` lives here and nowhere else on purpose: it is an agentic loop with its
 * own multi-round tool calls and its own LLM, so it costs seconds and real money.
 * Per chat turn it would dominate latency; as an explicit call it is a tool.
 *
 * Purge is per principal rather than per bank because the bank is shared: deleting
 * the bank would delete every caller's memory, which is exactly the wrong blast
 * radius for "forget this user".
 *
 * Every route sits behind the dashboard auth gate (the `/api/*` deny-by-default
 * rule in `dashboardGuard.ts`), so no extra check is duplicated here.
 */
import { NextResponse } from "next/server"
import { getSettings } from "@/lib/localDb"
import { bankPath, resolveMemoryConfig } from "@/lib/memory/config"
import {
	deleteHindsight,
	getHindsight,
	hindsightBreakerState,
	postHindsight,
} from "@/lib/memory/hindsightClient"
import { principalHash } from "@/lib/memory/principal"

export const dynamic = "force-dynamic"

interface DocumentListResponse {
	items?: Array<{ id?: string; document_id?: string; memory_unit_count?: number }>
}

/** Health + effective config, with the bearer token withheld. */
export async function GET() {
	const settings = (await getSettings()) as Record<string, unknown>
	const config = resolveMemoryConfig(settings)
	const health = config.enabled
		? await getHindsight<{ status?: string; database?: string }>(
				{ baseUrl: config.baseUrl, apiKey: config.apiKey },
				"/health",
				{ timeoutMs: 2000, operation: "health" },
			)
		: null

	return NextResponse.json(
		{
			enabled: config.enabled,
			baseUrl: config.baseUrl,
			bankId: config.bankId,
			recall: config.recall,
			retain: config.retain,
			includeShared: config.includeShared,
			// The token itself never leaves the server; the form only needs to know
			// whether one is set.
			apiKeyConfigured: Boolean(config.apiKey),
			reachable: Boolean(health),
			service: health,
			breaker: hindsightBreakerState(config.baseUrl),
		},
		{ headers: { "Cache-Control": "no-store" } },
	)
}

/**
 * Delete one principal's retained conversations.
 *
 * `apiKey` names whose memory to drop; omitting it purges the anonymous scope,
 * never the whole bank — a shared bank has no single "all of it" that a caller of
 * this route should be able to erase by accident.
 */
export async function POST(request: Request) {
	let body: Record<string, unknown>
	try {
		body = (await request.json()) as Record<string, unknown>
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
	}

	const settings = (await getSettings()) as Record<string, unknown>
	const config = resolveMemoryConfig(settings)
	if (!config.enabled) {
		return NextResponse.json({ error: "Memory stage is disabled" }, { status: 400 })
	}
	const endpoint = { baseUrl: config.baseUrl, apiKey: config.apiKey }
	const action = typeof body.action === "string" ? body.action : ""

	if (action === "purge") {
		const principal = principalHash(typeof body.apiKey === "string" ? body.apiKey : "")
		const tag = `principal:${principal}`
		// Filtered by tag server-side rather than by matching a prefix on the ids we
		// happen to see: the tag is the same boundary recall uses, so what this
		// deletes is exactly what that principal could read.
		const listed = await getHindsight<DocumentListResponse>(
			endpoint,
			bankPath(config.bankId, `/documents?limit=200&tags=${encodeURIComponent(tag)}`),
			{ timeoutMs: 10_000, operation: "documents" },
		)
		const documents = listed?.items ?? []
		let deleted = 0
		for (const entry of documents) {
			const documentId = entry.id ?? entry.document_id ?? ""
			if (!documentId) continue
			const response = await deleteHindsight(
				endpoint,
				bankPath(config.bankId, `/documents/${encodeURIComponent(documentId)}`),
				{ timeoutMs: 10_000, operation: "purge" },
			)
			if (response) deleted += 1
		}
		return NextResponse.json({ purged: deleted, matched: documents.length, tag })
	}

	if (action === "reflect") {
		const query = typeof body.query === "string" ? body.query.trim() : ""
		if (!query) return NextResponse.json({ error: "query is required" }, { status: 400 })
		const answer = await postHindsight<{ text?: string }>(
			endpoint,
			bankPath(config.bankId, "/reflect"),
			// `budget: "low"` is reflect's own default; a manual call may raise it.
			{ query, budget: body.budget === "mid" || body.budget === "high" ? body.budget : "low" },
			{ timeoutMs: 60_000, operation: "reflect" },
		)
		if (!answer) return NextResponse.json({ error: "Reflect failed or timed out" }, { status: 502 })
		return NextResponse.json({ text: answer.text ?? "" })
	}

	return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 })
}
