/**
 * The provider list the usage filter offers.
 *
 * Three sources can name a provider, and they do not agree:
 *
 * - a **node** the operator created in the dashboard (`{id, name, logo}`),
 * - a **catalog** entry keyed by alias or id (`{name}`),
 * - and the provider id itself, which is always a usable label.
 *
 * The one that matters is the order. A node is the operator's own naming, so it outranks the
 * catalog: a node called "Team OpenAI" must not be relabelled "OpenAI" because the catalog knows
 * that provider. And a provider with *no* catalog entry still needs a row — dropping it hides
 * traffic the operator is paying for, so the id stands in as the label.
 *
 * The row carries the label twice (`name`/`nodeName`) and the logo twice (`logo`/`nodeLogo`)
 * because the Usage filter and the request-details filter each read a different one of the pair;
 * a row holding only one renders a blank avatar in the other view.
 */

/** What a node record can tell us about a provider the operator named. */
export interface ProviderNodeLabel {
	readonly name?: unknown
	readonly logo?: unknown
}

/** What the static catalog can tell us. */
export interface ProviderCatalogEntry {
	readonly name?: unknown
}

/** One row of the filter's provider list. */
export interface ProviderOption {
	readonly id: string
	readonly name: string
	readonly provider: string
	readonly nodeName: string
	readonly nodeLogo: string | null
	readonly logo: string | null
}

/**
 * The label a provider shows in the filter.
 *
 * Node first, catalog second, the id last. A blank string from any source counts as absent — a
 * node saved with an empty name is not a name, and a blank row is worse than the id.
 */
export function providerLabel(
	id: string,
	nodes: Readonly<Record<string, ProviderNodeLabel>> | null | undefined,
	catalogOf: (id: string) => ProviderCatalogEntry | null | undefined,
): { readonly name: string; readonly logo: string | null } {
	const node = nodes?.[id]
	const nodeName = String(node?.name ?? "").trim()
	const nodeLogo = String(node?.logo ?? "").trim()
	if (nodeName) return { name: nodeName, logo: nodeLogo || null }

	const catalogName = String(catalogOf(id)?.name ?? "").trim()
	if (catalogName) return { name: catalogName, logo: null }

	return { name: id, logo: null }
}

/**
 * Provider rows for the filter, in first-seen order.
 *
 * Duplicates collapse because the labels may be filed under both an alias and an id: request
 * rows store whichever spelling the gateway used, so one provider can arrive twice and the
 * dropdown would list it twice under two different names.
 */
export function providerOptions(
	ids: readonly unknown[],
	nodes: Readonly<Record<string, ProviderNodeLabel>> | null | undefined,
	catalogOf: (id: string) => ProviderCatalogEntry | null | undefined,
): ProviderOption[] {
	const seen = new Set<string>()
	const options: ProviderOption[] = []
	for (const raw of ids) {
		const id = typeof raw === "string" ? raw.trim() : ""
		if (!id || seen.has(id)) continue
		seen.add(id)
		const { name, logo } = providerLabel(id, nodes, catalogOf)
		options.push({ id, name, provider: id, nodeName: name, nodeLogo: logo, logo })
	}
	return options
}
