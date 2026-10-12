/**
 * Run the auto-mode safety review with the System One decision engine.
 *
 * Used when the routed upstream cannot answer Claude Code's `safeguards`
 * request itself (every non-Anthropic lane). The decision model is asked
 * whether the proposed action is safe; its answer is mapped onto the client's
 * verdict vocabulary in safeguardsProtocol.js.
 *
 * The state text is assembled from the classifier_context Claude Code sent
 * (the action under review plus conversation context) so the decision model
 * judges the same thing the client would.
 */

import { PROVIDER_MEDIA } from "../providers/index.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { generateSessionId } from "../executors/opencode-zen.js";
import {
  buildSafeguardResultsFromDecision,
  buildUnavailableResults,
} from "./safeguardsProtocol.js";
import { SAFEGUARD_STATUS_UNAVAILABLE } from "../config/safeguardsConstants.js";

// The single question the review asks. Kept as one constant because the
// instruction text is part of the decision contract — changing it changes what
// the engine is being asked.
const DANGEROUS_QUESTION_KEY = "is_dangerous";
const DANGEROUS_QUESTION_TYPE = "noul";
const DANGEROUS_QUESTION_INSTRUCTIONS =
  "Does this action cause serious harm outside the scope of the user's request, " +
  "target unrecognized infrastructure, or act on content the user did not authorize? " +
  "Answer with the probability that the action IS dangerous.";

/**
 * Flatten the classifier_context into the text a decision model reads.
 *
 * Claude Code's context is structured (git_state, prior_turn_context,
 * system_reminders, artifacts); a decision engine takes a single string, so
 * each present section is rendered under a stable heading. Sections are
 * omitted when empty so the state stays short — decision engines are billed
 * per token and a padded state degrades answer quality.
 *
 * @param {object|null} classifierContext
 * @returns {string}
 */
export function buildReviewState(classifierContext) {
  if (!classifierContext || typeof classifierContext !== "object") return "";

  const sections = [];
  const push = (heading, value) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value) && value.length === 0) return;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return;
    sections.push(`${heading}:\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
  };

  // The action under review comes first and stays verbatim — the decision model
  // must judge the real command, not a summary of it.
  const action = classifierContext.action
    ?? classifierContext.pending_action
    ?? classifierContext.tool_use
    ?? classifierContext.proposed_action;
  push("Action under review", typeof action === "string" ? action : action && JSON.stringify(action, null, 2));

  push("Permission mode", classifierContext.permission_mode ?? classifierContext.mode);
  push("Prior turn context", classifierContext.prior_turn_context);
  push("System reminders", classifierContext.system_reminders);
  push("Environment", classifierContext.environment);
  push("Working directory", classifierContext.live_cwd ?? classifierContext.cwd);
  push("Platform", classifierContext.platform);
  push("Git state", classifierContext.git_state);
  push("Artifacts", classifierContext.artifacts);

  return sections.join("\n\n");
}

/**
 * Ask the decision engine whether the reviewed action is dangerous.
 *
 * @param {object} params
 * @param {string} params.state - flattened review state
 * @param {string} params.provider - decision provider id (e.g. "openrouter")
 * @param {string} params.model - decision model id (e.g. "typesafe/jev-1.13")
 * @param {object} params.credentials - provider credentials
 * @returns {Promise<{ ok: boolean, response?: object, error?: string, status?: number }>}
 */
export async function runSafetyDecision({ state, provider, model, credentials }) {
  const cfg = PROVIDER_MEDIA[provider]?.systemoneConfig;
  let targetUrl = credentials?.providerSpecificData?.baseUrl || cfg?.baseUrl;
  if (!targetUrl) {
    return { ok: false, error: `Provider '${provider}' is not a decision provider.` };
  }
  if (targetUrl.includes("{accountId}")) {
    const accountId = credentials?.providerSpecificData?.accountId;
    if (!accountId) return { ok: false, error: `Provider '${provider}' requires accountId.` };
    targetUrl = targetUrl.replace("{accountId}", accountId);
  }
  // Cloudflare-style endpoints embed the model in the path.
  if (targetUrl.includes("{model}")) {
    targetUrl = targetUrl.replace(/\{model\}/g, getModelUpstreamId(provider, model) || model);
  }

  const token = credentials?.apiKey || credentials?.accessToken;
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(cfg.headers || {}),
    "x-opencode-session": generateSessionId(),
  };

  // The body model must stay provider-qualified (`openrouter/typesafe/jev-1.13`).
  // A decision model id is itself slash-prefixed, so the model parser would read
  // the bare `typesafe/...` as a provider named "typesafe" and the lane fails
  // credential lookup with "No credentials for provider: typesafe".
  const upstreamModel = getModelUpstreamId(provider, model) || model;
  const requestBody = {
    model: model.includes("/") ? `${provider}/${upstreamModel}` : upstreamModel,
    state,
    questions: {
      [DANGEROUS_QUESTION_KEY]: {
        type: DANGEROUS_QUESTION_TYPE,
        instructions: DANGEROUS_QUESTION_INSTRUCTIONS,
      },
    },
  };

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      ...(typeof AbortSignal?.timeout === "function"
        ? { signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS) }
        : {}),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `Decision engine rejected the request (HTTP ${res.status}).` };
    }
    return { ok: true, response: await res.json() };
  } catch (error) {
    return { ok: false, error: `Decision engine unreachable: ${error?.message || error}` };
  }
}

/**
 * Produce the `safeguard_results` for a reviewed Claude response.
 *
 * Never throws and never returns a verdict on failure: an engine outage yields
 * `unavailable`, which sends Claude Code back to its own classifier.
 *
 * @param {object} params
 * @param {object|null} params.classifierContext
 * @param {string[]} params.toolUseIds - ids to key verdicts by
 * @param {string} params.provider - decision provider id
 * @param {string} params.model - decision model id
 * @param {object} params.credentials
 * @param {string} [params.ruleName] - rule shown to the user on a block
 * @param {number} [params.threshold]
 * @param {object} [params.log]
 * @returns {Promise<object[]>}
 */
export async function reviewAndBuildSafeguardResults({
  classifierContext,
  toolUseIds,
  provider,
  model,
  credentials,
  ruleName = "auto_mode_safety_review",
  threshold,
  log,
}) {
  const state = buildReviewState(classifierContext);

  if (!state) {
    log?.debug?.("SAFEGUARD", "no classifier_context to review — reporting unsupported");
    return buildUnavailableResults(SAFEGUARD_STATUS_UNAVAILABLE, "no classifier context");
  }

  const decision = await runSafetyDecision({ state, provider, model, credentials });
  if (!decision.ok) {
    log?.warn?.("SAFEGUARD", `review failed: ${decision.error}`);
    return buildUnavailableResults(SAFEGUARD_STATUS_UNAVAILABLE, decision.error);
  }

  const results = buildSafeguardResultsFromDecision({
    systemoneResponse: decision.response,
    toolUseIds,
    explanation: ruleName,
    threshold,
  });

  const verdict = results[0]?.status?.tool_uses?.[toolUseIds[0]];
  log?.debug?.(
    "SAFEGUARD",
    `review complete: ${verdict?.outcome ?? results[0]?.status?.type} for ${toolUseIds.length} call(s)`
  );
  return results;
}