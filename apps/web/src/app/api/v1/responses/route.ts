import { initTranslators } from "open-sse/translator/index"
import { handleChat } from "@/sse/handlers/chat"
import { withAdmission } from "@/sse/middleware/admission"
import { withIdempotency } from "@/sse/middleware/idempotency"

export const dynamic = "force-dynamic"

let initialized = false

async function ensureInitialized() {
	if (!initialized) {
		await initTranslators()
		initialized = true
	}
}

export async function OPTIONS() {
	return new Response(null, {
		headers: {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "*",
		},
	})
}

/**
 * POST /v1/responses - OpenAI Responses API format
 * Now handled by translator pattern (openai-responses format auto-detected)
 */
export async function POST(request) {
	await ensureInitialized()
	// Idempotency first: a replayed answer must not take an admission slot at all.
	return await withIdempotency(request, () => withAdmission(() => handleChat(request)))
}
