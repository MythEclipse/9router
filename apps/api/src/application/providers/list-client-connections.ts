/**
 * The client-facing connection listing, one page at a time.
 *
 * Called from:
 *   - `apps/api/src/application/use-cases.ts` (`makeListClientConnections`,
 *     registered as `listClientConnections`)
 *   - `apps/web/src/app/api/providers/client/route.ts` via
 *     `getUseCases().listClientConnections.run(...)`
 *   - `tests/unit/use-case-list-client-connections.test.ts`
 *
 * No existing file serves this purpose: `manage-connections.ts` lists connections
 * for the dashboard, which shows every field and applies no disclosure rule; the
 * client route's whitelist, eligibility and paging lived inline in its handler.
 *
 * Reads: all provider connections, their nodes (for compatible quota flags), and
 * whatever the injected `backfill` writes back. Writes nothing itself — the
 * backfill port owns its own write, and it runs before the read so the page
 * reflects it.
 *
 * User instruction, verbatim: "lanjut kenapa malah berhenti".
 */

import {
	type AccountStatus,
	type ClientConnection,
	type ConnectionSort,
	isAccountStatus,
	isConnectionSort,
	isUsageEligible,
	matchesAccountStatus,
	paginate,
	type RawConnection,
	resolvePageSize,
	sanitizeConnection,
	sortConnections,
} from "../../domain/client-listing.ts"
import type { ConnectionNodeStore, ConnectionStore } from "./ports.ts"

/** What the catalogue has to answer to judge a connection's usage eligibility. */
export interface ClientListingRegistry {
	readonly isCompatible: (provider: string) => boolean
	readonly supportsUsage: (provider: string) => boolean
	readonly supportsApiKeyUsage: (provider: string) => boolean
	readonly usageOrder: readonly string[]
}

export interface ListClientConnectionsDependencies {
	readonly connections: ConnectionStore
	readonly nodes: ConnectionNodeStore
	readonly registry: ClientListingRegistry
	/**
	 * Repairs OAuth connection emails before the list is read.
	 *
	 * Injecting it as a port rather than calling it in the route keeps the order
	 * honest: it must run *before* the read, or the page shows the stale email it
	 * was meant to fix.
	 */
	readonly backfill: () => Promise<void>
}

export interface ClientListing {
	readonly connections: readonly ClientConnection[]
	readonly providerOptions: readonly string[]
	readonly pagination: {
		readonly page: number
		readonly pageSize: number
		readonly total: number
		readonly totalPages: number
	}
	readonly totals: {
		readonly eligibleConnections: number
		readonly providerFilteredConnections: number
	}
}

export function makeListClientConnections({
	connections,
	nodes,
	registry,
	backfill,
}: ListClientConnectionsDependencies) {
	return {
		/**
		 * List the connections whose usage can be read, filtered and paged.
		 *
		 * Unknown filter values are treated as "no filter" instead of rejected:
		 * this endpoint feeds a panel that may hold a stale provider id after a
		 * connection was deleted, and a 400 there would blank the whole panel
		 * where an unfiltered list still shows the rest.
		 */
		async run(query: {
			readonly provider?: string | null
			readonly accountStatus?: string | null
			readonly sort?: string | null
			readonly page?: string | null
			readonly pageSize?: string | null
		}): Promise<ClientListing> {
			await backfill()

			const provider = query.provider || "all"
			const accountStatus: AccountStatus = isAccountStatus(query.accountStatus ?? "")
				? (query.accountStatus as AccountStatus)
				: "all"
			const sort: ConnectionSort = isConnectionSort(query.sort ?? "")
				? (query.sort as ConnectionSort)
				: "priority"
			const pageSize = resolvePageSize(query.pageSize ?? null)
			const page = Math.max(1, Number.parseInt(String(query.page ?? "1"), 10) || 1)

			const all = (await connections.list()) as readonly RawConnection[]
			const nodeById = new Map((await nodes.list()).map((node) => [String(node.id), node] as const))

			const eligible = all.filter((connection) => isUsageEligible(connection, nodeById, registry))
			const providerOptions = Array.from(
				new Set(eligible.map((connection) => String(connection.provider))),
			).sort()

			const providerFiltered =
				provider === "all"
					? eligible
					: eligible.filter((connection) => connection.provider === provider)
			const accountFiltered = providerFiltered.filter((connection) =>
				matchesAccountStatus(connection, accountStatus),
			)

			const sorted = sortConnections(accountFiltered, sort, registry)
			const sliced = paginate(sorted, page, pageSize)

			return {
				connections: sliced.items.map(sanitizeConnection),
				providerOptions,
				pagination: {
					page: sliced.page,
					pageSize,
					total: sorted.length,
					totalPages: sliced.totalPages,
				},
				totals: {
					eligibleConnections: eligible.length,
					providerFilteredConnections: providerFiltered.length,
				},
			}
		},
	}
}
