/** Non-streaming safeguards attach. */
import { saveRequestDetail } from "@/lib/usageDb"
import { HTTP_STATUS, MAX_JSON_BODY_SIZE } from "../../config/runtimeConfig.ts"
import {
	SAFEGUARD_STATUS_UNAVAILABLE,
	SAFEGUARD_STATUS_UNSUPPORTED,
} from "../../config/safeguardsConstants.ts"
import { saveToSemanticCache } from "../../rtk/semanticCache.ts"
import { unwrapClineEnvelope } from "../../shared/clineEnvelope.ts"
import { openAICompletionToClaudeMessage } from "../../translator/concerns/claudeMessage.ts"
import { applyJsonGuard } from "../../translator/concerns/jsonGuard.ts"
import { applyOpenAIToolBridge } from "../../translator/concerns/toolBridge.ts"
import { rescueResponse } from "../../translator/concerns/toolCallRescue.ts"
import { FORMATS } from "../../translator/formats.ts"
import { needsTranslation } from "../../translator/index.ts"
import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.ts"
import { RESPONSES_ITEM, ROLE } from "../../translator/schema/index.ts"
import { decloakToolNames } from "../../utils/claudeCloaking.ts"
import { createErrorResult } from "../../utils/error.ts"
import { applyModelAlias, calledModelName } from "../../utils/modelAlias.ts"
import { restoreToolNames } from "../../utils/opencodeFingerprint.ts"
import { mergeFragmentedToolCalls } from "../../utils/toolCallRepair.ts"
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.ts"
import {
	addBufferToUsage,
	applyUsageMultipliers,
	filterUsageForFormat,
} from "../../utils/usageTracking.ts"
import { reviewAndBuildSafeguardResults } from "../safeguardsBridge.ts"
import { resolveDecisionCredentials } from "../safeguardsCredentials.ts"
import {
	attachSafeguardResults,
	buildUnavailableResults,
	collectToolUseIds,
} from "../safeguardsProtocol.ts"
import {
	buildRequestDetail,
	extractRequestConfig,
	extractUsageFromResponse,
	formatDoneLine,
	saveUsageStats,
} from "./requestDetail.ts"
import { parseSSEToOpenAIResponse } from "./sseToJsonHandler.ts"

export async function attachReviewToClaudeBody({
	responseBody,
	safeguardsPlan,
	log,
	credentialResolver,
}) {
	if (!safeguardsPlan?.active || !responseBody || typeof responseBody !== "object")
		return responseBody

	const toolUseIds = collectToolUseIds(responseBody)

	// Nothing to judge: a message with no tool call has no action to review, so
	// the decision engine is never invoked (it would cost a call per turn for
	// nothing, and an empty verdict map would tell the client review is available
	// while deciding nothing).
	if (toolUseIds.length === 0) return responseBody

	// Upstream ran the review itself: its verdict is authoritative — relay as-is.
	if (safeguardsPlan.lane === "passthrough" && Array.isArray(responseBody.safeguard_results)) {
		return responseBody
	}

	// Upstream does not review: say so, so the client falls back to its own
	// (billed) classifier rather than assuming no check happened.
	if (safeguardsPlan.lane === "passthrough") {
		return attachSafeguardResults(
			responseBody,
			buildUnavailableResults(SAFEGUARD_STATUS_UNSUPPORTED, undefined),
		)
	}

	// Bridge: 9router is the reviewer. A decision-engine outage must NOT read as
	// approval, so resolveDecisionCredentials returning null yields "unavailable"
	// and the client re-classifies with its own (billed) classifier.
	const reviewer = safeguardsPlan.reviewer
	const credentials = await resolveDecisionCredentials({
		provider: reviewer?.provider,
		model: reviewer?.model,
		credentialResolver,
	})
	if (!credentials) {
		log?.warn?.(
			"SAFEGUARD",
			`no credentials for reviewer ${reviewer?.provider} — reporting unavailable`,
		)
		return attachSafeguardResults(
			responseBody,
			buildUnavailableResults(SAFEGUARD_STATUS_UNAVAILABLE, "reviewer unavailable"),
		)
	}

	const results = await reviewAndBuildSafeguardResults({
		classifierContext: safeguardsPlan.classifierContext,
		toolUseIds,
		provider: reviewer.provider,
		model: reviewer.model,
		credentials,
		threshold: safeguardsPlan.threshold,
		log,
	})
	return attachSafeguardResults(responseBody, results)
}
