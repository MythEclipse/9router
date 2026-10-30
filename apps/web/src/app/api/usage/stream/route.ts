import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { isReportingPeriod } from "9router-api/domain/reporting-period"
import { NextResponse } from "next/server"
import { getActiveRequests, getUsageStats, statsEmitter } from "@/lib/usageDb"

export const dynamic = "force-dynamic"

/**
 * GET /api/usage/stream?period= - server-sent usage, the second source the Usage page merges in.
 *
 * `?period=` is refused by the same rule the other usage panels use. This route was the one that
 * skipped it, and an unrefused period here did not fail loudly: `periodCutoff` in the db layer maps
 * an unknown period to `null`, which means unbounded — so `?period=abc` streamed the entire history
 * under a label the caller chose. `usage/leaderboard` fixed exactly this and left a comment about a
 * week of data labelled with what the caller asked for; the SSE route was not covered by it.
 */
export async function GET(request) {
	const encoder = new TextEncoder()
	const { searchParams } = new URL(request.url)
	const requested = searchParams.get("period") ?? "today"
	if (!isReportingPeriod(requested)) {
		return NextResponse.json({ error: `Unknown period: ${requested}` }, { status: 400 })
	}
	const period = requested

	const ctx = await getSessionContext()
	// Narrowed locally: the session payload fields are typed `unknown`, but the
	// filter is a key string or null and the model scope is always a string.
	const apiKeyFilter = typeof ctx.apiKeyFilter === "string" ? ctx.apiKeyFilter : null
	const allowedModels = typeof ctx.allowedModels === "string" ? ctx.allowedModels : "*"

	const state = { closed: false, keepalive: null, send: null, sendPending: null, cachedStats: null }

	const stream = new ReadableStream({
		async start(controller) {
			state.send = async () => {
				if (state.closed) return
				try {
					if (state.cachedStats) {
						const { activeRequests, recentRequests, errorProvider } = await getActiveRequests(
							apiKeyFilter,
							allowedModels,
						)
						const quickStats = {
							...state.cachedStats,
							activeRequests,
							recentRequests,
							errorProvider,
							_type: "pending",
						}
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(quickStats)}\n\n`))
					}
					// allowedModels is not optional here: this stream is the second source the
					// Usage page merges in, and omitting it silently widens the scope to every
					// model, which is what let unrelated providers show up under an API-key login.
					const stats = await getUsageStats(period, apiKeyFilter, allowedModels)
					state.cachedStats = stats
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...stats, _type: "full" })}\n\n`))
				} catch {
					state.closed = true
					statsEmitter.off("update", state.send)
					statsEmitter.off("pending", state.sendPending)
					clearInterval(state.keepalive)
				}
			}

			state.sendPending = async () => {
				if (state.closed || !state.cachedStats) return
				try {
					const { activeRequests, recentRequests, errorProvider } = await getActiveRequests(
						apiKeyFilter,
						allowedModels,
					)
					const stats = {
						...state.cachedStats,
						activeRequests,
						recentRequests,
						errorProvider,
						_type: "pending",
					}
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`))
				} catch {
					state.closed = true
					statsEmitter.off("update", state.send)
					statsEmitter.off("pending", state.sendPending)
					clearInterval(state.keepalive)
				}
			}

			await state.send()

			statsEmitter.on("update", state.send)
			statsEmitter.on("pending", state.sendPending)

			state.keepalive = setInterval(() => {
				if (state.closed) {
					clearInterval(state.keepalive)
					return
				}
				try {
					controller.enqueue(encoder.encode(": ping\n\n"))
				} catch {
					state.closed = true
					clearInterval(state.keepalive)
				}
			}, 25000)
		},

		cancel() {
			state.closed = true
			statsEmitter.off("update", state.send)
			statsEmitter.off("pending", state.sendPending)
			clearInterval(state.keepalive)
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
