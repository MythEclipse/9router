import { NextResponse } from "next/server"
import { testProxyUrl } from "@/lib/network/proxyTest"

export const dynamic = "force-dynamic"

/**
 * POST /api/settings/proxy-test — does this proxy URL reach that URL?
 *
 * The failure status is the *probe's*, not ours: a proxy that answers 407 is telling
 * the operator something a 500 would hide. Only a probe that reported no status at
 * all becomes a 500, and a request that never completed is a timeout, not a 500.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as {
			proxyUrl?: string
			testUrl?: string
			timeoutMs?: number
		}
		const result = await testProxyUrl({
			proxyUrl: body?.proxyUrl,
			testUrl: body?.testUrl,
			timeoutMs: body?.timeoutMs,
		})

		if (result?.ok) return NextResponse.json(result)

		const status = typeof result?.status === "number" ? result.status : 500
		return NextResponse.json({ ok: false, error: result?.error || "Proxy test failed" }, { status })
	} catch (error) {
		const message =
			error instanceof Error && error.name === "AbortError"
				? "Proxy test timed out"
				: error instanceof Error
					? error.message
					: String(error)
		return NextResponse.json({ ok: false, error: message }, { status: 500 })
	}
}
