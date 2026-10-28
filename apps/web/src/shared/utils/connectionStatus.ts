/** A connection's liveness, mapped onto a Badge variant. */
export function getStatusVariant(
	isActive: boolean | undefined,
	effectiveStatus: string | undefined,
): "default" | "success" | "error" {
	if (isActive === false) return "default"
	if (effectiveStatus === "active" || effectiveStatus === "success") return "success"
	if (
		effectiveStatus === "error" ||
		effectiveStatus === "expired" ||
		effectiveStatus === "unavailable"
	)
		return "error"
	return "default"
}

/** The subset of a connection this helper reads. */
export interface ConnectionActivity {
	provider?: string | null
	isActive?: boolean
}

/**
 * Identify providers that have connections configured, but ALL of them are deactivated (isActive === false).
 * Providers with 0 connections (e.g. keyless local nodes) are NOT considered deactivated.
 *
 * @param connections the configured connections
 * @returns deactivated provider IDs
 */
export function getDeactivatedProviderIds(connections?: ConnectionActivity[] | null): Set<string> {
	const byProvider: Record<string, { total: number; active: number }> = {}
	for (const c of connections || []) {
		if (!c?.provider) continue
		const stats = (byProvider[c.provider] ||= { total: 0, active: 0 })
		stats.total += 1
		if (c.isActive !== false) stats.active += 1
	}
	const deactivated = new Set<string>()
	for (const [provider, stats] of Object.entries(byProvider)) {
		if (stats.total > 0 && stats.active === 0) {
			deactivated.add(provider)
		}
	}
	return deactivated
}
