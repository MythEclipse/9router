import { getAdapter } from "@9router/db/driver"
import { injectCaveman } from "../../rtk/caveman.ts"
import { pruneContextMessages, resolvePruningLimit } from "../../rtk/contextPruning.ts"
import { injectCustomPrompt } from "../../rtk/customPrompt.ts"
import type { HeadroomDiagnostics } from "../../rtk/headroom.ts"
import {
	compressWithHeadroom,
	formatHeadroomLog,
	formatHeadroomSizeLog,
	isHeadroomPhantomSavings,
} from "../../rtk/headroom.ts"
import { compressMessages } from "../../rtk/index.ts"
import { injectPonytail } from "../../rtk/ponytail.ts"
import { compressWithPxpipe } from "../../rtk/pxpipe.ts"
import {
	measurePruningSavings,
	measureRtkSavings,
	recordTokenSavings,
} from "../../rtk/tokenSaverStats.ts"
import type { LogSink, TokenSaverConfig } from "./options.ts"

/** Pxpipe transform signature (the npm module is loaded lazily by the caller). */
type PxpipeTransform = (args: {
	body: Uint8Array
	model?: string
	options?: { minCompressChars?: number; [key: string]: unknown }
}) =>
	| Promise<{
			applied?: boolean
			reason?: string
			detail?: string
			body?: Uint8Array
			info?: {
				compressedChars?: number
				imageTokens?: number
				imagePixels?: number
				imageCount?: number
				imageBytes?: number
				baselineTokens?: number
				[key: string]: unknown
			}
			cache?: { ownsCacheControl?: boolean }
	  }>
	| {
			applied?: boolean
			reason?: string
			detail?: string
			body?: Uint8Array
			info?: {
				compressedChars?: number
				imageTokens?: number
				imagePixels?: number
				imageCount?: number
				imageBytes?: number
				baselineTokens?: number
				[key: string]: unknown
			}
			cache?: { ownsCacheControl?: boolean }
	  }
	| null

export interface ApplyTokenSaversContext {
	provider: string
	model: string
	upstreamModel: string
	/** Effective body format (source format on passthrough, target format otherwise). */
	finalFormat: string
	/** Per-request opt-out: client can bypass all token savers via header. */
	tokenSaverEnabled: boolean
	/** RTK already ran on the source body (cursor) - never compress twice. */
	preTranslateRtk: unknown
	log?: LogSink
	/** Flag accumulator for the single "⚙" line, which chatCore still prints. */
	flags: string[]
}

export interface ApplyTokenSaversResult {
	translatedBody: Record<string, unknown>
	rtkStats: unknown
	headroomDiagnostics: HeadroomDiagnostics
	pxpipeSummary: Record<string, unknown> | null
}

/**
 * Post-translation token savers, in the order the client feels them:
 * RTK → Headroom → Context Pruning → Caveman → Ponytail → Custom Prompt → Pxpipe.
 *
 * Applied at the final body just before dispatch, so both passthrough (source
 * shape) and translated (target shape) flows get them. Every saver is
 * fail-open and mutates `translatedBody` in place, except Pxpipe which returns
 * a new body. The "⚙" summary line is deliberately NOT printed here - the
 * caller prints it once, after the cache anchors are re-pinned.
 */
