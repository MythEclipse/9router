/**
 * Proxy-pool list filtering and selection arithmetic.
 *
 * Kept out of the page so the tricky parts — which rows a bulk action may touch,
 * and how a Shift+click range is computed — are testable without React.
 */

export type ProxyPoolStatusFilter = "all" | "enabled" | "disabled"

export interface ProxyPoolLike {
	id: string
	isActive?: boolean
}

/** Filter by activation state, preserving the caller's order. */
export function filterProxyPools<T extends ProxyPoolLike>(
	pools: readonly T[],
	status: ProxyPoolStatusFilter | string,
): T[] {
	if (status === "enabled") return pools.filter((pool) => pool.isActive === true)
	if (status === "disabled") return pools.filter((pool) => pool.isActive !== true)
	return [...pools]
}

/**
 * Bulk actions must never include rows hidden by the current filter: a pool that
 * a background test moved out of view is not part of what the operator sees.
 */
export function getVisibleProxyPoolSelection(
	pools: readonly ProxyPoolLike[],
	selectedIds: readonly string[],
): string[] {
	const selected = new Set(selectedIds)
	return pools.filter((pool) => selected.has(pool.id)).map((pool) => pool.id)
}

/**
 * Apply one click to the selection.
 *
 * With Shift the click extends from the anchor to the clicked row in either
 * direction; without it, only that row toggles. `checked` decides whether the
 * affected rows are added or removed, so a Shift+click on a selected range
 * deselects it. A missing or hidden anchor degrades to a single-row toggle.
 */
export function updateProxyPoolSelection(
	pools: readonly ProxyPoolLike[],
	selectedIds: readonly string[],
	{
		id,
		anchorId,
		checked,
		shiftKey,
	}: {
		id: string
		anchorId?: string | null
		checked: boolean
		shiftKey?: boolean
	},
): string[] {
	const ids = pools.map((pool) => pool.id)
	const selected = new Set(getVisibleProxyPoolSelection(pools, selectedIds))
	const index = ids.indexOf(id)
	if (index === -1) return ids.filter((target) => selected.has(target))
	const anchor = shiftKey && anchorId ? ids.indexOf(anchorId) : -1
	const range =
		anchor === -1 ? [id] : ids.slice(Math.min(anchor, index), Math.max(anchor, index) + 1)
	for (const target of range) {
		if (checked) selected.add(target)
		else selected.delete(target)
	}
	return ids.filter((target) => selected.has(target))
}
