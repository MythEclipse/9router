/**
 * The model list the dashboard renders.
 *
 * `GET /api/models` was 250 lines of merging four sources — the build-time
 * registry, the live free catalogue, custom models, studio models, then combos —
 * and each source had its own shadow rules. Those rules are the interesting
 * part, and they belong somewhere a test can reach them:
 *
 *  - **Shadows are dropped, not overwritten.** A custom row whose provider
 *    alias already routes to a listed model carries thinner caps (older rows
 *    stored only `{vision, reasoning}`) and lands later in the array. The client
 *    merges client-side with last-write-wins, so keeping the shadow would serve
 *    the thinner caps for the real model.
 *  - **Capabilities are resolved by provider *id*, not the UI alias.** The
 *    capability tables are keyed by id, and `ocg` misses the provider-scoped
 *    entries that `opencode-gateway` hits.
 *  - **A plugin mark needs the whole name set.** A studio model is callable by
 *    its own name *and* by the model it targets, and a plugin configured for
 *    either must mark it; checking only one is why studio rows showed no badge.
 *  - **A combo aggregates its members**, through the same aggregator the public
 *    model list uses, so a combo never reports two different windows in two
 *    places.
 *
 * Plugin marks are modelled as data (`PLUGIN_SOURCES`) because the list had one
 * entry hard-wired into the merge loop; adding the next plugin should be a row
 * in a table, not an edit in five branches.
 */
import type {
	Capabilities,
	ComboReaderPort,
	CustomModelPort,
	ModelAliasPort,
	ModelCataloguePort,
	StudioModelPort,
} from "./ports.ts"

/** One plugin's contribution: when it applies, and what it adds to a row. */
interface PluginSource {
	readonly key: string
	readonly enabled: boolean
	readonly models: ReadonlySet<string>
	readonly effect: Partial<Capabilities> & Record<string, unknown>
}

/** A row as the dashboard consumes it. */
export interface ModelRow {
	provider: string
	model: string
	name: string
	fullModel: string
	routedModel: string
	alias: string
	caps: Capabilities & Record<string, unknown>
	pluginMarks: string[]
	liveSuggested?: boolean
	isStudio?: boolean
	isCombo?: boolean
}

export interface ModelCatalogueDependencies {
	readonly catalogue: ModelCataloguePort
	readonly aliases: ModelAliasPort
	readonly customModels: CustomModelPort
	readonly studios: StudioModelPort
	readonly combos: ComboReaderPort
	readonly disabledModels: { list(): Promise<Record<string, string[]>> }
	readonly plugins: {
		/** The plugin settings, read on every call: a badge is a live setting, not a build input. */
		read(): Promise<{ adaptiveThinking?: { enabled?: boolean; models?: string[] } }>
	}
}