export async function applyTokenSavers(
	translatedBody: Record<string, unknown>,
	finalFormat: string,
	cfg: TokenSaverConfig,
	ctx: ApplyTokenSaversContext,
): Promise<ApplyTokenSaversResult> {
	const { provider, model, upstreamModel, tokenSaverEnabled, log, flags } = ctx

	// RTK: compress tool_result content. Skipped when already done pre-translate.
	const rtkStats =
		ctx.preTranslateRtk || compressMessages(translatedBody, tokenSaverEnabled && cfg.rtkEnabled)

	// Headroom: optional external proxy compression; fail open if proxy is absent.
	const headroomDiagnostics: HeadroomDiagnostics = {}
	const headroomStats = await compressWithHeadroom(translatedBody, {
		enabled: tokenSaverEnabled && cfg.headroomEnabled,
		url: cfg.headroomUrl,
		model: upstreamModel,
		format: finalFormat,
		compressUserMessages: cfg.headroomCompressUserMessages,
		timeoutMs: cfg.headroomTimeoutMs,
		diagnostics: headroomDiagnostics,
	})
	const headroomLine = formatHeadroomLog(headroomStats)
	const headroomSizeLine = formatHeadroomSizeLog(headroomDiagnostics)
	if (headroomLine) {
		log?.info?.("HEADROOM", `${headroomLine}${headroomSizeLine ? ` | ${headroomSizeLine}` : ""}`)
		if (isHeadroomPhantomSavings(headroomStats, headroomDiagnostics)) {
			log?.warn?.(
				"HEADROOM",
				`reported token delta, but messages and outbound JSON shrank <5% | ${formatHeadroomSizeLog(headroomDiagnostics)}`,
			)
		}
	} else if (tokenSaverEnabled && cfg.headroomEnabled)
		log?.warn?.(
			"HEADROOM",
			`skipped: ${headroomDiagnostics.reason || "compression unavailable"}${headroomDiagnostics.endpoint ? ` (${headroomDiagnostics.endpoint})` : ""}`,
		)

	// Context Pruning: keep system prompt and most recent messages
	if (tokenSaverEnabled && cfg.contextPruningEnabled) {
		// A preset only decides the default; an explicit limit still wins.
		const presetLimit = resolvePruningLimit(cfg.contextPruningLevel, undefined)
		const explicit = Number(cfg.maxMessagesLimit)
		const effective =
			presetLimit !== undefined && (!Number.isFinite(explicit) || explicit === 20)
				? presetLimit
				: cfg.maxMessagesLimit || 20
		const prunedTokens = measurePruningSavings(translatedBody, effective)
		pruneContextMessages(translatedBody, effective)
		if (prunedTokens > 0) recordTokenSavings(getAdapter(), { provider, model, pruning: prunedTokens })
		flags.push(`PRUNING:${effective}msgs`)
	}
	if ((rtkStats as { hits?: unknown[] })?.hits?.length) {
		const rtkSaved = measureRtkSavings(rtkStats)
		if (rtkSaved > 0) recordTokenSavings(getAdapter(), { provider, model, rtk: rtkSaved })
		flags.push(`RTK:${(rtkStats as { hits: unknown[] }).hits.length}`)
	}

	// Caveman: inject terse-style system prompt
	if (tokenSaverEnabled && cfg.cavemanEnabled && cfg.cavemanLevel) {
		injectCaveman(translatedBody, finalFormat, cfg.cavemanLevel)
		flags.push(`CAVEMAN:${cfg.cavemanLevel}`)
	}

	// Ponytail: inject lazy-senior-dev system prompt
	if (tokenSaverEnabled && cfg.ponytailEnabled && cfg.ponytailLevel) {
		injectPonytail(translatedBody, finalFormat, cfg.ponytailLevel)
		flags.push(`PONYTAIL:${cfg.ponytailLevel}`)
	}

	// Custom prompt: user-authored instruction, independent of the savers above
	if (cfg.customPromptEnabled && injectCustomPrompt(translatedBody, finalFormat, cfg.customPrompt)) {
		flags.push(`CUSTOMPROMPT:${cfg.customPrompt.trim().length}c`)
	}

	// PXPIPE: image bulky context (Claude-format bodies only), last saver before dispatch
	let pxpipeSummary: Record<string, unknown> | null = null
	if (cfg.pxpipeEnabled) {
		const pxpipeResult = await compressWithPxpipe(translatedBody, {
			enabled: true,
			format: finalFormat,
			model: upstreamModel,
			minChars: cfg.pxpipeMinChars as number,
			timeoutMs: cfg.pxpipeTimeoutMs as number,
			transform: cfg.pxpipeTransform as PxpipeTransform,
		})
		pxpipeSummary = pxpipeResult.summary
		if (pxpipeResult.body) translatedBody = pxpipeResult.body as Record<string, unknown>
		if (pxpipeSummary?.applied) flags.push(`PXPIPE:${pxpipeSummary.imageCount}img`)
		try {
			cfg.onPxpipeEvent?.({ provider, model, ...pxpipeSummary })
		} catch {
			/* stats must not break requests */
		}
	}

	return { translatedBody, rtkStats, headroomDiagnostics, pxpipeSummary }
}
