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

import { listOptedInKeys, setKeyOptIn } from "@9router/db/repos/memoryOptInRepo"
import type { MemorySettings } from "@9router/db/repos/settingsTypes"
import { NextResponse } from "next/server"
import { getSettings, updateSettings } from "@/lib/localDb"
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
	const config = resolveMemoryConfig({ settings })
	// Probed whenever a URL is configured, not only when the stage is "on": there
	// is no global switch any more, and an operator checking health before opting a
	// key in still needs an answer.
	const health = config.baseUrl
		? await getHindsight<{ status?: string; database?: string }>(
				{ baseUrl: config.baseUrl, apiKey: config.apiKey },
				"/health",
				{ timeoutMs: 2000, operation: "health" },
			)
		: null

	// Which combos opted in, so the page can render their switches without
	// re-deriving the rules. A combo entry exists for tuning alone, so "has a
	// memory block" and "memory is on for this combo" are different questions.
	const strategies = (settings.comboStrategies ?? {}) as Record<string, unknown>
	const combos = Object.entries(strategies)
		.map(([name, value]) => {
			const block = (value as { memory?: Record<string, unknown> } | null)?.memory
			return {
				name,
				memoryEnabled: block?.enabled === true,
				includeShared: block?.includeShared !== false,
			}
		})
		.sort((a, b) => a.name.localeCompare(b.name))

	return NextResponse.json(
		{
			// Per-key enablement means there is no single on/off to report; the list of
			// opted-in keys is what answers "is it on, and for whom".
			optedInKeys: await listOptedInKeys(),
			combos,
			baseUrl: config.baseUrl,
			bankId: config.bankId,
			recall: config.recall,
			retain: config.retain,
			includeShared: config.includeShared,
			sharedTags: config.sharedTags,
			retainTags: config.retainTags,
			recallBudget: config.recallBudget,
			recallMaxTokens: config.recallMaxTokens,
			timeoutMs: config.timeoutMs,
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
	const config = resolveMemoryConfig({ settings })
	// Admin verbs are gated on the *connection* being configured, not on the stage
	// being enabled: with per-key opt-in there is no global "enabled" to check, and
	// an operator must be able to opt a key in before any request can use memory.
	if (!config.baseUrl) {
		return NextResponse.json(
			{ error: "Memory stage has no Hindsight URL configured" },
			{ status: 400 },
		)
	}
	const endpoint = { baseUrl: config.baseUrl, apiKey: config.apiKey }
	const action = typeof body.action === "string" ? body.action : ""

	if (action === "opt-in" || action === "opt-out") {
		const keyId = typeof body.keyId === "string" ? body.keyId.trim() : ""
		if (!keyId) return NextResponse.json({ error: "keyId is required" }, { status: 400 })
		await setKeyOptIn(keyId, action === "opt-in")
		return NextResponse.json({ keyId, optedIn: action === "opt-in" })
	}

	// Per-combo switch. Written through the same settings row the routing strategy
	// reads, under `comboStrategies[<name>].memory`, so a combo that opts in carries
	// memory whatever key calls it. Turning it off removes only the `enabled` flag:
	// a combo may keep `includeShared`/budget tuning it will use again later.
	if (action === "combo-opt-in" || action === "combo-opt-out") {
		const comboName = typeof body.comboName === "string" ? body.comboName.trim() : ""
		if (!comboName) return NextResponse.json({ error: "comboName is required" }, { status: 400 })
		const strategies = ((settings.comboStrategies ?? {}) as Record<string, unknown>) ?? {}
		const current = (strategies[comboName] ?? {}) as Record<string, unknown>
		const currentMemory = (current.memory ?? {}) as Record<string, unknown>
		const nextMemory: Record<string, unknown> = { ...currentMemory }
		if (action === "combo-opt-in") nextMemory.enabled = true
		else delete nextMemory.enabled

		await updateSettings({
			comboStrategies: {
				...strategies,
				[comboName]: { ...current, memory: nextMemory },
			},
		} as Parameters<typeof updateSettings>[0])
		return NextResponse.json({ comboName, memoryEnabled: action === "combo-opt-in" })
	}

	// Connection settings. Only the fields the form owns are written, so a
	// concurrent edit elsewhere in the settings row cannot be clobbered by a save
	// from this page.
	if (action === "save-config") {
		const patch = (body.config ?? {}) as Record<string, unknown>
		const current = config
		// Start from the resolved config so every required field has a value, then
		// apply only the fields this form owns. Building a partial object and casting
		// it would let a missing required field reach the settings row.
		const next: MemorySettings = {
			baseUrl: current.baseUrl,
			apiKey: current.apiKey,
			bankId: current.bankId,
			recall: current.recall,
			retain: current.retain,
			includeShared: current.includeShared,
			sharedTags: current.sharedTags,
			retainTags: current.retainTags,
			recallBudget: current.recallBudget,
			recallMaxTokens: current.recallMaxTokens,
			timeoutMs: current.timeoutMs,
		}
		for (const field of ["baseUrl", "bankId"] as const) {
			if (typeof patch[field] === "string") next[field] = (patch[field] as string).trim()
		}
		// An empty string means "leave the stored token alone" rather than "clear
		// it": the form cannot read the token back, so an unrelated save would
		// otherwise wipe it. A dedicated clear is a separate, explicit verb.
		if (typeof patch.apiKey === "string" && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim()
		for (const field of ["recall", "retain", "includeShared"] as const) {
			if (typeof patch[field] === "boolean") next[field] = patch[field]
		}
		if (Array.isArray(patch.sharedTags))
			next.sharedTags = patch.sharedTags.filter((t) => typeof t === "string")
		if (Array.isArray(patch.retainTags))
			next.retainTags = patch.retainTags.filter((t) => typeof t === "string")
		if (
			patch.recallBudget === "low" ||
			patch.recallBudget === "mid" ||
			patch.recallBudget === "high"
		) {
			next.recallBudget = patch.recallBudget
		}
		for (const field of ["recallMaxTokens", "timeoutMs"] as const) {
			const value = Number(patch[field])
			if (Number.isFinite(value) && value > 0) next[field] = Math.trunc(value)
		}
		await updateSettings({ memory: next })
		return NextResponse.json({ saved: true })
	}

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
