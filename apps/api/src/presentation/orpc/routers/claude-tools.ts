/**
 * Claude Code settings procedures.
 *
 * Claude Code is the one CLI tool that does not go through the generic settings flow: it is
 * configured through an `env` block rather than a provider entry, so it has its own use-case
 * and its own port. It lives in this router because an operator looking for "the settings for
 * my CLI tools" should not have to know which of the two shapes a given tool happens to use.
 *
 * The port and the install probe arrive on `context.claudeSettingsHosts`. They touch
 * `~/.claude/settings.json`, which is host code — `apps/api` must not import it.
 */
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import { authed } from "../base.ts"

type ClaudeHosts = NonNullable<import("../base.ts").AppContext["claudeSettingsHosts"]>

/**
 * The hosts the use-case needs, or a refusal.
 *
 * No hosts means this build has no host access, which is a wiring fault rather than a bad
 * request: retrying cannot fix it, so it is a 500 and says so.
 */
const hostsOf = (hosts: ClaudeHosts | undefined): ClaudeHosts => {
	if (!hosts) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "Claude Code settings hosts are not wired into this client",
		})
	}
	return hosts
}

export const claudeToolsRouter = {
	/**
	 * Current status. An uninstalled Claude Code answers 200 with `installed: false`, because
	 * the screen renders an explanation rather than an error page.
	 */
	readSettings: authed.handler(async ({ context }) => {
		const hosts = hostsOf(context.claudeSettingsHosts)
		return context.useCases.claudeTools.readSettingsStatus(hosts.port, hosts.isInstalled)
	}),

	/**
	 * Write the `env` block.
	 *
	 * `exaMcpEnabled` is lifted out of the body and passed separately because it decides
	 * whether an MCP server entry is written *alongside* the env block — a flag to the
	 * use-case, not part of the settings it writes. `=== true` because the body is untrusted:
	 * the string `"false"` must not enable it.
	 */
	writeSettings: authed
		.input(z.object({ body: z.unknown() }))
		.handler(async ({ input, context }) => {
			const hosts = hostsOf(context.claudeSettingsHosts)
			const { exaMcpEnabled } = (input.body ?? {}) as { exaMcpEnabled?: boolean }
			return context.useCases.claudeTools.writeSettings(input.body, hosts.port, {
				exaMcpEnabled: exaMcpEnabled === true,
			})
		}),

	/** Remove what this install wrote, leaving the operator's own settings alone. */
	resetSettings: authed.handler(async ({ context }) => {
		const hosts = hostsOf(context.claudeSettingsHosts)
		return context.useCases.claudeTools.resetSettings(hosts.port)
	}),
}
