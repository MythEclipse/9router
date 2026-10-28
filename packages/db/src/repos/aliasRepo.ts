import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"
import { makeKv } from "../helpers/kvStore.ts"

/** A custom (dashboard-added) model as stored in the `customModels` scope. */
export interface CustomModel {
	providerAlias: string
	id: string
	type: string
	name: string
	ownedBy?: string
	caps?: unknown
	transport?: unknown
	inputMultiplier?: number
	outputMultiplier?: number
	antiProbe?: boolean
	[key: string]: unknown
}

/** What a caller supplies to add (or re-add) a custom model. */
export interface CustomModelInput {
	providerAlias: string
	id: string
	type?: string
	name?: string
	ownedBy?: string
	caps?: unknown
	transport?: unknown
	inputMultiplier?: number | string
	outputMultiplier?: number | string
	antiProbe?: unknown
}

/** One tool's anthropic-to-openai alias mappings. */
export type MitmAliasMappings = Record<string, unknown>

const aliasKv = makeKv("modelAliases")
const customKv = makeKv("customModels")
const mitmKv = makeKv("mitmAlias")

// modelAliases: key=alias, value=modelString
export async function getModelAliases(): Promise<Record<string, string>> {
	return await aliasKv.getAll<string>()
}

export async function setModelAlias(alias: string, model: string): Promise<void> {
	await aliasKv.set(alias, model)
}

export async function deleteModelAlias(alias: string): Promise<void> {
	await aliasKv.remove(alias)
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias: string, id: string, type: string): string {
	return `${providerAlias}|${id}|${type}`
}

export async function getCustomModels(): Promise<CustomModel[]> {
	const all = await customKv.getAll<CustomModel>()
	return Object.values(all)
}

/** A positive multiplier, or `undefined` when the value is absent or non-positive. */
function positiveMultiplier(value: number | string | undefined): number | undefined {
	const parsed = Number(value)
	return parsed > 0 ? parsed : undefined
}

// Atomic upsert inside transaction to prevent duplicate races.
// Re-adding an existing model updates caps/name/transport without resetting omitted fields.
export async function addCustomModel({
	providerAlias,
	id,
	type = "llm",
	name,
	ownedBy,
	caps,
	transport,
	inputMultiplier,
	outputMultiplier,
	antiProbe,
}: CustomModelInput): Promise<boolean> {
	const k = customKey(providerAlias, id, type)
	const inMult = positiveMultiplier(inputMultiplier)
	const outMult = positiveMultiplier(outputMultiplier)
	const ap = typeof antiProbe === "boolean" ? antiProbe : undefined
	const db = await getAdapter()
	let added = false
	db.transaction(() => {
		const row = db.get<{ value?: string | null }>(
			`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`,
			[k],
		)
		if (row) {
			const prev = (parseJson(row.value, {}) || {}) as Record<string, unknown>
			const next = {
				...prev,
				...(name ? { name } : {}),
				...(ownedBy ? { ownedBy } : {}),
				...(caps ? { caps } : {}),
				...(transport ? { transport } : {}),
				...(inMult !== undefined ? { inputMultiplier: inMult } : {}),
				...(outMult !== undefined ? { outputMultiplier: outMult } : {}),
				...(ap !== undefined ? { antiProbe: ap } : {}),
			}
			db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [
				stringifyJson(next),
				k,
			])
			return
		}
		const value = stringifyJson({
			providerAlias,
			id,
			type,
			name: name || id,
			...(ownedBy ? { ownedBy } : {}),
			...(caps ? { caps } : {}),
			...(transport ? { transport } : {}),
			...(inMult !== undefined ? { inputMultiplier: inMult } : {}),
			...(outMult !== undefined ? { outputMultiplier: outMult } : {}),
			...(ap !== undefined ? { antiProbe: ap } : {}),
		})
		db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value])
		added = true
	})
	return added
}

export async function deleteCustomModel({
	providerAlias,
	id,
	type = "llm",
}: Pick<CustomModelInput, "providerAlias" | "id" | "type">): Promise<void> {
	await customKv.remove(customKey(providerAlias, id, type))
}

/**
 * One tool's alias mappings, or every tool's keyed by tool name.
 *
 * The return type is the union so a caller that cannot name the tool still gets
 * a usable object rather than `unknown` at each property access.
 */
export async function getMitmAlias(
	toolName?: string,
): Promise<MitmAliasMappings | Record<string, MitmAliasMappings>> {
	if (toolName) {
		const v = await mitmKv.get<MitmAliasMappings>(toolName)
		return v || {}
	}
	return await mitmKv.getAll<MitmAliasMappings>()
}

export async function setMitmAliasAll(
	toolName: string,
	mappings?: MitmAliasMappings,
): Promise<void> {
	await mitmKv.set(toolName, mappings || {})
}
