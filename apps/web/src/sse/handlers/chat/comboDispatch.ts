import { withCapacityAdapterStripping } from "open-sse/services/capacityAdapter"
import { handleComboChat, handleFusionChat } from "open-sse/services/combo"
import { resolveSessionIdentity } from "open-sse/utils/sessionManager"
import { resolveSmartChoice } from "../../services/systemoneRouter.ts"
import * as log from "../../utils/logger.ts"
import { emptyResponseReporter } from "./emptyResponseReporter.ts"

/** A studio name may itself point at a combo; this is how many hops we follow. */
const MAX_STUDIO_COMBO_HOPS = 3

/**
 * Resolve the combo a model name stands for, following studio names.
 *
 * A studio name may also resolve here: `getModelInfo` answers a studio that
 * points at a combo with the combo name in `model`, so the caller passes that.
 * A hop limit stops a studio/combo cycle from recursing.
 */
export async function resolveComboEntryName(modelStr: string): Promise<string> {
	if (modelStr.includes("/")) return modelStr
	let comboEntryName = modelStr
	try {
		const { getStudioModel } = await import("@9router/db/repos/modelEditorRepo")
		const seenStudios = new Set([modelStr])
		for (let hop = 0; hop < MAX_STUDIO_COMBO_HOPS; hop += 1) {
			const studioTarget = await getStudioModel(comboEntryName)
			if (!studioTarget?.targetModel) break
			const next = String(studioTarget.targetModel).trim()
			if (!next || next.includes("/") || seenStudios.has(next)) break
			comboEntryName = next
			seenStudios.add(next)
		}
	} catch {
		/* studio lookup is best-effort; fall through to the raw name */
	}
	return comboEntryName
}

/** Combo-specific strategy when configured, else the global one. */
export function resolveComboStrategy(comboEntryName: string, settings: any): string {
	const comboSpecificStrategy = (settings.comboStrategies || {})[comboEntryName]?.fallbackStrategy
	return comboSpecificStrategy || settings.comboStrategy || "fallback"
}

/**
 * Binds one combo member attempt. Declared as returning `Response` — not `any` —
 * on purpose: `handleComboChat`/`handleFusionChat` pass the callback's return
 * value straight through, so an `any` here would widen `dispatchCombo`'s own
 * `Promise<Response>` and every route calling `handleChat` with it.
 */
type HandleSingleModel = (body, model, isPanel?) => Promise<Response>

/**
 * Run a combo (or the capacity-adapter fan-out on a solo model) with the
 * configured strategy.
 *
 * There is one implementation for both combo entry points: the combo the caller
 * asked for, and the combo a single-model attempt resolves to. They differ only
 * in what a member attempt binds (`handleSingleModel` — alias + `onServe` at the
 * top, the raw model string nested) and in whether an empty answer can be
 * charged to a served account (`lastServed` is only filled at the top, where
 * `onServe` exists). Those arrive as parameters; the rest of the combo wiring is
 * identical and stays here.
 */
export function dispatchCombo({
	body,
	models,
	comboModels,
	augmentedModels,
	adapterAdded,
	handleSingleModel,
	comboName,
	comboStrategy,
	settings,
	comboCfg,
	request,
	sessionId,
	lastServed = null,
	withEmptyReporter = true,
}: {
	body: any
	/** Members to run (augmented by the capacity adapter). */
	models: string[]
	/** Pre-adapter members: the fusion panel and the log's model count. */
	comboModels: string[]
	augmentedModels: string[]
	adapterAdded: string[]
	/** Bind a member attempt: `(body, model, isPanel) => Promise<Response>`. */
	handleSingleModel: HandleSingleModel
	comboName: string
	comboStrategy: string
	settings: any
	comboCfg: any
	request?: Request | null
	sessionId?: string | null
	lastServed?: { model?: string; connectionId?: string; provider?: string } | null
	withEmptyReporter?: boolean
}): Promise<Response> {
	if (comboStrategy === "fusion") {
		log.info("CHAT", `Combo "${comboName}" with ${comboModels.length} models (strategy: fusion)`)
		return handleFusionChat({
			body,
			models: comboModels,
			signal: request?.signal,
			handleSingleModel,
			log,
			comboName,
			judgeModel: comboCfg.judgeModel,
			tuning: comboCfg.fusionTuning,
		})
	}

	const comboStickyLimit = settings.comboStickyRoundRobinLimit
	log.info(
		"CHAT",
		`Combo "${comboName}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`,
	)
	return handleComboChat({
		body,
		models,
		signal: request?.signal,
		handleSingleModel: withCapacityAdapterStripping(handleSingleModel, adapterAdded),
		log,
		comboName,
		comboStrategy,
		comboStickyLimit,
		sessionId,
		smartPolicy: comboCfg.smartPolicy || "smart",
		sessionSticky: comboCfg.sessionSticky !== false,
		confidenceThreshold:
			typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
		onEmptyResponse: withEmptyReporter ? emptyResponseReporter(lastServed) : null,
		resolveSmartChoice:
			comboStrategy === "smart"
				? (b, m) =>
						resolveSmartChoice({
							body: b,
							models: m,
							routerModel: comboCfg.routerModel,
							log,
						})
				: null,
	})
}

/** Session identity for a combo run; `apiKey` scopes it to the caller's key. */
export function comboSessionId({
	request,
	body,
	apiKey,
	scope = "chat",
}: {
	request?: Request | null
	body: any
	apiKey?: string | null
	scope?: string
}): string | null {
	const { sessionId } = resolveSessionIdentity({
		headers: request?.headers,
		body,
		connectionId: apiKey || "",
		// Nested combos share chat-session identity; they are not provider scopes.
		scope,
	})
	return sessionId
}
