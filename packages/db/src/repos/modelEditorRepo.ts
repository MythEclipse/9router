import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"

/** A kv value this repo stores: JSON the writer shaped, read back unvalidated. */
type StoredModel = Record<string, unknown>

/** A studio model: a user-owned callable name pointing at any `provider/model`. */
interface StudioModel {
	callName: string
	displayName: string
	ownedBy: string
	targetModel: string
	targetLabel: string
	provider: string
	model: string
	contextWindow: number
	systemPrompt: string
	inputMultiplier?: number
	outputMultiplier?: number
	antiProbe?: boolean
	createdAt: string
}

// Two record shapes live in the `modelOverrides` kv scope:
//  • `{callName}`           → a studio model: a user-owned callable name that points at any
//                             `provider/model` and may override context window + system prompt.
//                             The router resolves the name directly via getStudioModel (no alias needed).
//  • `{provider}|{model}`   → legacy per-model override, still honoured at request time.
const SCOPE = "modelOverrides"

function store() {
	return {
		async all() {
			const db = await getAdapter()
			const rows = db.all<{ key: string; value: string }>(
				`SELECT key, value FROM kv WHERE scope = ?`,
				[SCOPE],
			)
			const out: Record<string, Record<string, unknown>> = {}
			for (const row of rows) out[row.key] = parseJson<Record<string, unknown>>(row.value, {})
			return out
		},
		async get(key: string) {
			const db = await getAdapter()
			const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, key])
			return row ? parseJson(row.value, {}) : null
		},
		async set(key: string, value: StoredModel) {
			const db = await getAdapter()
			db.run(
				`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
  ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
				[SCOPE, key, stringifyJson(value)],
			)
		},
		async remove(key: string) {
			const db = await getAdapter()
			db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, key])
		},
	}
}

function toModel(callName: string, value: StoredModel) {
	if (!value || typeof value !== "object") return null
	const target = typeof value.targetModel === "string" ? value.targetModel.trim() : ""
	if (!target) return null
	const firstSlash = target.indexOf("/")
	// A bare name is a combo target (validated at the API layer). Anything else
	// must stay a provider/model pair so old records keep resolving as before.
	if (firstSlash < 0) return toComboTargetModel(callName, value, target)
	if (firstSlash === 0 || firstSlash === target.length - 1) return null
	return {
		callName,
		displayName: (typeof value.displayName === "string" ? value.displayName.trim() : "") || callName,
		// Free-form label this model claims in a model listing. Never derived from the
		// target, so a studio model can present itself as whatever the owner wants.
		ownedBy: (typeof value.ownedBy === "string" ? value.ownedBy.trim() : "") || "",
		targetModel: target,
		targetLabel:
			(typeof value.targetLabel === "string" ? value.targetLabel.trim() : "") ||
			(typeof value.targetModel === "string" ? value.targetModel.trim() : "") ||
			target,
		provider: target.slice(0, firstSlash),
		model: target.slice(firstSlash + 1),
		contextWindow: Number(value.contextWindow) || 0,
		systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : "",
		inputMultiplier: Number(value.inputMultiplier) > 0 ? Number(value.inputMultiplier) : undefined,
		outputMultiplier: Number(value.outputMultiplier) > 0 ? Number(value.outputMultiplier) : undefined,
		antiProbe: typeof value.antiProbe === "boolean" ? value.antiProbe : undefined,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
	}
}

// Studio model pointing at a combo: the callable name routes into the combo,
// so provider/model are the combo coordinates the caps and router code use.
function toComboTargetModel(
	callName: string,
	value: StoredModel,
	target: string,
): StudioModel & { isComboTarget: true } {
	return {
		callName,
		displayName: (typeof value.displayName === "string" ? value.displayName.trim() : "") || callName,
		ownedBy: (typeof value.ownedBy === "string" ? value.ownedBy.trim() : "") || "",
		targetModel: target,
		targetLabel:
			(typeof value.targetLabel === "string" ? value.targetLabel.trim() : "") ||
			(typeof value.targetModel === "string" ? value.targetModel.trim() : "") ||
			target,
		provider: "combo",
		model: target,
		isComboTarget: true,
		contextWindow: Number(value.contextWindow) || 0,
		systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : "",
		inputMultiplier: Number(value.inputMultiplier) > 0 ? Number(value.inputMultiplier) : undefined,
		outputMultiplier: Number(value.outputMultiplier) > 0 ? Number(value.outputMultiplier) : undefined,
		antiProbe: typeof value.antiProbe === "boolean" ? value.antiProbe : undefined,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
	}
}

/** Studio models (keyed by their callable name), sorted by name. */
export async function getStudioModels() {
	const rows = await store().all()
	const models = Object.entries(rows)
		.filter(([key]) => !key.includes("|"))
		.map(([key, value]) => toModel(key, value))
		.filter(Boolean)
		.sort((a, b) => a.callName.localeCompare(b.callName))

	// Migration: older builds wrote a display alias for every studio name into the
	// modelAliases kv scope, which made the studio name REPLACE the original model
	// in pickers. Two studio names on one model then answered as whichever alias
	// matched first, so a call to one showed up as the other in usage. Studio names
	// resolve through getStudioModel now, so drop every leftover alias keyed by a
	// studio name, whatever value it stored. Idempotent, best-effort.
	if (models.length) {
		try {
			const { getModelAliases, deleteModelAlias } = await import("./aliasRepo.ts")
			const aliases = await getModelAliases()
			for (const m of models) {
				if (m.callName in aliases) await deleteModelAlias(m.callName)
			}
		} catch {
			/* fail open - the studio list is still returned */
		}
	}

	return models
}

/** One studio model by callable name, or null. */
export async function getStudioModel(callName: string): Promise<StudioModel | null> {
	if (!callName || callName.includes("|") || callName.includes("/")) return null
	const value = await store().get(callName)
	return value ? toModel(callName, value) : null
}

/** Fields the dashboard can set on a studio model; everything is optional but the name. */
export interface StudioModelInput {
	callName: string
	displayName?: string
	ownedBy?: string
	targetModel?: string
	targetLabel?: string
	contextWindow?: number
	systemPrompt?: string
	inputMultiplier?: number
	outputMultiplier?: number
	antiProbe?: boolean
}

export async function setStudioModel({
	callName,
	displayName,
	ownedBy,
	targetModel,
	targetLabel,
	contextWindow,
	systemPrompt,
	inputMultiplier,
	outputMultiplier,
	antiProbe,
}: StudioModelInput) {
	const payload = {
		callName,
		displayName: (displayName || "").trim(),
		ownedBy: (ownedBy || "").trim(),
		targetModel: (targetModel || "").trim(),
		targetLabel: (targetLabel || targetModel || "").trim(),
		contextWindow: Number(contextWindow) || 0,
		systemPrompt: systemPrompt || "",
		...(Number(inputMultiplier) > 0 ? { inputMultiplier: Number(inputMultiplier) } : {}),
		...(Number(outputMultiplier) > 0 ? { outputMultiplier: Number(outputMultiplier) } : {}),
		...(typeof antiProbe === "boolean" ? { antiProbe } : {}),
		createdAt: new Date().toISOString(),
	}
	await store().set(callName, payload)
	return toModel(callName, payload)
}

export async function deleteStudioModel(callName: string): Promise<void> {
	await store().remove(callName)
}

/** Legacy `{provider}|{model}` records only. */
export async function getModelOverrides(): Promise<Record<string, Record<string, unknown>>> {
	const rows = await store().all()
	const out: Record<string, Record<string, unknown>> = {}
	for (const [key, value] of Object.entries(rows)) {
		if (key.includes("|")) out[key] = value
	}
	return out
}

export async function getModelOverride(key: string): Promise<Record<string, unknown> | null> {
	if (!key) return null
	return await store().get(key)
}

export async function setModelOverride(key: string, data: Record<string, unknown>): Promise<void> {
	await store().set(key, data)
}

export async function deleteModelOverride(key: string): Promise<void> {
	await store().remove(key)
}
