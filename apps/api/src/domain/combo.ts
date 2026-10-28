/**
 * Combo domain rules.
 *
 * A combo is a named list of model ids the gateway rotates between, and a studio
 * model may target a combo. That gives two ways to close a loop — combo ->
 * studio -> combo, and studio -> combo -> studio — so both are answered here
 * next to the name and context-window rules the routes also need.
 *
 * Everything in this module is pure: no database, no framework, no clock.
 */

/** A combo name may not carry a `/` — that reads as a provider prefix. */
const VALID_NAME = /^[a-zA-Z0-9_.-]+$/

/**
 * Upper bound on a combo's self-declared context window. The gateway budgets
 * requests against this number, so an absurd value would let a combo claim more
 * context than any member can serve.
 */
const MAX_CUSTOM_CONTEXT = 100_000_000

/** Trimmed, non-empty member ids. Anything the caller sent is coerced to text. */
export function normalizeMembers(models: unknown): string[] {
	if (!Array.isArray(models)) return []
	return models.map((m) => String(m ?? "").trim()).filter(Boolean)
}

/**
 * A declared context window, clamped. `0` means "auto — use the largest
 * member", which is what a missing, negative, or non-numeric value collapses to.
 */
export function readContextWindow(value: unknown): number {
	const n = Math.floor(Number(value))
	if (!Number.isFinite(n) || n <= 0) return 0
	return Math.min(n, MAX_CUSTOM_CONTEXT)
}

export function isValidComboName(name: unknown): name is string {
	return typeof name === "string" && VALID_NAME.test(name)
}

/** Index combos by name for the cycle walk. */
export function buildComboIndex(combos: readonly { name?: unknown; models?: unknown }[]) {
	const byName = new Map<string, string[]>()
	for (const combo of combos ?? []) {
		if (!combo || typeof combo.name !== "string") continue
		byName.set(combo.name, normalizeMembers(combo.models))
	}
	return byName
}

/** Index studio call names to the model each one targets. */
export function buildStudioTargetMap(
	studios: readonly { callName?: unknown; targetModel?: unknown }[],
) {
	const map = new Map<string, string>()
	for (const studio of studios ?? []) {
		const key = String(studio?.callName ?? "").trim()
		if (!key) continue
		map.set(key, String(studio?.targetModel ?? "").trim())
	}
	return map
}

export interface CycleGraph {
	readonly combos: Map<string, string[]>
	readonly studioTargets: Map<string, string>
}

/** A provider-prefixed id names a leaf — it can be neither a studio nor a combo. */
function isLeaf(node: string): boolean {
	return !node || node.includes("/")
}

/** One step out: a studio has a single target, a combo has members. */
function nextNodes(node: string, graph: CycleGraph): readonly string[] | undefined {
	const target = graph.studioTargets.get(node)
	if (target !== undefined) return [target]
	return graph.combos.get(node)
}

/**
 * Walk out from `from` and return the first chain reaching `goal`, or null.
 *
 * The guard is the current path, not a shared visited set: a node that would
 * close a loop ends that branch, while a node reachable by another route must
 * still be explored.
 */
export function findChainTo(goal: string, from: string, graph: CycleGraph): string[] | null {
	if (isLeaf(from)) return null

	const walk = (node: string, path: string[]): string[] | null => {
		for (const next of nextNodes(node, graph) ?? []) {
			const chain = [...path, node, next]
			if (next === goal) return chain
			if (isLeaf(next) || path.includes(next)) continue
			const hit = walk(next, [...path, node])
			if (hit) return hit
		}
		return null
	}

	return walk(from, [])
}

/**
 * Does saving a draft where `comboName` lists `members` close a loop back into
 * that combo? Returns the offending chain, or null when the draft is acyclic.
 *
 * `members` is passed in rather than read from `graph` because the draft is what
 * the caller is trying to save — it is not in the index yet.
 */
export function findComboCycle({
	comboName,
	members,
	graph,
}: {
	comboName: string
	members: readonly string[]
	graph: CycleGraph
}): string[] | null {
	const wanted = String(comboName ?? "").trim()
	if (!wanted) return null

	for (const member of members) {
		if (isLeaf(member)) continue
		const chain = findChainTo(wanted, member, graph)
		if (chain) return chain
	}
	return null
}

/**
 * Does studio `studioName` resolve, through chained studios and nested combos,
 * to `comboName`? Returns the chain or null.
 */
export function studioReachesCombo({
	studioName,
	comboName,
	graph,
}: {
	studioName: string
	comboName: string
	graph: CycleGraph
}): string[] | null {
	const start = String(studioName ?? "").trim()
	const wanted = String(comboName ?? "").trim()
	if (!start || !wanted) return null
	if (start === wanted) return [start]
	return findChainTo(wanted, start, graph)
}

export function describeComboCycle(chain: readonly string[] | null): string {
	if (!chain || chain.length === 0) return ""
	return `That model routes back into this combo (${chain.join(" -> ")}). Pick a different member.`
}

/**
 * Name for a copy of a combo: the source name plus the first free `-N` suffix,
 * the way a file manager copies a file next to the original.
 *
 * The suffix is always derived from the original name (`foo` -> `foo-1`,
 * `foo-2`) and is never stripped from the source, so a name that legitimately
 * ends in digits (`claude-sonnet-4-5`) is not mistaken for an existing copy.
 */
export function nextCopyName(name: string, taken: Iterable<string>): string {
	const used = new Set(taken)
	for (let n = 1; ; n += 1) {
		const candidate = `${name}-${n}`
		if (!used.has(candidate)) return candidate
	}
}
