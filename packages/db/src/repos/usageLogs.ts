/**
 * Request log readers.
 *
 * Extracted verbatim from usageRepo.ts.
 */

import { getAdapter } from "../driver.ts"
import { parseJson } from "../helpers/jsonCol.ts"
import { labelForRow } from "../helpers/modelLabel.ts"
import type { DbRow, ResolvedDbAdapter } from "../types.ts"
import { saveRequestUsage } from "./usageHistory.ts"
import { PENDING_TIMEOUT_MS } from "./usageState.ts"
import type { UsageTokens } from "./usageTypes.ts"

export interface RequestLogEntry {
	model?: string | null
	provider?: string | null
	connectionId?: string | null
	tokens?: UsageTokens | null
	apiKey?: string | null
	endpoint?: string | null
	status?: string | null
	requestId?: string | null
	/** The name the caller asked for, when it differs from the serving model. */
	requestedModel?: string | null
}

export async function appendRequestLog({
	model,
	provider,
	connectionId,
	tokens,
	apiKey,
	endpoint,
	status,
	requestId,
	requestedModel,
}: RequestLogEntry = {}): Promise<void> {
	const upper = typeof status === "string" ? status.toUpperCase() : ""
	const isFailure = upper.includes("FAILED")
	const isPending = upper.includes("PENDING")
	if (!isFailure && !isPending) return

	// A lifecycle row (pending marker, failed call) lands in the same table the
	// live stream reads, and the caller passes the REQUESTED name there — a combo.
	// Without the alias the row carries meta={} and the dashboard shows the combo
	// until the terminal row replaces it, which reads as the model flickering
	// between the real target and the combo name once per request.
	const realModel = requestedModel || model
	const aliasModelName = requestedModel ? model : undefined

	try {
		await saveRequestUsage(
			{
				provider: provider || "unknown",
				model: realModel || "unknown",
				requestedModel: aliasModelName,
				connectionId: connectionId || undefined,
				apiKey: undefined,
				endpoint: endpoint || null,
				tokens: tokens || { prompt_tokens: 0, completion_tokens: 0 },
				timestamp: new Date().toISOString(),
				status: isPending ? "pending" : "error",
				// Only the PENDING marker carries the request id. A FAILED row must NOT:
				// the dedupe lookup below matches on `requestId` regardless of status, so
				// an error row tagged with the request's id would suppress the usage row a
				// later combo retry writes for the same request (error rows are written
				// with 0/0 tokens, before any billing). The marker is the row that needs
				// to be found by id — that is the one clearPendingRow deletes.
				requestId: isPending && requestId ? requestId : undefined,
			},
			{
				// A start marker or a failed call billed nothing: it belongs in the log,
				// never in token/cost/lifetime totals.
				logOnly: true,
				// The dedupe path collapses duplicate USAGE reports, not distinct
				// lifecycle events, so these rows are always written.
				allowDuplicate: true,
			},
		)
	} catch (e) {
		console.error("[usageRepo] appendRequestLog failed:", e instanceof Error ? e.message : e)
	}
}

/**
 * Drop the open PENDING row a terminal write supersedes.
 * Scoped to the same provider/model/connection and the pending window, so an
 * unrelated older request is never touched. Caller runs this inside the usage
 * transaction.
 *
 * When the caller supplies the request's own id, delete by that instead. The
 * id is an indexed column, so this is a seek; the fallback below cannot use any
 * index (`status`/`provider`/`model`/`connectionId` are all filtered together,
 * and the COALESCE wrappers defeat the single-column indexes anyway) and scans
 * `usageHistory` once per completed request. Measured with a SQL-level probe:
 * 51.7ms for 601 requests at ~2k rows — 86us each, growing with the table,
 * on the write path of every request.
 */
/** The subset of an entry that identifies its open pending row. */
interface PendingRowKey {
	provider?: string | null
	model?: string | null
	connectionId?: string | null
	requestId?: string | number | null
}

export function clearPendingRow(
	db: ResolvedDbAdapter,
	{ provider, model, connectionId, requestId }: PendingRowKey,
): void {
	try {
		if (requestId) {
			// `status = 'pending'` keeps this from touching the usage row this same
			// transaction is about to insert under the same id.
			db.run(`DELETE FROM usageHistory WHERE requestId = ? AND status = 'pending'`, [
				String(requestId),
			])
			return
		}
		const cutoff = new Date(Date.now() - PENDING_TIMEOUT_MS).toISOString()
		db.run(
			`DELETE FROM usageHistory
        WHERE status = 'pending'
          AND timestamp >= ?
          AND COALESCE(provider, '') = COALESCE(?, '')
          AND COALESCE(model, '') = COALESCE(?, '')
          AND COALESCE(connectionId, '') = COALESCE(?, '')`,
			[cutoff, provider || null, model || null, connectionId || null],
		)
	} catch {
		/* log bookkeeping must never fail a usage write */
	}
}

