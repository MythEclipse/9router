import { proxyProbeAnswer, proxyProbeErrorMessage } from "9router-api/domain/proxy-probe"
import { NextResponse } from "next/server"
import { testProxyUrl } from "@/lib/network/proxyTest"

export const dynamic = "force-dynamic"

/**
 * POST /api/settings/proxy-test — does this proxy URL reach that URL?
 *
 * The status mapping lives in `domain/proxy-probe`: the probe's own status is the answer, and only a
 * probe that reported nothing at all becomes a 500.
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

		const answer = proxyProbeAnswer(result)
		return NextResponse.json(answer.body, { status: answer.status })
	} catch (error) {
		return NextResponse.json({ ok: false, error: proxyProbeErrorMessage(error) }, { status: 500 })
	}
}
