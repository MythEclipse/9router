/**
 * Combo use-cases.
 *
 * Each function takes its dependencies and returns an operation. No database
 * handle and no framework object is imported here; the routes and the oRPC
 * procedures both delegate to these, so the rules cannot drift between the two
 * transports.
 */
import {
	buildComboIndex,
	buildStudioTargetMap,
	type CycleGraph,
	describeComboCycle,
	findComboCycle,
	isValidComboName,
	nextCopyName,
	normalizeMembers,
	readContextWindow,
	studioReachesCombo,
} from "../../domain/combo.ts"
import { invalid, notFound } from "../../domain/errors.ts"
import type {
	ComboInput,
	ComboPort,
	ComboPresetPort,
	ComboRotationPort,
	ComboStrategyPort,
	StudioTargetPort,
} from "../dependencies.ts"

export interface ComboDeps {
	readonly combos: ComboPort
	readonly studios: StudioTargetPort
	readonly rotation: ComboRotationPort
	readonly presets: ComboPresetPort
	readonly strategies: ComboStrategyPort
}

/** The draft plus the stored combos and studios forms the graph the guard walks. */
async function draftGraph(
	deps: ComboDeps,
	draft: { name: string; members: readonly string[] },
	previousName?: string,
): Promise<CycleGraph> {
	const [combos, studios] = await Promise.all([
		deps.combos.list().catch(() => []),
		deps.studios.list().catch(() => []),
	])
	const index = buildComboIndex(combos)
	if (previousName && previousName !== draft.name) index.delete(previousName)
	index.set(draft.name, [...draft.members])
	return { combos: index, studioTargets: buildStudioTargetMap(studios) }
}

/** Refuse a member that would close a combo -> studio -> combo loop. */
async function assertNoCycle(
	deps: ComboDeps,
	draft: { name: string; members: readonly string[] },
	previousName?: string,
): Promise<void> {
	if (draft.members.length === 0) return
	const graph = await draftGraph(deps, draft, previousName)
	const chain = findComboCycle({ comboName: draft.name, members: draft.members, graph })
	if (chain) throw invalid(describeComboCycle(chain))
}

export function makeListCombos(deps: ComboDeps) {
	return async () => ({ combos: await deps.combos.list() })
}

export interface CreateComboInput {
	readonly name: unknown
	readonly models?: unknown
	readonly kind?: unknown
	readonly contextWindow?: unknown
}

export function makeCreateCombo(deps: ComboDeps) {
	return async (input: CreateComboInput) => {
		if (!input.name) throw invalid("Name is required")
		if (!isValidComboName(input.name)) {
			throw invalid("Name can only contain letters, numbers, -, _ and .")
		}
		if (await deps.combos.findByName(input.name)) {
			throw invalid("Combo name already exists")
		}

		const members = normalizeMembers(input.models)
		await assertNoCycle(deps, { name: input.name, members })

		return deps.combos.create({
			name: input.name,
			models: members,
			kind: typeof input.kind === "string" ? input.kind : null,
			contextWindow: readContextWindow(input.contextWindow),
		})
	}
}

export function makeGetCombo(deps: ComboDeps) {
	return async (id: string) => {
		const combo = await deps.combos.findById(id)
		if (!combo) throw notFound("Combo")
		return combo
	}
}

export interface UpdateComboInput {
	readonly name?: unknown
	readonly models?: unknown
	readonly contextWindow?: unknown
	readonly [key: string]: unknown
}

