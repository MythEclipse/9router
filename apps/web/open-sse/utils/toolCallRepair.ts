/**
 * Repair `tool_calls` arrays that an upstream serialized from stream deltas.
 *
 * Some [OI]-compatible gateways build a non-streaming completion by dumping
 * their delta sequence into `message.tool_calls` instead of assembling it:
 * entry 0 carries the id and name, and every later entry repeats `index` with
 * only a slice of `arguments` and no id or name. Verified live against
 * ai.mikulab.cloud (gpt-6-luna) — one `get_weather` call arrives as eight
 * entries:
 *
 *   [{id:"call_00_…", function:{name:"f", arguments:""}},
 *    {index:0, function:{arguments:'{"'}},
 *    {index:0, function:{arguments:"a"}},   … ]
 *
 * Forwarded as-is, a Claude client receives one `tool_use` block per fragment,
 * each with `name:""` and `input:{}`, so the turn is unusable; an [OI] client
 * sees eight calls where there was one.
 *
 * Merge rule: an entry with neither `id` nor a function name is a continuation
 * of the call at its `index` (or of the most recent call when it carries no
 * index), so its `arguments` slice is appended. Genuine parallel calls each
 * carry their own id and are left alone. Fail-open: a body this cannot read is
 * returned untouched, because a repair must never be the reason a request dies.
 */

type ToolCall = Record<string, unknown>

function functionOf(call: ToolCall): Record<string, unknown> | null {
	const fn = call?.function
	return fn && typeof fn === "object" ? (fn as Record<string, unknown>) : null
}

function isContinuation(call: ToolCall): boolean {
	if (!call || typeof call !== "object") return false
	if (call.id) return false
	const fn = functionOf(call)
	const name = typeof fn?.name === "string" ? fn.name.trim() : ""
	if (name) return false
	// A bare entry with no arguments and no index carries nothing to merge.
	return fn !== null
}

function appendArguments(target: Record<string, unknown>, extra: unknown): void {
	if (extra === undefined || extra === null) return
	const slice = typeof extra === "string" ? extra : JSON.stringify(extra)
	if (!slice) return
	const current = typeof target.arguments === "string" ? target.arguments : ""
	// An empty argument object is what a gateway writes for "arguments not seen
	// yet"; appending to it would yield `{}{"a":1}`. The fragments are the real
	// payload, so they replace the placeholder.
	const base =
		current.trim() === "" || current.trim() === "{}" || current.trim() === "null" ? "" : current
	target.arguments = `${base}${slice}`
}

function indexOf(call: ToolCall): number | null {
	const raw = call?.index
	return typeof raw === "number" && Number.isFinite(raw) ? raw : null
}

/**
 * Merge delta fragments in place and return how many entries were folded away.
 * Mutates the body it is given — callers own the parsed document.
 */
export function mergeFragmentedToolCalls(body: unknown): number {
	try {
		if (!body || typeof body !== "object") return 0
		const choices = (body as Record<string, unknown>).choices
		if (!Array.isArray(choices)) return 0

		let merged = 0
		for (const choice of choices) {
			if (!choice || typeof choice !== "object") continue
			const message = (choice as Record<string, unknown>).message
			if (!message || typeof message !== "object") continue
			const calls = (message as Record<string, unknown>).tool_calls
			if (!Array.isArray(calls) || calls.length < 2) continue

			const repaired: ToolCall[] = []
			const byIndex = new Map<number, ToolCall>()
			for (const call of calls) {
				if (!call || typeof call !== "object") continue
				const entry = call as ToolCall
				if (!isContinuation(entry)) {
					repaired.push(entry)
					const idx = indexOf(entry)
					if (idx !== null) byIndex.set(idx, entry)
					continue
				}
				const idx = indexOf(entry)
				const target = (idx !== null ? byIndex.get(idx) : undefined) ?? repaired.at(-1)
				const fn = functionOf(entry)
				if (!target || !fn) {
					repaired.push(entry)
					continue
				}
				const targetFn = functionOf(target)
				if (!targetFn) {
					repaired.push(entry)
					continue
				}
				appendArguments(targetFn, fn.arguments)
				if (typeof fn.name === "string" && fn.name.trim() && !targetFn.name) targetFn.name = fn.name
				if (entry.id && !target.id) target.id = entry.id
				if (entry.type && !target.type) target.type = entry.type
				merged += 1
			}

			if (merged > 0) (message as Record<string, unknown>).tool_calls = repaired
		}
		return merged
	} catch {
		return 0
	}
}
