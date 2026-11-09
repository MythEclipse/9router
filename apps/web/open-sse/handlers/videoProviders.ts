import { HTTP_STATUS } from "../config/runtimeConfig.ts"
import { PROVIDER_MEDIA } from "../providers/index.ts"
import { refreshTokenByProvider } from "../services/tokenRefresh.ts"
import type {
	Credentials,
	CredentialsRefreshedCallback,
	EngineLogger,
	MediaRequestPlan,
} from "../types.ts"
import { createErrorResult } from "../utils/error.ts"
import { sanitizeSecrets } from "./videoHelpers.ts"
import { getVideoAdapter } from "./videoProviders/index.ts"

// Upstream fetch deadline for video job submission/polling (the job itself is
// async upstream - this only bounds the HTTP round-trip, not video rendering).
const VIDEO_FETCH_TIMEOUT_MS = Number(process.env.VIDEO_FETCH_TIMEOUT_MS || 120000)

// POST /videos/* creates a billable upstream job. A network error after the
// request left the socket may still have created the job, so creation is NEVER
// auto-retried (the only re-send is the auth retry after a 401/403 refresh,
// which upstream rejects before job creation).
export function getVideoConfig(provider: string) {
	return PROVIDER_MEDIA[provider]?.videoConfig || null
}

export function isExecutorDrivenVideo(provider) {
	return PROVIDER_MEDIA[provider]?.videoConfig?.executorDriven === true
}

/** Anything an upstream call in this module may throw: fetch/abort errors carry
 * a `name`, refreshed-provider errors carry an HTTP `status`. */
interface VideoFailure {
	name?: string
	message?: string
	status?: number
}

/** Executor-driven generation: the browser executor returns base64 mp4. */
export async function executeExecutorDrivenVideo({
	provider,
	rawBody,
	credentials,
	signal,
	log,
	onCredentialsRefreshed,
}: {
	provider: string
	rawBody: unknown
	credentials: Credentials
	signal?: AbortSignal | null
	log?: EngineLogger
	onCredentialsRefreshed?: CredentialsRefreshedCallback
}) {
	let parsed: Record<string, unknown> = {}
	try {
		parsed = JSON.parse(typeof rawBody === "string" ? rawBody : String(rawBody || "{}"))
	} catch {
		return createErrorResult(HTTP_STATUS.BAD_REQUEST, `[${provider}] invalid video request body`)
	}
	if (!parsed.prompt) {
		return createErrorResult(HTTP_STATUS.BAD_REQUEST, `[${provider}] video request requires a prompt`)
	}

	// Image-to-video: accept `image`/`image_url` (string) or `images`/`image_urls` (array)
	const imageRefs = []
		.concat(parsed.image ?? parsed.image_url ?? [])
		.concat(Array.isArray(parsed.images) ? parsed.images : [])
		.concat(Array.isArray(parsed.image_urls) ? parsed.image_urls : [])
		.filter((ref) => typeof ref === "string" && ref)

	const { getExecutor } = await import("../executors/index.ts")
	const executor = getExecutor(provider)
	if (!executor?.generateMedia) {
		return createErrorResult(HTTP_STATUS.BAD_REQUEST, `[${provider}] has no executor video support`)
	}

	try {
		const apiKeyBefore = credentials?.apiKey
		const [media] = await executor.generateMedia({
			prompt: parsed.prompt,
			kind: "video",
			size: parsed.size,
			model: parsed.model,
			duration: parsed.seconds ?? parsed.duration,
			resolution: parsed.resolution,
			n: 1,
			images: imageRefs,
			credentials,
			signal,
			log,
		})
		const dataUrl = `data:${media.mime || "video/mp4"};base64,${media.b64}`
		// Cookies that rotate on use (Clerk `__client`) are mutated in place by the
		// executor — persist the new value so the chain does not drift.
		if (onCredentialsRefreshed && credentials?.apiKey && credentials.apiKey !== apiKeyBefore) {
			await onCredentialsRefreshed({ apiKey: credentials.apiKey })
		}
		return {
			success: true as const,
			response: new Response(
				JSON.stringify({
					id: `video-${provider}-${Date.now()}`,
					object: "video.generation",
					created: Math.floor(Date.now() / 1000),
					model: parsed.model || provider,
					status: "completed",
					video: {
						url: dataUrl,
						...(media.width ? { width: media.width } : {}),
						...(media.height ? { height: media.height } : {}),
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
				},
			),
		}
	} catch (error) {
		const message = sanitizeSecrets(
			(error as VideoFailure)?.message || "video generation failed",
			credentials,
		)
		const status =
			(error as VideoFailure)?.status && Number.isInteger((error as VideoFailure).status)
				? (error as VideoFailure).status
				: 502
		return createErrorResult(status, `[${provider}] ${message}`)
	}
}

/** Strip bearer tokens / obvious secrets from text destined for clients or logs. */
