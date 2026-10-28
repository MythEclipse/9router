import { v4 as uuidv4 } from "uuid"
import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"
import type { DbAdapter, DbParams, DbRow } from "../types.ts"

/**
 * A provider node as the app sees it.
 *
 * The dashboard-owned fields (`prefix`, `apiType`, `baseUrl`, `brand`, `logo`,
 * `quotaEnabled`, `quotaPath`) live in the node's JSON `data` column and arrive
 * through `rowToNode`'s spread. They are optional here because a node is created
 * from a partial request body, and required nowhere: nothing in this module reads
 * them back — the readers live in the gateway.
 */
export interface ProviderNode {
	id?: string
	type?: string | null
	name?: string | null
	prefix?: string
	apiType?: string
	baseUrl?: string
	brand?: string
	logo?: string
	quotaEnabled?: boolean
	quotaPath?: string
	createdAt?: string
	updatedAt?: string
	[key: string]: unknown
}

/** A `providerNodes` row: the columns, plus the JSON payload in `data`. */
interface ProviderNodeRow extends DbRow {
	id?: string
	type?: string | null
	name?: string | null
	data?: string | null
	createdAt?: string
	updatedAt?: string
}

/** A provider-node write, already reconciled with the existing row if any. */
interface ProviderNodeRowWrite {
	id?: string
	type?: string | null
	name?: string | null
	createdAt?: string
	updatedAt?: string
	[key: string]: unknown
}

interface ProviderNodeCacheEntry {
	list: ProviderNode[]
	ts: number
}

function rowToNode(row: ProviderNodeRow | null | undefined): ProviderNode | null {
	if (!row) return null
	const extra = parseJson<DbRow>(row.data, {})
	return {
		...extra,
		id: row.id,
		type: row.type,
		name: row.name,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

function nodeToRow(n: ProviderNodeRowWrite) {
	const { id, type, name, createdAt, updatedAt, ...rest } = n
	return {
		id,
		type: type ?? null,
		name: name ?? null,
		data: stringifyJson(rest),
		createdAt,
		updatedAt,
	}
}

function upsert(db: DbAdapter, n: ProviderNodeRowWrite) {
	const r = nodeToRow(n)
	db.run(
		`INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt`,
		[r.id, r.type, r.name, r.data, r.createdAt, r.updatedAt] as DbParams,
	)
}

// Provider nodes are read on the model-resolution path of every request whose
// model carries a provider prefix (`getModelInfo` probes up to three types), and
// they change only when the operator edits a node in the dashboard. This memo
// removes those queries from the hot path.
//
// Keyed by filter type (`""` = no filter) and CLEARED wholesale on every write,
// including importDb — a node whose prefix changed must not keep resolving to
// the old provider id.
const NODE_CACHE_TTL_MS = 5000
const nodeCache = new Map<string, ProviderNodeCacheEntry>()

export function invalidateNodeCache() {
	nodeCache.clear()
}

export async function getProviderNodes(filter: { type?: string } = {}): Promise<ProviderNode[]> {
	const cacheKey = filter.type || ""
	const hit = nodeCache.get(cacheKey)
	if (hit && Date.now() - hit.ts <= NODE_CACHE_TTL_MS) return hit.list

	const db = await getAdapter()
	const where: string[] = []
	const params: DbParams = []
	if (filter.type) {
		where.push("type = ?")
		params.push(filter.type)
	}
	const sql = `SELECT * FROM providerNodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`
	const list = db
		.all<ProviderNodeRow>(sql, params)
		.map(rowToNode)
		.filter((node): node is ProviderNode => node !== null)
	nodeCache.set(cacheKey, { list, ts: Date.now() })
	// A copy per caller: several readers sort or annotate the result, and handing
	// them the cached array would let one caller's mutation leak into the next.
	return list.slice()
}

export async function getProviderNodeById(id: string): Promise<ProviderNode | null> {
	const db = await getAdapter()
	return rowToNode(db.get<ProviderNodeRow>(`SELECT * FROM providerNodes WHERE id = ?`, [id]))
}

export async function createProviderNode(data: ProviderNode): Promise<ProviderNode> {
	const db = await getAdapter()
	const now = new Date().toISOString()
	const node: ProviderNode = {
		id: data.id || uuidv4(),
		type: data.type,
		name: data.name,
		prefix: data.prefix,
		apiType: data.apiType,
		baseUrl: data.baseUrl,
		brand: data.brand,
		logo: data.logo, // optional custom logo (data URL)
		quotaEnabled: data.quotaEnabled === true,
		quotaPath: data.quotaPath || "/credits",

		createdAt: now,
		updatedAt: now,
	}
	upsert(db, node)
	invalidateNodeCache()
	return node
}

export async function updateProviderNode(
	id: string,
	data: ProviderNode,
): Promise<ProviderNode | null> {
	const db = await getAdapter()
	let result: ProviderNode | null = null
	db.transaction(() => {
		const row = db.get<ProviderNodeRow>(`SELECT * FROM providerNodes WHERE id = ?`, [id])
		if (!row) return
		const merged = { ...rowToNode(row), ...data, updatedAt: new Date().toISOString() }
		upsert(db, merged)
		result = merged
	})
	invalidateNodeCache()
	return result
}

export async function deleteProviderNode(id: string): Promise<ProviderNode | null> {
	const db = await getAdapter()
	let removed: ProviderNode | null = null
	db.transaction(() => {
		const row = db.get<ProviderNodeRow>(`SELECT * FROM providerNodes WHERE id = ?`, [id])
		if (!row) return
		removed = rowToNode(row)
		db.run(`DELETE FROM providerNodes WHERE id = ?`, [id])
		db.run(`DELETE FROM kv WHERE scope = 'customModels' AND key LIKE ?`, [`${id}|%`])
	})
	invalidateNodeCache()
	return removed
}
