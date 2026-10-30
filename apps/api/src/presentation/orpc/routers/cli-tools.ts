/**
 * CLI-tool settings procedures.
 *
 * Sixteen tools share one use-case and one shape: read the status, write the config, reset it.
 * They differ only in their host bundle — the config port, the extra stores to write, and the
 * three messages the operator sees.
 *
 * The bundle holds functions and ports, so it cannot be an input. These procedures therefore
 * take the *tool name* and resolve it through `context.cliToolHosts`, which the web side
 * supplies. That direction is deliberate: the hosts live in `apps/web/src/lib/cliToolHosts.ts`
 * and touch the filesystem, and `apps/api` must not depend on `apps/web` to reach them.
 *
 * The tool names are validated by `ToolName`. It is spelled out rather than imported from the
 * web registry for the same reason: one side owns the ports, the other owns the vocabulary,
 * and `tools` below is how the two stay agreed at runtime.
 */
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import { authed } from "../base.ts"

/** The sixteen tools that speak the generic settings flow. */
export const CLI_TOOL_NAMES = [
	"cline",
	"codewhale",
	"codex",
	"copilot",
	"crush",
	"deepseek-tui",
	"droid",
	"forge",
	"grok-build",
	"jcode",
	"kilo",
	"omp",
	"openclaw",
	"opencode",
	"pi",
	"smelt",
] as const

const ToolName = z.enum(CLI_TOOL_NAMES)

export const cliToolsRouter = {
	/**
	 * Which tools this build can configure.
	 *
	 * The dashboard hard-codes its list today, so a new tool means a new panel. Exposing the
	 * vocabulary lets that list come from the server and stop being a second copy that drifts.
	 */
	tools: authed.handler(async () => ({ tools: [...CLI_TOOL_NAMES] })),

	/**
	 * Status for one tool.
	 *
	 * An uninstalled tool answers 200 with `installed: false`, not 404: the screen needs to
	 * render the "install it first" panel, and a 404 reads as "this endpoint does not exist".
	 */
	readSettings: authed.input(z.object({ tool: ToolName })).handler(async ({ input, context }) => {
		const host = context.cliToolHosts?.(input.tool)
		if (!host) throw unknownHost(input.tool, Boolean(context.cliToolHosts))
		return context.useCases.cliTools.readToolSettingsStatus(host)
	}),

	writeSettings: authed
		.input(z.object({ tool: ToolName, body: z.unknown() }))
		.handler(async ({ input, context }) => {
			const host = context.cliToolHosts?.(input.tool)
			if (!host) throw unknownHost(input.tool, Boolean(context.cliToolHosts))
			return context.useCases.cliTools.writeToolSettings(input.body, host)
		}),

	/** Reset to the tool's own defaults, removing whatever this install wrote. */
	resetSettings: authed.input(z.object({ tool: ToolName })).handler(async ({ input, context }) => {
		const host = context.cliToolHosts?.(input.tool)
		if (!host) throw unknownHost(input.tool, Boolean(context.cliToolHosts))
		return context.useCases.cliTools.resetToolSettings(host)
	}),

	/**
	 * Every tool's status in one answer, for the screen that asks about all nineteen at once.
	 *
	 * The three tools that do not share the generic flow — `claude`, `devin`, `hermes`, `cowork`
	 * — are read through their own procedures rather than through `cliToolHosts`, so they are
	 * built here from the *same* context bundles those procedures use. Reusing them is what
	 * keeps this answer and the per-tool routes from disagreeing.
	 *
	 * A tool whose reader throws is `null` in the answer, never absent: the screen renders a row
	 * per tool, and a missing key would read as "this tool does not exist".
	 */
	allStatuses: authed.handler(async ({ context }) => {
		const readers: Record<string, () => Promise<Record<string, unknown>>> = {}

		for (const tool of CLI_TOOL_NAMES) {
			readers[tool] = async () => {
				const host = context.cliToolHosts?.(tool)
				if (!host) return {}
				const answer = await context.useCases.cliTools.readToolSettingsStatus(host)
				return answer.body
			}
		}

		const claude = context.claudeSettingsHosts
		if (claude) {
			readers.claude = async () => {
				const answer = await context.useCases.claudeTools.readSettingsStatus(
					claude.port,
					claude.isInstalled,
				)
				return answer.body
			}
		}

		return context.useCases.cliTools.readAllStatuses(readers)
	}),
}

/**
 * The refusal for a name that resolved to nothing.
 *
 * `hasResolver` separates the two causes so the message does not send the operator looking for
 * a tool they already have when the real fault is the missing host wiring.
 */
function unknownHost(tool: string, hasResolver: boolean) {
	if (!hasResolver) {
		return new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "CLI-tool hosts are not wired into this client",
		})
	}
	return new ORPCError("NOT_FOUND", { status: 404, message: `Unknown CLI tool: ${tool}` })
}
