import { initTranslators } from "open-sse/translator/index"
import { handleChat } from "@/sse/handlers/chat"
import { withAdmission } from "@/sse/middleware/admission"
import { withIdempotency } from "@/sse/middleware/idempotency"

export const dynamic = "force-dynamic"

let initialized = false

/**
 * Initialize translators once
 */
async function ensureInitialized() {
	if (!initialized) {
		await initTranslators()
		initialized = true
	}
}

/**
 * Handle CORS preflight
 */
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
 * POST /v1/messages - Claude format (auto convert via handleChat)
 */
export async function POST(request) {
	await ensureInitialized()
	// Idempotency first: a replayed answer must not take an admission slot at all.
	return await withIdempotency(request, () => withAdmission(() => handleChat(request)))
}
