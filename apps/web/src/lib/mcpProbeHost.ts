import type { McpProbeHost } from "9router-api/presentation/orpc/base"
import { isLocalHeaders } from "@/dashboardGuard"
import { assertPublicUrl, fetchPublic } from "@/shared/utils/ssrfGuard"

/**
 * The MCP probe's network, chosen per request.
 *
 * A local caller keeps an unrestricted `fetch`, because its self-hosted MCP server legitimately
 * lives on loopback and the SSRF guard would refuse it — making the screen useless for exactly
 * the operator who runs Cowork on the same machine.
 *
 * A remote caller goes through `fetchPublic` *and* `assertPublicUrl`. Both are kept: the guard
 * refuses at validation time with the "URL not allowed" message the field shows, and
 * `fetchPublic` re-checks the address it actually connected to, which is what catches a DNS
 * name that resolves to loopback.
 *
 * `isLocalHeaders` is the same rule the dashboard guard uses, so a caller cannot be "local" for
 * the guard and "remote" for the fetch that follows it.
 */
export const mcpProbeHost: McpProbeHost = {
	fetchForCaller: (headers) => (isLocalHeaders(headers) ? globalThis.fetch : fetchPublic),
	isLocal: (headers) => isLocalHeaders(headers),
	assertPublicUrl: (url) => assertPublicUrl(url),
}