export function makeModelCatalogue(deps: ModelCatalogueDependencies) {
	/**
	 * Turn on every plugin whose model list matches this row and return the keys
	 * that matched. `ids` holds every shape the model may be listed under — the
	 * caller's own name, the full model, the routed model — because a plugin
	 * configured against one spelling must still apply.
	 */
	function applyPluginMarks(
		caps: Record<string, unknown>,
		ids: Array<string | undefined | null>,
		sources: readonly PluginSource[],
	): string[] {
		const marks: string[] = []
		for (const source of sources) {
			if (!source.enabled) continue
			if (!ids.some((id) => id && source.models.has(id))) continue
			marks.push(source.key)
			Object.assign(caps, source.effect)
		}
		return marks
	}

	function capsOf(provider: string, model: string, overrides?: Partial<Capabilities>) {
		const c = deps.catalogue.capabilities(provider, model)
		return {
			vision: overrides?.vision ?? c.vision,
			search: overrides?.search ?? c.search,
			reasoning: overrides?.reasoning ?? c.reasoning,
			contextWindow: overrides?.contextWindow ?? c.contextWindow,
			maxOutput: overrides?.maxOutput ?? c.maxOutput,
		}
	}

	return {
		async list(): Promise<ModelRow[]> {
			const [aliases, disabled, customModels, studioModels, comboRows] = await Promise.all([
				deps.aliases.list(),
				deps.disabledModels.list(),
				deps.customModels.list(),
				deps.studios.list(),
				deps.combos.list(),
			])

			// Read here rather than injected as a value: the row set is served from a
			// dynamic route precisely because plugins change while the process runs.
			const pluginSettings: { adaptiveThinking?: { enabled?: boolean; models?: string[] } } =
				await deps.plugins.read().catch(() => ({}))
			const adaptive = pluginSettings.adaptiveThinking
			const sources: PluginSource[] = [
				{
					key: "adaptiveThinking",
					enabled: Boolean(adaptive?.enabled),
					models: new Set(adaptive?.models ?? []),
					// Adaptive thinking is a reasoning feature, so the row must claim
					// reasoning or the UI never offers it.
					effect: { reasoning: true, adaptiveThinking: true },
				},
			]

			const curated = await deps.catalogue.curated()
			const rows: ModelRow[] = curated
				.filter((entry) => {
					const alias = deps.catalogue.providerIdOf(entry.provider) || entry.provider
					const list = disabled[alias] || disabled[entry.provider] || []
					return !list.includes(entry.model)
				})
				.map((entry) => {
					const providerId = deps.catalogue.providerIdOf(entry.provider) || entry.provider
					const fullModel = `${entry.provider}/${entry.model}`
					const routedModel = `${providerId}/${entry.model}`
					const caps = capsOf(entry.provider, entry.model)
					return {
						provider: entry.provider,
						model: entry.model,
						name: deps.catalogue.displayName(entry.model, entry.name),
						fullModel,
						routedModel,
						alias: aliases[fullModel] || entry.model,
						caps,
						pluginMarks: applyPluginMarks(caps, [fullModel, routedModel, entry.model], sources),
					}
				})

			// Both sets are needed: a custom row may collide with either spelling.
			const seen = new Set(rows.flatMap((row) => [row.fullModel, row.routedModel]))

			for (const live of await deps.catalogue.liveFree()) {
				const fullModel = `${live.alias}/${live.model}`
				if (seen.has(fullModel)) continue
				seen.add(fullModel)
				const caps = capsOf(live.alias, live.model, { contextWindow: live.contextLength })
				rows.push({
					provider: live.alias,
					model: live.model,
					name: live.name || live.model,
					fullModel,
					routedModel: fullModel,
					alias: aliases[fullModel] || live.model,
					caps,
					pluginMarks: applyPluginMarks(caps, [fullModel, live.model], sources),
					liveSuggested: true,
				})
			}

			for (const custom of customModels) {
				const id = typeof custom.id === "string" ? custom.id : ""
				const providerAlias = typeof custom.providerAlias === "string" ? custom.providerAlias : ""
				if (!id || !providerAlias) continue
				const type = String(custom.type ?? custom.kind ?? "llm")
				if (type !== "llm") continue
				const fullModel = `${providerAlias}/${id}`
				if (seen.has(fullModel)) continue
				seen.add(fullModel)
				const stored = (custom.caps ?? {}) as Partial<Capabilities>
				const caps = capsOf(deps.catalogue.providerIdOf(providerAlias), id, stored)
				rows.push({
					provider: providerAlias,
					model: id,
					name: typeof custom.name === "string" && custom.name ? custom.name : id,
					fullModel,
					routedModel: fullModel,
					alias: aliases[fullModel] || id,
					caps,
					pluginMarks: applyPluginMarks(caps, [fullModel, id], sources),
				})
			}

			for (const studio of studioModels) {
				const provider = typeof studio.provider === "string" ? studio.provider : ""
				const model = typeof studio.model === "string" ? studio.model : ""
				const callName = typeof studio.callName === "string" ? studio.callName : ""
				if (!provider || !callName) continue
				const caps = capsOf(provider, model)
				const target = model ? `${provider}/${model}` : undefined
				rows.push({
					provider,
					model: callName,
					name:
						typeof studio.displayName === "string" && studio.displayName ? studio.displayName : callName,
					fullModel: `${provider}/${callName}`,
					routedModel: callName,
					alias: callName,
					caps,
					// A plugin applies when it names the studio name OR the model it calls.
					pluginMarks: applyPluginMarks(caps, [callName, target, model], sources),
					isStudio: true,
				})
			}

			const byName: Record<string, string[]> = {}
			for (const combo of comboRows) {
				if (Array.isArray(combo.models) && combo.models.length) byName[combo.name] = combo.models
			}
			for (const combo of comboRows) {
				const members = Array.isArray(combo.models) ? combo.models : []
				if (members.length === 0) continue
				const aggregated = deps.catalogue.aggregateCombo(
					members,
					byName,
					Number(combo.contextWindow) || 0,
				)
				if (!aggregated) continue
				const caps = { ...aggregated } as ModelRow["caps"]
				// A combo's marks come from its members: the plugin selection was made
				// per model when the combo was configured.
				const marks = new Set<string>()
				for (const member of members) {
					for (const mark of applyPluginMarks(
						caps,
						[member, String(member).split("/").pop()],
						sources,
					)) {
						marks.add(mark)
					}
				}
				rows.push({
					provider: "combo",
					model: combo.name,
					name: combo.name,
					fullModel: combo.name,
					routedModel: combo.name,
					alias: combo.name,
					caps,
					pluginMarks: [...marks],
					isCombo: true,
				})
			}

			return rows
		},
	}
}

export type ModelCatalogue = ReturnType<typeof makeModelCatalogue>