export async function getRecentLogs(limit = 200) {
	try {
		const db = await getAdapter()
		const rows = db.all<DbRow>(
			`SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens, meta FROM usageHistory ORDER BY id DESC LIMIT ?`,
			[limit],
		)
		if (!rows.length) return []

		const connMap: Record<string, string> = {}
		try {
			const { getProviderConnections } = await import("./connectionsRepo.ts")
			const connections = await getProviderConnections()
			for (const c of connections) if (c) connMap[c.id] = c.name || c.email || ""
		} catch (e) {
			// The log keeps the connection id, so an export stays usable without the name.
			console.error("[usage] failed to load connection names for the log export:", e)
		}

		return rows.map((r) => {
			const connectionId = r.connectionId ? String(r.connectionId) : ""
			const ts = formatLogDate(new Date(String(r.timestamp)))
			const p = String(r.provider ?? "").toUpperCase() || "-"
			// The stored `model` is the name the caller asked for; the real target is
			// in meta. A log line that names the combo claims the combo served it.
			const m = labelForRow(r.model, r.meta).display || "-"
			const account = connMap[connectionId] || (connectionId ? connectionId.slice(0, 8) : "-")
			const tk = r.tokens ? parseJson<UsageTokens>(r.tokens as string, {}) : {}
			const sent = r.promptTokens != null ? Number(r.promptTokens) : (tk.prompt_tokens ?? "-")
			const received =
				r.completionTokens != null ? Number(r.completionTokens) : (tk.completion_tokens ?? "-")
			return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${normalizeLogStatus(r.status, r.timestamp == null ? null : String(r.timestamp))}`
		})
	} catch (e) {
		console.error("[usageRepo] getRecentLogs failed:", e instanceof Error ? e.message : e)
		return []
	}
}

/** One finished request's timing, as the latency report reads it. */

function formatLogDate(date: Date = new Date()): string {
	const pad = (n: number): string => String(n).padStart(2, "0")
	return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * The log table's status cell, in the vocabulary RequestLogger.js renders.
 *
 * It classifies by substring — "PENDING" pulses, "FAILED" is red, "OK" is green
 * — while saveRequestUsage writes the wire-style `ok`/`error`. Left raw, every
 * successful request fell through all three checks and rendered as a pulsing
 * PENDING row, so a finished request looked like it was still in flight forever.
 */

function normalizeLogStatus(
	status: unknown,
	timestamp: string | number | Date | null | undefined,
): string {
	const raw = typeof status === "string" ? status.trim() : ""
	if (!raw) return "-"
	const upper = raw.toUpperCase()
	if (upper.includes("FAILED") || upper === "ERROR") return upper === "ERROR" ? "FAILED" : upper
	if (upper === "PENDING") {
		// A pending row older than the request timeout has no live request behind
		// it — the process died or the write never completed. Rendering it as
		// PENDING would pulse forever, so surface it as the stale marker instead.
		const startedMs = timestamp ? new Date(timestamp).getTime() : Number.NaN
		if (Number.isFinite(startedMs) && Date.now() - startedMs > PENDING_TIMEOUT_MS) return "STALE"
		return "PENDING"
	}
	if (upper === "OK" || upper === "SUCCESS" || /^2\d\d/.test(upper)) {
		return upper === "OK" ? "200 OK" : upper
	}
	return upper
}

// Request log = the usageHistory table read back (getRecentLogs). Successes land
// there via saveRequestUsage, but FAILURES never do — a failed call has no usage
// to charge, so nothing wrote a row and the dashboard's Request Logs tab showed a
// stream of successes with no trace of what broke. Callers already report every
// failure through this function, so record it: a zero-token usageHistory row is
// exactly what a billed-nothing failed request looks like.
//
// PENDING is the "a request just started" marker chatCore emits before dispatch.
// It is written as its own row so an in-flight request is visible in the log, and
// it is superseded by the terminal write: saveRequestUsage() drops the matching
// open row in the same transaction as it inserts the usage row (see
// clearPendingRow), so a request ends up as exactly one row. A pending row that
// outlives PENDING_TIMEOUT_MS means the process went away mid-request; reading it
// back renders that as STALE rather than pulsing "pending" forever.
