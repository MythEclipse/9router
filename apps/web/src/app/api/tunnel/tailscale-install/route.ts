import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export const runtime = "nodejs"

/**
 * POST /api/tunnel/tailscale-install — install Tailscale, streaming progress.
 *
 * The stream is the transport, so it stays here: a use-case cannot own a `ReadableStream`
 * without owning a framework. What the use-case decides is upstream of the stream —
 * whether the request has a password to install with — so a refusal is a 400 the form can
 * show, not an event nobody styled.
 */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

	const tunnel = getUseCases().tunnel.tailscaleInstall
	let prepared: { password: string; shortId: string }
	try {
		prepared = await tunnel.prepare(body)
	} catch (error) {
		return failed(error, "Sudo password is required", "Tailscale install refused")
	}

	const encoder = new TextEncoder()
	const stream = new ReadableStream({
		async start(controller) {
			let closed = false
			const send = (event: string, data: unknown) => {
				if (closed) return
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
				} catch {
					// The client closed the tab; there is nobody left to report to.
					closed = true
				}
			}

			const terminal = await tunnel.run(prepared, (message) => send("progress", { message }))
			send(terminal.event, terminal.data)

			if (!closed) {
				try {
					controller.close()
				} catch {
					/* already closed by the client */
				}
			}
		},
	})

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	})
}
