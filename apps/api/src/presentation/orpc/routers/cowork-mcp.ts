/**
 * Cowork MCP procedures.
 *
 * One procedure: probe a server for its tools. The sequence is in the use-case and the meaning
 * of each answer is in `domain/cowork-mcp-probe`; what happens here is handing over the SSRF
 * decision, which needs the request headers and therefore cannot cross the boundary as input.
 *
 * A remote caller is held to a public URL. A local caller is not, because its self-hosted MCP
 * server legitimately lives on loopback — refusing it would make the screen useless for exactly
 * the operator who runs Cowork locally.
 */
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import { authed } from "../base.ts"

export const coworkMcpRouter = {
	/**
	 * The tools one MCP server exposes.
	 *
	 * `body: unknown` and validation in the use-case, so `url required` and `URL not allowed`
	 * stay as the two distinct 400s the URL field shows.
	 *
	 * The proxy decision is made per request from `context.headers`, never from the body: a
	 * caller that could claim "local" in its JSON would reach any address it liked.
	 */
	probeTools: authed.input(z.object({ body: z.unknown() })).handler(async ({ input, context }) => {
		const host = context.mcpProbeHost
		if (!host) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				status: 500,
				message: "MCP probe host is not wired into this client",
			})
		}
		return context.useCases.coworkMcp.probeTools(input.body, {
			fetchFor: host.fetchForCaller(context.headers),
			allowPrivateUrl: host.isLocal(context.headers),
			assertPublicUrl: host.assertPublicUrl,
		})
	}),
}
