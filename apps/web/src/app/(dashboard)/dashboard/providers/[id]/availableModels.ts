/**
 * Which models a provider page offers to add.
 *
 * Three lists can hold the same model — the provider's own catalog, what its API
 * returned, and the hardcoded kilo free set — so the page has to merge them without
 * showing a model twice, drop the ones already added, and split free from paid because
 * the UI labels them differently. None of that is rendering, and getting the
 * "already added" check wrong is how a model shows up as addable when it is not.
 */

export interface OfferedModel {
	id: string
	name?: string
	isFree?: boolean
	contextLength?: number | null
}

export interface AvailableModelsInput {
	/** What the provider's API reported, if it answered. */
	suggested: OfferedModel[]
	/** The built-in catalog for this provider. */
	builtIn: OfferedModel[]
	/**
	 * The hardcoded free set; absent for most providers. The caller is responsible for
	 * setting `isFree: true` on these rows — this module does not assume it, because a
	 * row marked free here and paid by the caller would split the list differently than
	 * the rest of the page believes.
	 */
	extraFree?: OfferedModel[]
	/** Every model already attached to the provider, as ids or `alias/id`. */
	addedIdentifiers: Iterable<string>
	/** Prefix a catalog id carries when it is added, e.g. the provider alias. */
	providerAlias: string
}

export interface AvailableModels {
	free: OfferedModel[]
	paid: OfferedModel[]
	/** Free + paid; zero means there is nothing to offer. */
	total: number
}

/**
 * Merge the three sources, keep one row per id, and drop what is already added.
 *
 * Deduplication is by id and keeps the FIRST occurrence, so the API's own row (with its
 * live `isFree` and context length) wins over the built-in catalog's copy. Rows with no
 * id are skipped rather than rendered as an unclickable chip.
 *
 * "Already added" is checked against both the bare id and the `alias/id` form, because
 * a model added through the alias path stores the qualified id while a custom model
 * stores the bare one.
 */
export function availableModels({
	suggested,
	builtIn,
	extraFree = [],
	addedIdentifiers,
	providerAlias,
}: AvailableModelsInput): AvailableModels {
	const added = new Set(addedIdentifiers)

	const seen = new Set<string>()
	const unique: OfferedModel[] = []
	for (const model of [...suggested, ...builtIn, ...extraFree]) {
		if (!model?.id || seen.has(model.id)) continue
		seen.add(model.id)
		unique.push(model)
	}

	const notAdded = unique.filter((m) => !added.has(`${providerAlias}/${m.id}`) && !added.has(m.id))

	const free = notAdded.filter((m) => m.isFree === true)
	const paid = notAdded.filter((m) => m.isFree !== true)
	return { free, paid, total: notAdded.length }
}

/**
 * The id a suggested chip should display.
 *
 * Catalog ids are namespaced (`@cf/vendor/model`), so showing the whole thing wastes
 * the chip; the last segment is the part the operator recognizes. A bare id is
 * returned unchanged.
 */
export function chipLabel(modelId: string): string {
	const parts = (modelId || "").split("/")
	return parts[parts.length - 1] || modelId || ""
}
