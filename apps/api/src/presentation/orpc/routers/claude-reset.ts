/**
 * The Claude limit-reset procedure.
 *
 * The row, the proxy config, the OAuth refresh and the upstream grant call all come from the host.
 * Every rule about who may spend a grant, and how an upstream answer maps to a status, is in
 * `domain/claude-reset.ts`.
 */
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import { type AppContext, authed } from "../base.ts"

type ClaudeResetPort = NonNullable<AppContext["claudeResetPort"]>

const portOf = (port: ClaudeResetPort | undefined): ClaudeResetPort => {
	if (!port) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "The Claude reset port is not wired into this client",
		})
	}
	return port
}

export const claudeResetRouter = {
	/**
	 * Spend one grant. `grantId` is optional because an account with a single available grant is
	 * the common case and upstream resolves it itself.
	 */
	spend: authed
		.input(z.object({ connectionId: z.string(), grantId: z.unknown().optional() }))
		.handler(async ({ input, context }) =>
			context.useCases.claudeReset.spend(
				input.connectionId,
				input.grantId,
				portOf(context.claudeResetPort),
			),
		),
}
