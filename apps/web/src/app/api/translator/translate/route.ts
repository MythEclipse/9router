import { translatorStep, translatorTarget } from "9router-api/domain/translator"
import { NextResponse } from "next/server"
import { getExecutor } from "open-sse/executors/index"
import { detectFormat, getTargetFormat } from "open-sse/services/provider"
import { FORMATS } from "open-sse/translator/formats"
import { translateRequest } from "open-sse/translator/index"
import { getProviderConnections } from "@/lib/localDb"
import { getModelInfo } from "@/sse/services/model"

export const dynamic = "force-dynamic"

/**
 * The inspector accepts either `{ body }` or a bare body, because the three steps are fed raw dump
 * files and hand-edited JSON alike. Normalised once here rather than at each of the three stages.
 */
function inspectorBody(body: unknown): Record<string, unknown> {
	const wrapped = (body as { body?: unknown }).body
	return (wrapped ?? body) as Record<string, unknown>
}

/** Every refusal in this route has the same shape, so it is written once. */
function refusal(error: string) {
	return NextResponse.json({ success: false, error }, { status: 400 })
}

export async function POST(request) {
	try {
		const { step, body } = await request.json()
		const stage = translatorStep(step)

		if (stage === null || !body) {
			return refusal("Step (1-3) and body required")
		}

		switch (stage) {
			case 1: {
				// Detect provider + formats from 1_req_client.json
				const clientBody = inspectorBody(body)
				const { provider, model } = await getModelInfo(clientBody.model)
				const sourceFormat = detectFormat(clientBody)
				const targetFormat = getTargetFormat(provider)
				return NextResponse.json({
					success: true,
					result: { provider, model, sourceFormat, targetFormat },
				})
			}

			case 2: {
				// source → OpenAI intermediate (mirrors 3_req_openai.json)
				// Translate source→openai only (half of the pipeline)
				const clientBody = inspectorBody(body)
				const { provider, model } = await getModelInfo(clientBody.model)
				const sourceFormat = detectFormat(clientBody)
				const stream = clientBody.stream !== false

				// translateRequest(source, OPENAI) = only the first half
				const result = translateRequest(
					sourceFormat,
					FORMATS.OPENAI,
					model,
					clientBody,
					stream,
					null,
					provider,
				)
				delete result._toolNameMap

				return NextResponse.json({ success: true, result: { body: result } })
			}

			case 3: {
				// OpenAI intermediate → target + build URL/headers (mirrors 4_req_target.json)
				const openaiBody = inspectorBody(body)
				const target = translatorTarget(body.provider, body.model)
				if (target === null) {
					return refusal("provider and model required")
				}
				const { provider, model } = target

				const targetFormat = getTargetFormat(provider)
				const stream = openaiBody.stream !== false

				// translateRequest(OPENAI, target) = second half of pipeline
				const translated = translateRequest(
					FORMATS.OPENAI,
					targetFormat,
					model,
					openaiBody,
					stream,
					null,
					provider,
				)
				delete translated._toolNameMap

				// Build URL + headers via executor (same as chatCore → executor.execute)
				const connections = await getProviderConnections({ provider })
				const connection = connections.find((c) => c.isActive !== false)
				if (!connection) {
					return refusal(`No active connection for provider: ${provider}`)
				}

				const credentials = {
					apiKey: connection.apiKey,
					accessToken: connection.accessToken,
					refreshToken: connection.refreshToken,
					copilotToken: connection.copilotToken,
					projectId: connection.projectId,
					providerSpecificData: connection.providerSpecificData,
				}

				const executor = getExecutor(provider)
				const url = executor.buildUrl(model, stream, 0, credentials)
				const headers = executor.buildHeaders(credentials, stream)
				const finalBody = executor.transformRequest(model, translated, stream, credentials)

				return NextResponse.json({ success: true, result: { url, headers, body: finalBody } })
			}
		}
	} catch (error) {
		console.error("Error in translator:", error)
		return NextResponse.json({ success: false, error: error.message }, { status: 500 })
	}
}
