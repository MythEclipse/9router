/**
 * Probing every model on a connection.
 *
 * Two decisions live here, both of which the route made inline:
 *
 * 1. **The first model runs alone.** The probe triggers a token refresh, and
 *    firing every model at once races that refresh against itself — the first
 *    few get a token the others are still minting. One warm-up call settles it.
 * 2. **Cookie-based providers probe serially.** Their account queue serves one
 *    request at a time, so a parallel fan-out just makes every probe wait behind
 *    the others until each hits its own timeout.
 *
 * Neither is about the model list, which is why they belong beside the probe
 * rather than in the handler.
 */

/** A model as the catalogue and the live endpoint describe it. */
export interface ProbeTarget {
	readonly id: string
	readonly name?: string
	readonly kind?: string
	readonly type?: string
}

export interface ProbeResult {
	readonly modelId: string
	readonly name: string
	readonly [key: string]: unknown
}

export type Probe = (modelRef: string, kind: string) => Promise<Record<string, unknown>>

/** Models come back in either shape; `kind` wins over `type`, then "llm". */
export function probeKindOf(target: ProbeTarget): string {
	return target.kind || target.type || "llm"
}

/**
 * The reference the probe resolves through the router, `alias/modelId`.
 *
 * Probing the bare model id would bypass the alias the connection is registered
 * under, and the router would route it to a different provider — or none.
 */
export function probeRef(alias: string, target: ProbeTarget): string {
	return `${alias}/${target.id}`
}

/**
 * Probe every target, warm-up first.
 *
 * `serial` is the cookie-provider case described above. An empty list is the
 * caller's problem to reject: this returns what it was given.
 */
export async function probeAll(
	targets: readonly ProbeTarget[],
	options: { readonly alias: string; readonly probe: Probe; readonly serial: boolean },
): Promise<ProbeResult[]> {
	const [first, ...rest] = targets
	if (!first) return []

	const run = async (target: ProbeTarget): Promise<ProbeResult> => ({
		modelId: target.id,
		name: target.name || target.id,
		...(await options.probe(probeRef(options.alias, target), probeKindOf(target))),
	})

	const results = [await run(first)]
	if (rest.length === 0) return results

	if (options.serial) {
		for (const target of rest) results.push(await run(target))
	} else {
		results.push(...(await Promise.all(rest.map(run))))
	}
	return results
}

/**
 * Whether a live model list is worth fetching from the connection.
 *
 * Only a compatible provider has an endpoint to ask, and only when the catalogue
 * knows nothing about it — a provider with a configured list does not need a
 * network call to be probed.
 */
export function needsLiveModels(input: {
	readonly isCompatible: boolean
	readonly knownModels: number
}): boolean {
	return input.isCompatible && input.knownModels === 0
}

/** The live list, reduced to the probe's target shape. */
export function targetsFromLiveModels(models: readonly Record<string, unknown>[]): ProbeTarget[] {
	return models
		.map((model) => {
			const id = model.id ?? model.name
			if (typeof id !== "string" || !id) return null
			const name = typeof model.name === "string" && model.name ? model.name : id
			return { id, name } as ProbeTarget
		})
		.filter((target): target is ProbeTarget => target !== null)
}
