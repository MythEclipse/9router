/**
 * The MCP stdio bridge exposes two endpoints per plugin: an SSE stream the client subscribes to,
 * and a POST endpoint it sends JSON-RPC to. Between them they look like 50 lines of plumbing, and
 * three rules in that plumbing decide whether the bridge works or leaks processes.
 *
 * - **Only a preset plugin may be named.** The `[plugin]` segment of the URL is caller-supplied and
 *   ends up as a key into the bridge registry, which spawns a child process. The preset list is the
 *   entire defence — without it, any name is a spawn request. The lookup lives here rather than in
 *   each route so both endpoints reject the same names.
 * - **The `sessionId` a client echoes back is not trusted, and is not required.** A message is
 *   written to the plugin's *shared* child stdin, and the reply is broadcast to every session
 *   subscribed to that plugin. So a POST with no `sessionId`, a stale one, or another session's one
 *   all do the same thing. Rejecting a missing `sessionId` would break clients that omit it without
 *   preventing anything.
 * - **The last session leaving must kill the child.** Otherwise every dashboard visit that opens the
 *   plugin list leaves a model-server process behind, and the leak is invisible until the box runs
 *   out of memory.
 */

/** Why a plugin name was refused. */
export interface PluginRefusal {
	readonly status: number
	readonly message: string
}

/** What a successful lookup answers with. */
export interface ResolvedPlugin {
	readonly plugin: { readonly name: string }
}

/**
 * The plugin a request named, or a refusal.
 *
 * An unknown name is 404 rather than 400: the name is a path segment identifying a resource, and
 * the honest answer is that this resource does not exist.
 */
export function resolvePlugin(
	name: unknown,
	plugins: ReadonlyArray<{ readonly name: string }>,
): ResolvedPlugin | { readonly refusal: PluginRefusal } {
	const requested = typeof name === "string" ? name : ""
	const found = plugins.find((plugin) => plugin.name === requested)
	if (found === undefined) {
		return { refusal: { status: 404, message: `Unknown plugin: ${requested}` } }
	}
	return { plugin: { name: found.name } }
}

/** Narrowing for the union `resolvePlugin` answers with (works under `strict: false` too). */
export function isPluginRefusal(
	result: ResolvedPlugin | { readonly refusal: PluginRefusal },
): result is { readonly refusal: PluginRefusal } {
	return "refusal" in result
}

/**
 * The SSE handshake frame that tells the client where to POST.
 *
 * The `sessionId` is advertised so a client can correlate streams. Per the module comment the POST
 * side does not require it back.
 */
export function mcpEndpointFrame(plugin: string, sessionId: string): string {
	return `event: endpoint\ndata: /api/mcp/${plugin}/message?sessionId=${sessionId}\n\n`
}

/** The 202 a successfully forwarded message answers with. */
export const MCP_MESSAGE_ACCEPTED_STATUS = 202

/**
 * The status for a message that could not be forwarded.
 *
 * A bridge that is not running is a state, not a crash: the child was never spawned, or it exited
 * between the SSE subscribe and the POST. 502 says "the process that should have received this is
 * gone", which is what the client needs to know in order to resubscribe rather than retry the same
 * body. A 500 would say the dashboard broke, and it did not.
 */
export const MCP_FORWARD_FAILURE_STATUS = 502

/** The headers an SSE bridge stream must carry to stay unbuffered through a proxy. */
export const MCP_SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache, no-transform",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
} as const
