/**
 * Decide how a Claude Code auto-mode `safeguards` request gets answered.
 *
 * Two lanes, and the difference is whether the routed upstream can run
 * server-side review itself:
 *
 *   "passthrough" — the upstream is an Anthropic-format endpoint that implements
 *      the dangerous_tool_use pairing. 9router forwards the field and the beta
 *      untouched and relays the upstream's own `safeguard_results`. This is the
 *      lane that produces Anthropic's free (no-charge) classifier.
 *
 *   "bridge" — the upstream is anything else, so 9router runs the review with
 *      the System One decision engine and synthesizes the verdicts.
 *
 * In both lanes the `safeguards` field and its beta must reach the upstream as a
 * pair: Anthropic hard-400s when it receives one half without the other.
 */

import { DANGEROUS_TOOL_USE_BETA } from "../config/safeguardsConstants.ts"
import { PROVIDER_MEDIA } from "../providers/index.ts"
import REGISTRY from "../providers/registry/index.ts"
import { getClassifierContext, hasSafeguardsRequest } from "./safeguardsProtocol.ts"

// Upstreams that implement Anthropic's server-side dangerous_tool_use review.
// A verdict from these is Anthropic's own, so we relay rather than re-review.
const SERVER_REVIEW_PROVIDERS = new Set(["anthropic", "claude"])

// Providers that expose a decision engine (System One) usable as the reviewer.
const DECISION_PROVIDER_HINT = "systemone"

/**
 * Whether an upstream handles server-side review itself.
 * @param {string} provider
 * @param {string} [model]
 * @returns {boolean}
 */
export function upstreamRunsServerReview(provider, model) {
	if (!provider) return false
	if (SERVER_REVIEW_PROVIDERS.has(provider)) return true
	// An anthropic-compatible custom base URL pointed at a Claude model counts:
	// it is the same wire protocol, and the executor already forwards the beta.
	const isCompat = provider?.startsWith?.("anthropic-compatible-")
	return Boolean(isCompat && typeof model === "string" && model.startsWith("claude-"))
}

/**
 * Whether a provider can act as the decision engine for a bridged review.
 * @param {object} entry - registry entry
 * @returns {boolean}
 */
export function isDecisionProvider(entry) {
	return (
		Boolean(entry?.systemoneConfig) || (entry?.serviceKinds || []).includes(DECISION_PROVIDER_HINT)
	)
}

/**
 * Decision models a registry entry offers, cheapest first.
 * @param {object} entry
 * @returns {string[]}
 */
function decisionModelIds(entry) {
	const decisionModels = (entry?.models || []).filter((m) => m.kind === DECISION_PROVIDER_HINT)
	const ids = decisionModels.map((m) => m.id)
	// Free lanes first: a safety review is a short classification, not a
	// reasoning task, and the free tier is the cheaper one to run per action.
	return ids.sort((a, b) => Number(/-free$/.test(b)) - Number(/-free$/.test(a)))
}

/**
 * Pick the decision model used for a bridged review.
 *
 * Prefers an explicitly configured classifier model, then the cheapest decision
 * model among configured providers (registry `priority` orders preference).
 * Deterministic so the same install always routes a review to the same reviewer.
 *
 * @param {object} [settings] - router settings (classifierModel override)
 * @param {object} [modelInfo] - routed provider/model, used to avoid recursing
 *   the review back into the lane under review
 * @returns {{provider: string, model: string}|null}
 */
export function pickDecisionReviewTarget(settings, modelInfo) {
	const override = settings?.safeguardsClassifierModel
	if (typeof override === "string" && override.includes("/")) {
		const idx = override.indexOf("/")
		return { provider: override.slice(0, idx), model: override.slice(idx + 1) }
	}

	const candidates = REGISTRY.filter(
		(entry) => isDecisionProvider(entry) && PROVIDER_MEDIA[entry.id]?.systemoneConfig,
	)
		.filter((entry) => !(modelInfo && entry.id === modelInfo.provider))
		.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))

	for (const entry of candidates) {
		const models = decisionModelIds(entry)
		if (models.length > 0) return { provider: entry.id, model: models[0] }
	}
	return null
}

/**
 * Resolve what to do with this request's `safeguards` field.
 *
 * @param {object} params
 * @param {object} params.body - client request body (source shape)
 * @param {object} params.translatedBody - body actually dispatched upstream
 * @param {object} params.modelInfo - { provider, model } of the routed lane
 * @param {object} [params.settings] - router settings
 * @returns {{ active: boolean, lane: "passthrough"|"bridge"|null,
 *   classifierContext: object|null, reviewer: {provider:string,model:string}|null }}
 */
export function resolveSafeguardsReviewPlan({ body, translatedBody, modelInfo, settings }) {
	// Detection reads the client's body: the field is what Claude Code sent, and
	// translation to a non-Claude lane will not carry it.
	if (!hasSafeguardsRequest(body)) {
		return { active: false, lane: null, classifierContext: null, reviewer: null }
	}

	const classifierContext = getClassifierContext(body)

	if (upstreamRunsServerReview(modelInfo?.provider, modelInfo?.model)) {
		return { active: true, lane: "passthrough", classifierContext, reviewer: null }
	}

	const reviewer = pickDecisionReviewTarget(settings, modelInfo)
	if (!reviewer) {
		// No reviewer configured: still forward the field, and let the client fall
		// back to its own classifier because no verdict will come back.
		return { active: true, lane: "passthrough", classifierContext, reviewer: null }
	}

	return { active: true, lane: "bridge", classifierContext, reviewer }
}

/**
 * Ensure the dispatched body still carries the `safeguards` field and its beta.
 *
 * A Claude→OpenAI translation drops top-level unknown fields, and a strict
 * upstream that receives the field without the beta (or vice versa) rejects the
 * request. Restores the pair on the body actually sent.
 *
 * @param {object} translatedBody - dispatched body (mutated)
 * @param {object} plan - result of resolveSafeguardsReviewPlan
 * @param {object} [sourceBody] - client body to copy the field from
 * @returns {boolean} whether the body now carries a safeguards field
 */
export function ensureSafeguardsForwarded(translatedBody, plan, sourceBody) {
	if (!plan?.active || !translatedBody || typeof translatedBody !== "object") return false
	if (translatedBody.safeguards) return true
	if (sourceBody?.safeguards) {
		translatedBody.safeguards = sourceBody.safeguards
		return true
	}
	return false
}

/**
 * Whether the executor must be told to add the pairing beta. Executors already
 * union the client's own anthropic-beta, so this is a hint, not a rewrite.
 */
export function needsSafeguardsBeta(plan) {
	return Boolean(plan?.active) && DANGEROUS_TOOL_USE_BETA.startsWith("dangerous-tool-use")
}
