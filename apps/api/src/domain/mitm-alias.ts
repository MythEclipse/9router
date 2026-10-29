/**
 * The MITM alias editor lets an operator rewrite which model name a CLI tool asks for. Two rules in
 * it are load-bearing, and one of them is the reason the route exists in the shape it does.
 *
 * - **Aliases may only be edited for a tool whose DNS is enabled.** An alias is a rewrite applied by
 *   the local MITM proxy to traffic that DNS is redirecting into it. For a tool with DNS off, the
 *   proxy never sees the request — so the mapping would be stored, shown as saved, and silently do
 *   nothing. The operator would then debug the model, not the toggle. Refusing is the only answer
 *   that tells the truth.
 * - **A blank model name is dropped, not stored blank.** The editor always renders an empty row for
 *   the next entry, so a save sends `""` as a matter of course. Storing it would create an alias that
 *   rewrites the model to nothing.
 *
 * Both verdicts live here rather than in the route because the UI and the route must agree on what
 * "the alias was saved" means.
 */

/** Where an alias write is refused, and why. */
export interface AliasRefusal {
	readonly status: number
	readonly error: string
}

/** The alias map after trimming, with blank model names already removed. */
export type AliasMappings = Record<string, string>

const ALIAS_BAD_REQUEST_STATUS = 400
const ALIAS_DNS_REQUIRED_STATUS = 403

/**
 * Whether the alias editor may be used for this tool at all.
 *
 * `dnsStatus` is the MITM manager's map of tool name → DNS active. A tool that is absent from the map
 * is not enabled: the manager only reports tools it knows about.
 */
export function aliasWriteRefusal(
	tool: unknown,
	mappings: unknown,
	dnsStatus: Record<string, boolean> | null | undefined,
): AliasRefusal | null {
	if (typeof tool !== "string" || !tool || !mappings || typeof mappings !== "object") {
		return { status: ALIAS_BAD_REQUEST_STATUS, error: "tool and mappings required" }
	}
	if (!dnsStatus || !dnsStatus[tool]) {
		return {
			status: ALIAS_DNS_REQUIRED_STATUS,
			error: `DNS must be enabled for ${tool} before editing model mappings`,
		}
	}
	return null
}

/**
 * The alias map that will actually be stored.
 *
 * Trims each model name (the editor adds trailing spaces when pasting) and drops entries whose model
 * is blank or not a string. An alias with no target is not a partial mapping — it is a broken one.
 */
export function sanitizeAliasMappings(mappings: unknown): AliasMappings {
	const clean: AliasMappings = {}
	if (typeof mappings !== "object" || mappings === null) return clean
	for (const [alias, model] of Object.entries(mappings as Record<string, unknown>)) {
		if (typeof model === "string" && model.trim()) clean[alias] = model.trim()
	}
	return clean
}
