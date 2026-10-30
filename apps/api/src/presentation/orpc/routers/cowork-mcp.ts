/**
 * Cowork MCP procedures.
 *
 * Two verbs: probe one server for its tools, and list the registry. The sequence and the meaning
 * of each answer live in the application layer and in `domain/cowork-mcp-probe`; what happens
 * here is handing over the host-side pieces that cannot cross the boundary as input — the SSRF
 * decision for the probe, and the process-wide cache for the registry.
 *
 * The probe's local/remote decision is read from `context.headers`, never from the body: a
 * caller that could claim `{ local: true }` in its JSON would reach any address it liked.
 */
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import { type AppContext, authed } from "../base.ts"

type McpHost = NonNullable<AppContext["mcpProbeHost"]>

/** The host, or a refusal. No host means this build has no network wiring. */
const hostOf = (host: McpHost | undefined): McpHost => {
	if (!host) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "MCP probe host is not wired into this client",
		})
	}
	return host
}

export const coworkMcpRouter = {
	/**
	 * The tools one MCP server exposes.
	 *
	 * `body: unknown` and validation in the use-case, so `url required` and `URL not allowed`
	 * stay as the two distinct 400s the URL field shows.
	 */
	probeTools: authed.input(z.object({ body: z.unknown() })).handler(async ({ input, context }) => {
		const host = hostOf(context.mcpProbeHost)
		return context.useCases.coworkMcp.probeTools(input.body, {
			fetchFor: host.fetchForCaller(context.headers),
			allowPrivateUrl: host.isLocal(context.headers),
			assertPublicUrl: host.assertPublicUrl,
		})
	}),

	/**
	 * The registry list.
	 *
	 * No caller check here: the URL is fixed, so there is no operator-supplied address to guard.
	 * What the host supplies is the cache — process-wide, because several screens ask — and a
	 * fetch, which a test can replace.
	 */
	readRegistry: authed
		.input(z.object({ refresh: z.boolean().optional() }))
		.handler(async ({ input, context }) => {
			const host = hostOf(context.mcpProbeHost)
			return context.useCases.coworkMcp.readRegistry(
				{ cache: host.registryCache(), fetchServers: host.fetchServers ?? fetch },
				input.refresh === true,
			)
		}),
}
