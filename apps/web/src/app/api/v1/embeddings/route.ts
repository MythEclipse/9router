import { handleEmbeddings } from "@/sse/handlers/embeddings"
import { withAdmission } from "@/sse/middleware/admission"
import { withIdempotency } from "@/sse/middleware/idempotency"

export const dynamic = "force-dynamic"

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
	return new Response(null, {
		headers: {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "POST, OPTIONS",
			"Access-Control-Allow-Headers": "*",
		},
	})
}

/**
 * POST /v1/embeddings - OpenAI-compatible embeddings endpoint
 */
export async function POST(request) {
	// Idempotency first: a replayed answer must not take an admission slot at all.
	return await withIdempotency(request, () => withAdmission(() => handleEmbeddings(request)))
}
