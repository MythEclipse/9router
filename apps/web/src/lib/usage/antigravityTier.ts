/**
 * The Antigravity tier probe.
 *
 * This module owns the *transport*: read the stored OAuth token, call
 * `loadCodeAssist` and `fetchAvailableModels`, cache the answer for five minutes.
 * What the answers *mean* — which tier ids unlock Claude 5.5, whether the catalogue
 * or the tier id decides, how the operator is told why — is
 * `apps/api/src/domain/antigravity-tier.ts`, which is where those rules are tested.
 *
 * Historically this file held both, and the eligibility regex drifted narrower than
 * the model ids upstream actually publishes; extracting it made that visible.
 */

const DB_PATH = process.env.DATABASE_PATH || "/root/.9router/db/data.sqlite"
const AG_BASE = "https://daily-cloudcode-pa.googleapis.com/v1internal"
const UA = "Antigravity/2.11.0 darwin/24.0.0"

import {
	noAntigravityConnection,
	presentAntigravityTier,
} from "9router-api/domain/antigravity-tier"

const CACHE_TTL_MS = 5 * 60 * 1000
let cache = { at: 0, value: null }

// node:sqlite is Node's built-in driver; Bun does not ship it. A static import
// is therefore fatal under Bun — Turbopack inlines it at build time and the
// whole route fails to collect. Load it lazily so the module survives on both
// runtimes, and let a runtime without the built-in fall back to no token
// (the caller already treats a missing token as "tier unknown").
async function readToken() {
	try {
		const { DatabaseSync } = await import("node:sqlite")
		const db = new DatabaseSync(DB_PATH, { readOnly: true })
		const row = db
			.prepare(
				"SELECT data FROM providerConnections WHERE provider = 'antigravity' AND isActive = 1 LIMIT 1",
			)
			.get()
		db.close()
		if (!row?.data) return null
		const parsed = JSON.parse(String(row.data))
		return parsed.accessToken || null
	} catch {
		return null
	}
}

async function post(path, token) {
	const res = await fetch(`${AG_BASE}:${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"User-Agent": UA,
			"Content-Type": "application/json",
			"X-Client-Name": "antigravity",
		},
		body: "{}",
		signal: AbortSignal.timeout(10000),
	})
	if (!res.ok) return null
	return res.json()
}

/**
 * @returns {Promise<{tierId: string|null, tierName: string|null,
 *   canUseClaude55: boolean, catalogHasClaude55: boolean, modelIds: string[],
 *   reason: string}>}
 */
export async function getAntigravityTier() {
	if (cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value

	const token = await readToken()
	if (!token) {
		const out = noAntigravityConnection()
		cache = { at: Date.now(), value: out }
		return out
	}

	let tierId = null
	let tierName = null
	let paidTierId = null
	try {
		const sub = await post("loadCodeAssist", token)
		if (sub) {
			tierId = sub?.currentTier?.id ?? null
			tierName = sub?.currentTier?.name ?? null
			paidTierId = sub?.paidTier?.id ?? null
		}
	} catch {
		/* fall through - catalog below is the second signal */
	}

	// The catalog is the decisive signal: a model listed there is one upstream will
	// accept. Tier ids are undocumented and have changed before.
	let modelIds = []
	try {
		const cat = await post("fetchAvailableModels", token)
		if (cat?.models) modelIds = Object.keys(cat.models)
	} catch {
		/* keep the default: an empty catalogue is "no answer", which the domain reads
		   as a failed probe rather than as "nothing available". */
	}

	const out = presentAntigravityTier({ tierId, tierName, paidTierId, modelIds })
	cache = { at: Date.now(), value: out }
	return out
}
