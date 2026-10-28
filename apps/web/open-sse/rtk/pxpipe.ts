// PXPIPE: render bulky Claude-format context as dense PNGs via pxpipe-proxy's
// library API (transformAnthropicMessages). Fail-open like every token saver:
// any error/timeout returns { body: null, summary } and leaves the request untouched.
import { FORMATS } from "../translator/formats.ts"

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MIN_CHARS = 25000
// pxpipe's own profitability gate assumes ~4 chars/token; reuse it for the
// estimated before/after numbers surfaced in stats (marked "estimated" in UI).
const EST_CHARS_PER_TOKEN = 4

function bodyChars(body: unknown): number {
	try {
		return JSON.stringify(body)?.length || 0
	} catch {
		return 0
	}
}

function estTokens(chars: number): number {
	return Math.round(chars / EST_CHARS_PER_TOKEN)
}

/** Extra key/value pairs merged into a `not applied` summary. */
type PxpipeSkipExtra = {
	detail?: string | null
	originalChars?: number
	threshold?: number
	durationMs?: number
}

function skipped(reason: string, extra: PxpipeSkipExtra = {}): PxpipeCompressResult {
	return { body: null, summary: { applied: false, reason, ...extra } }
}

/**
 * Input the host-side pxpipe transform receives: the Claude request body
 * UTF-8 encoded, the model id, and pxpipe's own compression gate.
 */
type PxpipeTransformArgs = {
	body: Uint8Array
	model?: string
	options?: { minCompressChars?: number; [key: string]: unknown }
}

/** Stats pxpipe reports back about the images it produced. */
type PxpipeInfo = {
	compressedChars?: number
	imageTokens?: number
	imagePixels?: number
	imageCount?: number
	imageBytes?: number
	baselineTokens?: number
	[key: string]: unknown
}

/**
 * Result of the host-side pxpipe transform. `body` is the transformed request
 * body, still UTF-8 encoded bytes (JSON) rather than a decoded object.
 */
type PxpipeTransformResult = {
	applied?: boolean
	reason?: string
	detail?: string
	body?: Uint8Array
	info?: PxpipeInfo
	cache?: { ownsCacheControl?: boolean }
} | null

/** The injected pxpipe entry point (owned by the src side). */
type PxpipeTransform = (
	args: PxpipeTransformArgs,
) => Promise<PxpipeTransformResult> | PxpipeTransformResult

// Transform a Claude-format request body through pxpipe. Returns
// { body: <new body object> | null, summary } - body is null when nothing changed.
// opts.transform is injected by the host (src side) so open-sse stays free of
// filesystem/install concerns and remains usable standalone.
type PxpipeOptions = {
	enabled?: boolean
	format?: string
	model?: string
	minChars?: number
	timeoutMs?: number
	transform?: PxpipeTransform
}

type PxpipeSummary = PxpipeSkipExtra & {
	applied: boolean
	reason: string
	tokensBeforeEst?: number
	tokensAfterEst?: number
	tokensSavedEst?: number
	savedPct?: number
	compressedBodyChars?: number
	imagedChars?: number
	imageCount?: number
	imageBytes?: number
	durationMs?: number
	cacheOwnsControl?: boolean
}

type PxpipeCompressResult = {
	/** The transformed request body, or `null` when pxpipe left it untouched. */
	body: unknown
	summary: PxpipeSummary
}

export async function compressWithPxpipe(
	body: unknown,
	{ enabled, format, model, minChars, timeoutMs, transform }: PxpipeOptions = {},
): Promise<PxpipeCompressResult> {
	if (!enabled) return skipped("disabled")
	if (typeof transform !== "function") return skipped("not_installed")
	if (!body) return skipped("missing_body")
	if (format !== FORMATS.CLAUDE) return skipped("unsupported_format", { detail: format })

	const startedAt = Date.now()
	const originalChars = bodyChars(body)
	const threshold = Number(minChars) > 0 ? Number(minChars) : DEFAULT_MIN_CHARS
	if (originalChars < threshold) {
		return skipped("below_threshold", { originalChars, threshold })
	}

	try {
		const encoded = new TextEncoder().encode(JSON.stringify(body))
		const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS
		// transformAnthropicMessages is local CPU work and can't be aborted; race a
		// timer and discard the result if it loses (input body is never mutated).
		const result = await Promise.race<PxpipeTransformResult>([
			Promise.resolve(
				transform({
					body: encoded,
					model,
					options: { minCompressChars: threshold },
				}),
			),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), budget)),
		])
		if (!result) return skipped("timeout", { originalChars, durationMs: Date.now() - startedAt })
		if (!result.applied) {
			return skipped(result.reason || "passthrough", {
				detail: result.detail,
				originalChars,
				durationMs: Date.now() - startedAt,
			})
		}

		if (!result.body)
			return skipped("transform_error", {
				detail: "pxpipe returned no body",
				originalChars,
				durationMs: Date.now() - startedAt,
			})
		const newBody = JSON.parse(new TextDecoder().decode(result.body)) as unknown
		const compressedBodyChars = bodyChars(newBody)
		const info = result.info || {}
		const imagedChars = info.compressedChars || 0
		// The transformed body is BIGGER in bytes (base64 PNGs) but cheaper in tokens:
		// images bill by pixels (Anthropic: pixels/750), not by encoded length. So the
		// after-estimate is remaining-text tokens + image tokens - never chars/4 of the
		// new body. Provider-billed usage recorded per request stays the ground truth.
		const imageTokensEst =
			info.imageTokens ||
			(info.imagePixels ? Math.round(info.imagePixels / 750) : (info.imageCount || 0) * 4761)
		const summary: PxpipeSummary = {
			applied: true,
			reason: "applied",
			originalChars,
			compressedBodyChars,
			imagedChars,
			imageCount: info.imageCount || 0,
			imageBytes: info.imageBytes || 0,
			tokensBeforeEst: info.baselineTokens || estTokens(originalChars),
			tokensAfterEst: estTokens(Math.max(0, originalChars - imagedChars)) + imageTokensEst,
			durationMs: Date.now() - startedAt,
			cacheOwnsControl: result.cache?.ownsCacheControl === true,
		}
		summary.tokensSavedEst = Math.max(0, summary.tokensBeforeEst - summary.tokensAfterEst)
		summary.savedPct =
			summary.tokensBeforeEst > 0
				? +((summary.tokensSavedEst / summary.tokensBeforeEst) * 100).toFixed(2)
				: 0
		return { body: newBody, summary }
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e)
		return skipped("transform_error", { detail, originalChars, durationMs: Date.now() - startedAt })
	}
}

export function formatPxpipeLog(summary: PxpipeSummary | null | undefined): string | null {
	if (!summary) return null
	if (!summary.applied) return null
	return `imaged ${summary.imagedChars}ch → ${summary.imageCount} image(s) | est ${summary.tokensBeforeEst}→${summary.tokensAfterEst} tokens (-${summary.savedPct}%) | ${summary.durationMs}ms`
}