export function makeUpdateCombo(deps: ComboDeps) {
	return async (id: string, input: UpdateComboInput) => {
		if (input.name !== undefined) {
			if (!isValidComboName(input.name)) {
				throw invalid("Name can only contain letters, numbers, -, _ and .")
			}
			const clash = await deps.combos.findByName(input.name)
			if (clash && clash.id !== id) throw invalid("Combo name already exists")
		}

		const previous = await deps.combos.findById(id)
		const nextName =
			typeof input.name === "string" && input.name ? input.name : (previous?.name ?? "")
		const nextMembers = Array.isArray(input.models) ? normalizeMembers(input.models) : null

		if (nextName && nextMembers) {
			await assertNoCycle(deps, { name: nextName, members: nextMembers }, previous?.name)
		}

		// Built from named fields rather than spreading the raw body: the port
		// declares what it accepts, and spreading unvalidated values into it would
		// let anything the caller sent reach storage.
		const changes: Partial<ComboInput> = {
			...(typeof input.name === "string" ? { name: input.name } : {}),
			...(input.models !== undefined ? { models: normalizeMembers(input.models) } : {}),
			...(input.kind !== undefined ? { kind: input.kind as string | null } : {}),
			...(input.contextWindow !== undefined
				? { contextWindow: readContextWindow(input.contextWindow) }
				: {}),
		}

		const updated = await deps.combos.update(id, changes)
		if (!updated) throw notFound("Combo")

		// Rotation state is keyed by name, so a rename or a member edit would
		// otherwise resume mid-cycle against a strategy that no longer applies.
		if (previous?.name) deps.rotation.reset(previous.name)
		if (updated.name && updated.name !== previous?.name) deps.rotation.reset(updated.name)

		return updated
	}
}

export function makeDeleteCombo(deps: ComboDeps) {
	return async (id: string) => {
		const previous = await deps.combos.findById(id)
		const deleted = await deps.combos.remove(id)
		if (!deleted) throw notFound("Combo")
		if (previous?.name) deps.rotation.reset(previous.name)
		return { success: true }
	}
}

/**
 * Does a studio resolve back to this combo? Exposed because the model editor
 * asks the same question when saving a studio, and both callers must agree.
 */
export function makeCheckComboCycle(deps: ComboDeps) {
	return async ({ studioName, comboName }: { studioName: string; comboName: string }) => {
		const graph = await draftGraph(deps, { name: comboName, members: [] })
		return { chain: studioReachesCombo({ studioName, comboName, graph }) }
	}
}

async function existingComboNames(deps: ComboDeps): Promise<string[]> {
	const combos = await deps.combos.list()
	return combos.map((combo) => combo.name)
}

/** Reject a source the host does not recognise before asking it for items. */
function assertPresetSource(presets: ComboPresetPort, source: unknown): string {
	if (!presets.isSource(source)) throw invalid("source must be 'cursor' or 'claude'")
	return source as string
}

export function makePreviewComboPresets(deps: ComboDeps) {
	return async (source: unknown) => {
		const name = assertPresetSource(deps.presets, source)
		const items = await deps.presets.list(name, await existingComboNames(deps))
		return {
			source: name,
			items,
			toCreate: items.filter((item) => !item.exists).length,
			toSkip: items.filter((item) => item.exists).length,
		}
	}
}

export function makeCreateComboPresets(deps: ComboDeps) {
	return async (source: unknown) => {
		const name = assertPresetSource(deps.presets, source)
		const items = await deps.presets.list(name, await existingComboNames(deps))
		const created: Awaited<ReturnType<ComboPort["create"]>>[] = []
		const skipped: string[] = []

		for (const item of items) {
			if (item.exists) {
				skipped.push(item.name)
				continue
			}
			// Each preset goes through the same create path as a manual combo, so a
			// preset can never introduce a name or a cycle the API would reject.
			created.push(await makeCreateCombo(deps)({ name: item.name, models: item.models }))
		}

		return {
			source: name,
			created,
			skipped,
			createdCount: created.length,
			skippedCount: skipped.length,
		}
	}
}

/**
 * Copy a combo's contents into a new combo named `<name>-N` for the first free
 * N, the way copying a file leaves the original and puts a copy beside it.
 */
export function makeDuplicateCombo(deps: ComboDeps) {
	return async (id: string) => {
		const source = await deps.combos.findById(id)
		if (!source) throw notFound("Combo")

		const taken = (await deps.combos.list()).map((combo) => combo.name)
		const name = nextCopyName(source.name, taken)

		const copy = await makeCreateCombo(deps)({
			name,
			models: source.models,
			kind: source.kind,
			contextWindow: source.contextWindow,
		})

		// The routing strategy is keyed by combo name; without this the copy would
		// silently run on the defaults instead of the source's strategy.
		const strategy = await deps.strategies.read(source.name)
		if (strategy) await deps.strategies.write(name, strategy)

		return copy
	}
}
