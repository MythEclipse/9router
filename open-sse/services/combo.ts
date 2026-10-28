/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter } from "./accountFallback.ts";
import { unavailableResponse } from "../utils/error.ts";
import { getCapabilitiesForModel } from "../providers/capabilities.ts";
import { parseModel } from "./model.ts";
import { extractTextContent } from "../translator/formats/gemini.ts";
import { peekStreamForContent, reconstructStream, isNoRetryFinish } from "./emptyFailover.ts";
import {
  getStickyComboModel,
  setStickyComboModel,
  clearStickyComboSession,
  orderModelsByChoice,
} from "./systemoneRouter.ts";

// Peek a 2xx combo response for real content. Returns null for non-SSE responses (leave
// them untouched). For SSE, returns { outcome: "content"|"empty", finishReason, response }
// where `response` is a faithful replay of the original stream (head buffer + live reader).
async function peekComboResponse(result, log, sourceFormat) {
  const ct = (result.headers.get("content-type") || "").toLowerCase();
  if (!result.body || !ct.includes("text/event-stream")) return null;
  // The Responses API carries event names in `event:` lines while the JSON
  // payload may omit `type`. Pass the SSE event through to the structural parser.
  const peeked = await peekStreamForContent(result.body, { format: sourceFormat });
  if (peeked?.error) {
    log?.warn?.("COMBO", "peekStreamForContent could not inspect SSE body", {
      stage: "peekStreamForContent",
      status: result.status,
      bodyLocked: !!result.body?.locked,
      hasReader: typeof result.body?.getReader === "function",
      error: peeked.error?.message || String(peeked.error),
      stack: peeked.error?.stack,
    });
  }
  const response = new Response(reconstructStream(peeked.head, peeked.reader, peeked.pendingRead), {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
  return { outcome: peeked.outcome, finishReason: peeked.finishReason, timedOut: peeked.timedOut, response };
}

function isLockedStreamError(error) {
  const msg = String(error?.message || error || "");
  return /ReadableStream is locked|Invalid state: The ReadableStream is locked|stream.*locked/i.test(msg);
}

/**
 * Sleep that resolves early when `signal` aborts, so a disconnect is noticed
 * during a cooldown wait instead of after it.
 */
function sleepAbortable(ms, signal) {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve<void>(undefined);
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Tell the host that a member answered 2xx with no usable content.
 *
 * Fail-open on purpose: bookkeeping must never turn a recoverable empty answer
 * into a thrown error that aborts the whole combo.
 */
async function reportEmptyResponse(onEmptyResponse, modelStr, reason) {
  if (typeof onEmptyResponse !== "function") return;
  try {
    await onEmptyResponse(modelStr, reason);
  } catch { /* telemetry only */ }
}

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput", "tools"]);

// How much of a string message `detectRequiredCapabilities` inspects for an
// embedded data URI. A data URI is the payload when present, so it appears at the
// very start; anything beyond this window is prose that cannot introduce one.
const DATA_URI_SCAN_WINDOW = 4096;

// Deep-copy the request body so translator in-place mutations (tool_use/tool_result
// reshaping, role rewriting) don't leak across combo fallback iterations or parallel
// panel calls. Covers: OpenAI/Claude `messages`, Gemini `contents`, Responses `input`.
function deepCopyBody(body) {
  if (!body || typeof body !== "object") return body;
  // structuredClone copies to full depth, which the hand-rolled version did not:
  // it only cloned ONE level of `messages`/`contents`/`input`, so `tool_calls`
  // inside a message, nested `parts`, and every non-array parameter (`tools`,
  // `metadata`, generation settings) stayed shared by reference across combo
  // iterations and parallel fusion panels — the exact leak this function exists
  // to prevent. Both Bun and Node provide it; fall back only if absent.
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(body);
    } catch { /* non-cloneable payload (e.g. a stream): use the shallow path */ }
  }
  const copyItem = (m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map(b => ({ ...b })) : m.content });
  const copyContentsItem = (m) => ({ ...m, parts: Array.isArray(m.parts) ? m.parts.map(b => ({ ...b })) : m.parts });
  const copyInputItem = (m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map(b => ({ ...b })) : m.content });
  return {
    ...body,
    ...(Array.isArray(body.messages) ? { messages: body.messages.map(copyItem) } : {}),
    ...(Array.isArray(body.contents) ? { contents: body.contents.map(copyContentsItem) } : {}),
    ...(Array.isArray(body.input)    ? { input:    body.input.map(copyInputItem)    } : {}),
  };
}

// Prefixes used when flattening tool turns into plain prose for panel models.
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";

// Flatten tool turns into prose so panel models keep the context but can't loop
// on tools: drop the request's tools, turn tool/function results into assistant
// text, and inline assistant tool_calls names instead of the structured field.
function flattenToolHistory(messages) {
  return messages
    .filter((msg) => msg)
    .map((msg) => {
      if (msg.role === "tool" || msg.role === "function") {
        return { role: "assistant", content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]` };
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const { tool_calls, ...rest } = msg;
        const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
        const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
        return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` };
      }
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((c) => c.type === "tool_use");
        const hasToolResult = msg.content.some((c) => c.type === "tool_result");
        if (hasToolUse || hasToolResult) {
          const textParts = [];
          const toolNames = [];
          const toolResults = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
            if (block.type === "tool_use") toolNames.push(block.name || "tool");
            if (block.type === "tool_result") toolResults.push(extractTextContent(block.content) || String(block.content ?? ""));
          }
          const { ...rest } = msg;
          let newContent = textParts.join("\n");
          if (toolNames.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`;
          }
          if (toolResults.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`;
          }
          return { ...rest, content: newContent };
        }
      }
      return msg;
    });
}

// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const caps = getCapabilitiesForModel(provider, model);
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  // Stable sort by tier (Array.prototype.sort is stable in modern engines).
  return models
    .map((m, i) => ({ m, i, t: tierOf(m) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model - those get stripped + placeholdered downstream instead.
function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const addByMime = (mime) => {
    if (typeof mime !== "string") return;
    if (mime.startsWith("image/")) required.add("vision");
    else if (mime === "application/pdf") required.add("pdf");
    else if (mime.startsWith("audio/")) required.add("audioInput");
    else if (mime.startsWith("video/")) required.add("videoInput");
  };

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "input_audio" || t === "audio_url" || t === "audio") required.add("audioInput");
    if (t === "input_video" || t === "video_url" || t === "video") required.add("videoInput");
    if (t === "file" || t === "document" || t === "input_file") {
      // Infer modality from embedded mime when available; fall back to pdf for generic files.
      let fmime = null;
      if (b.input_audio?.format) fmime = `audio/${b.input_audio.format}`;
      else if (b.file?.file_data) fmime = String(b.file.file_data).match(/^data:([^;,]+)/)?.[1];
      else if (b.source?.media_type) fmime = b.source.media_type;
      else if (b.source?.data) fmime = String(b.source.data).match(/^data:([^;,]+)/)?.[1];
      if (fmime) addByMime(fmime);
      else required.add("pdf");
    }
    // gemini parts: inlineData/fileData carry a mime
    addByMime(b.inlineData?.mimeType || b.fileData?.mimeType);
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  const scanMessage = (m) => {
    if (!m || typeof m !== "object") return;

    // Ollama / Hermes images array (strings or objects)
    if (Array.isArray(m.images) && m.images.length > 0) {
      required.add("vision");
    }

    // Vercel AI SDK / Hermes attachments / experimental_attachments
    const attachments = m.experimental_attachments || m.attachments;
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att) continue;
        const mime = att.contentType || att.mediaType || (typeof att.url === "string" && att.url.match(/^data:([^;,]+)/)?.[1]);
        if (mime) addByMime(mime);
        else if (att.url || att.data) required.add("vision");
      }
    }

    // Direct message-level modality properties
    if (m.image_url || m.image) required.add("vision");
    if (m.audio_url || m.audio) required.add("audioInput");

    // Scan array content blocks
    scanContent(m.content);

    // Scan string content for embedded data URIs. Bounded on purpose: a data URI
    // can only appear at the start of a content string (it is the whole payload
    // when present), and a multi-megabyte base64 message made the unbounded
    // `includes` scan the full body once per message, per request. The window
    // covers the scheme plus generous leading prose without touching megabytes.
    if (typeof m.content === "string") {
      const head = m.content.length > DATA_URI_SCAN_WINDOW
        ? m.content.slice(0, DATA_URI_SCAN_WINDOW)
        : m.content;
      if (head.includes("data:image/")) required.add("vision");
      else if (head.includes("data:audio/")) required.add("audioInput");
      else if (head.includes("data:application/pdf")) required.add("pdf");
    }
  };

  // Modalities: current user turn only (trailing user run across each known shape).
  for (const m of trailingUserItems(body.messages)) scanMessage(m);              // openai / claude / hermes / ollama
  for (const it of trailingUserItems(body.input)) scanContent(it.content);       // responses
  const contents = body.contents || body.request?.contents;                      // gemini / antigravity
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // search: temporarily disabled in auto-switch (feature not wired yet).

  // tools: when body.tools is a non-empty array or body.tool_choice is present,
  // the request needs a tool-capable model (providers without tools would ignore
  // the tool definitions / tool_choice).
  if (Array.isArray(body.tools) && body.tools.length > 0) required.add("tools");
  else if (body.tool_choice != null) required.add("tools");

  return required;
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1) {
    return models;
  }

  if (strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) {
    comboRotationState.delete(comboName);
    clearStickyComboSession(comboName);
  } else {
    comboRotationState.clear();
    clearStickyComboSession();
  }
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Detect whether a 2xx JSON response contains zero usable content
 * (e.g. empty assistant message with in_progress/incomplete)
 * so combo fallback can continue to the next model.
 */
export function isZeroContentResponse(data) {
  if (!data || typeof data !== "object") return false;

  // OpenAI chat format
  if (Array.isArray(data.choices)) {
    if (data.choices.length === 0) return true;
    const choice = data.choices[0];
    if (!choice) return true;

    const msg = choice.message || choice.delta;
    const content = msg?.content;
    const hasContent = typeof content === "string" ? content.trim().length > 0 : (Array.isArray(content) && content.length > 0);
    const hasToolCalls = (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) || Boolean(msg?.function_call);
    const hasReasoning = typeof msg?.reasoning_content === "string" ? msg.reasoning_content.trim().length > 0 : false;

    const finish = choice.finish_reason;
    const isNormalFinish = finish === "stop" || finish === "length" || finish === "tool_calls" || finish === "function_call";

    if (!hasContent && !hasToolCalls && !hasReasoning && (!isNormalFinish || finish === "in_progress" || finish === "incomplete")) {
      return true;
    }
  }

  // Anthropic messages format
  if (Array.isArray(data.content)) {
    const hasContent = data.content.some((c) => (c.type === "text" && c.text?.trim().length > 0) || c.type === "tool_use");
    const stopReason = data.stop_reason;
    if (!hasContent && (!stopReason || stopReason === "in_progress" || stopReason === "incomplete")) {
      return true;
    }
  }

  return false;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback", "round-robin", or "smart"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @param {boolean} [options.autoSwitch=true] - Capability auto-switching
 * @param {string|null} [options.sessionId=null] - Client session identifier for prompt cache retention
 * @param {string} [options.smartPolicy="smart"] - Policy: "smart" (adaptive ≥80%), "strict" (lock 1st model), "per-turn", or "custom"
 * @param {boolean} [options.sessionSticky=true] - Keep chosen model across session requests to retain prompt cache
 * @param {number} [options.confidenceThreshold=0.8] - Minimum confidence required for model switch (0-1)
 * @param {Function|null} [options.resolveSmartChoice=null] - Smart router resolver callback: (body, models) => Promise<{ choice, probabilities, confidence } | null>
 * @param {Function|null} [options.onEmptyResponse=null] - Called as (modelStr, reason) when a
 *   member answers 2xx with no usable content. The host wires this to the account-health
 *   counter; open-sse itself must not touch the DB. Fail-open: a throw is swallowed.
 * @returns {Promise<Response>}
 */
export async function handleComboChat({
  body,
  models,
  handleSingleModel,
  log,
  comboName,
  comboStrategy,
  comboStickyLimit = 1,
  sourceFormat = null,
  autoSwitch = true,
  sessionId = null,
  smartPolicy = "smart",
  sessionSticky = true,
  confidenceThreshold = 0.8,
  resolveSmartChoice = null,
  onEmptyResponse = null,
  signal = null,
}) {
  if (signal?.aborted) {
    return new Response(JSON.stringify({ error: { message: "Request aborted" } }), {
      status: 499,
      headers: { "Content-Type": "application/json" },
    });
  }
  let rotatedModels = models;
  let activeStickyModel = null;

  if (comboStrategy === "smart") {
    const policy = (typeof smartPolicy === "string" ? smartPolicy : "smart").toLowerCase();
    const isPerTurn = policy === "per-turn" || sessionSticky === false;
    const isStrict = policy === "strict";

    let switchThreshold = 0.8;
    if (policy === "custom") {
      const custom = Number(confidenceThreshold);
      if (Number.isFinite(custom) && custom > 0) switchThreshold = custom;
    } else if (policy === "smart-switch-70") switchThreshold = 0.7;
    else if (policy === "smart-switch-90") switchThreshold = 0.9;
    else if (policy.startsWith("smart-switch") || policy === "smart") {
      const custom = Number(confidenceThreshold);
      if (Number.isFinite(custom) && custom > 0) switchThreshold = custom;
    }

    if (!isPerTurn && sessionId) {
      activeStickyModel = getStickyComboModel(comboName, sessionId, models);
    }

    if (activeStickyModel) {
      if (isStrict) {
        // Strict Lock: re-use sticky model without invoking System One (0ms, 0 extra tokens)
        rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
        log.info("COMBO", `smart-router [strict] locked session "${sessionId}" → ${activeStickyModel}`);
      } else if (typeof resolveSmartChoice === "function") {
        // Smart Switch (Adaptive): check if the user's task drastically shifted
        try {
          const smartResult = await resolveSmartChoice(body, models);
          const newChoice = smartResult?.choice;
          const conf = typeof smartResult?.confidence === "number" ? smartResult.confidence : null;

          if (newChoice && newChoice !== activeStickyModel && models.includes(newChoice) && conf !== null && conf >= switchThreshold) {
            // Task changed with high confidence: switch model and update session
            rotatedModels = orderModelsByChoice(models, smartResult);
            log.info("COMBO", `smart-router [smart-switch] task changed → switched from ${activeStickyModel} to ${newChoice} (confidence: ${conf} >= ${switchThreshold})`);
            if (sessionId) {
              setStickyComboModel(comboName, sessionId, newChoice);
              activeStickyModel = newChoice;
            }
          } else {
            // Stay on current model to preserve warm prompt cache
            rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
            log.info("COMBO", `smart-router [smart-switch] retained prompt cache model "${activeStickyModel}"`);
          }
        } catch (err) {
          // Fail open to active sticky model
          rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
          log.warn("COMBO", `smart-router error, retained model "${activeStickyModel}"`, { error: err?.message || String(err) });
        }
      } else {
        rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
      }
    } else if (typeof resolveSmartChoice === "function") {
      // Turn 1 or per-turn: evaluate System One to select initial model
      try {
        const smartResult = await resolveSmartChoice(body, models);
        const conf = typeof smartResult?.confidence === "number" ? smartResult.confidence : null;

        if (smartResult?.choice && models.includes(smartResult.choice)) {
          if (switchThreshold > 0 && conf !== null && conf < switchThreshold) {
            log.info("COMBO", `smart-router confidence (${conf}) below threshold (${switchThreshold}), fallback to order: [${models.join(", ")}]`);
          } else {
            rotatedModels = orderModelsByChoice(models, smartResult);
            log.info("COMBO", `smart-router selected ${smartResult.choice} (confidence: ${conf ?? "N/A"})`);
            if (!isPerTurn && sessionId) {
              setStickyComboModel(comboName, sessionId, smartResult.choice);
              activeStickyModel = smartResult.choice;
            }
          }
        } else {
          log.info("COMBO", `smart-router no decision, fallback to order: [${models.join(", ")}]`);
        }
      } catch (err) {
        log.warn("COMBO", `smart-router error, fallback to order: [${models.join(", ")}]`, { error: err?.message || String(err) });
      }
    }
  } else {
    // Apply rotation strategy if enabled
    rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);
  }

  // Auto-switch: float models that satisfy the request's required capabilities to the front.
  if (autoSwitch) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderByCapabilities(rotatedModels, required);
      if (reordered[0] !== rotatedModels[0]) {
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0]}`);
      }
      rotatedModels = reordered;
    }
  }
  
  let lastError = null;
  let earliestRetryAfter = null;
  let lastStatus = null;
  let requestScopedResult = null;

  // Read and discard a response body so the underlying stream is fully released
  // before we move on to the next combo member. Prevents "ReadableStream is
  // locked" when a later member reuses the same buffer or the caller retries.
  async function drainResponse(result) {
    try {
      if (result && result.body && !result.body.locked) {
        const reader = result.body.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
        reader.releaseLock();
      }
    } catch {
      // fail open: an undrained body is harmless for fallback
    }
  }

  for (let i = 0; i < rotatedModels.length; i++) {
    if (signal?.aborted) {
      log.warn("COMBO", "Client disconnected before next combo member; stopping fallback");
      return new Response(JSON.stringify({ error: { message: "Request aborted" } }), {
        status: 499,
        headers: { "Content-Type": "application/json" },
      });
    }

    const modelStr = rotatedModels[i];
    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    try {
      const result = await handleSingleModel(
        deepCopyBody(body),
        modelStr
      );
      
      // Success (2xx) - return response unless empty/zero-content on a non-final seat
      if (result.ok) {
        const isLastModel = i === rotatedModels.length - 1;
        if (!isLastModel) {
          const contentType = result.headers?.get?.("content-type") || "";
          if (contentType.toLowerCase().includes("text/event-stream")) {
            const peeked = await peekComboResponse(result, log, sourceFormat);
            if (peeked?.outcome === "empty" && !isNoRetryFinish(peeked.finishReason)) {
              lastError = "Zero usable content";
              lastStatus = 200;
              await reportEmptyResponse(onEmptyResponse, modelStr, "Zero usable content");
              await drainResponse(peeked.response);
              continue;
            }
            log.info("COMBO", `Model ${modelStr} succeeded`);
            return peeked?.response || result;
          }
          if (contentType.includes("application/json")) {
            let peekBody = null;
            try {
              peekBody = await result.clone().json();
            } catch {
              // Ignore JSON parse errors (incl. a locked/disturbed body)
            }
            if (peekBody && isZeroContentResponse(peekBody)) {
              log.warn("COMBO", `Model ${modelStr} returned HTTP 200 with zero usable content, falling back to next model`);
              lastError = "Zero usable content";
              lastStatus = 200;
              await reportEmptyResponse(onEmptyResponse, modelStr, "Zero usable content (JSON)");
              await drainResponse(result);
              continue;
            }
          }
        }

        log.info("COMBO", `Model ${modelStr} succeeded`);
        return result;
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      try {
        const errorBody = await result.clone().json();
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
        retryAfter = errorBody?.retryAfter || null;
      } catch {
        // Ignore JSON parse errors (incl. a locked/disturbed body)
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      // Check if should fallback to next model
      const { provider } = parseModel(modelStr);
      const { shouldFallback, cooldownMs, requestScoped } = checkFallbackError(result.status, errorText, 0, provider);

      if (!shouldFallback && !requestScoped) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return result;
      }

      // A request-scoped 4xx (validation failure, unsupported parameter, context
      // overflow) says this member cannot serve THIS request — not that the
      // credential is unhealthy. Members run on different providers with
      // different validation, so the next member may well serve it. Advance
      // without a cooldown, and without waiting: there is nothing to recover.
      // checkFallbackError() reports no account fallback here on purpose (a
      // request-scoped fault must not evict a healthy account from rotation).
      // Clear sticky lock when the active sticky model fails and we fall back
      if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
        clearStickyComboSession(comboName, sessionId);
      }
      if (requestScoped) {
        log.warn("COMBO", `Model ${modelStr} rejected the request (${result.status}), trying next`, { status: result.status });
        lastError = errorText || String(result.status);
        if (!lastStatus) lastStatus = result.status;
        if (!requestScopedResult) requestScopedResult = result.clone();
        await drainResponse(result);
        continue;
      }

      // For transient errors (503/502/504), wait for cooldown before falling through
      // so a briefly-overloaded provider gets a chance to recover rather than being
      // skipped immediately (fixes: combo falls through on transient 503).
      // The wait is abortable: a client that hangs up mid-cooldown should not keep
      // this loop parked for the full delay.
      const isTransient = cooldownMs > 0 && cooldownMs <= 5000 &&
        (result.status === 503 || result.status === 502 || result.status === 504);

      // Fallback to next model: release the failed member's stream before moving on.
      // Exactly one drain — the cooldown wait below reuses this call instead of
      // repeating it, so the body is never read twice.
      lastError = errorText || String(result.status);
      if (!lastStatus) lastStatus = result.status;
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
      await drainResponse(result);

      if (isTransient) {
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
        if (signal?.aborted) {
          log.warn("COMBO", "Client disconnected during cooldown; stopping fallback");
          return new Response(JSON.stringify({ error: { message: "Request aborted" } }), {
            status: 499,
            headers: { "Content-Type": "application/json" },
          });
        }
        await sleepAbortable(cooldownMs, signal);
      }
    } catch (error) {
      // Catch unexpected exceptions to ensure fallback continues. Stream-lock
      // races are retryable: the candidate already consumed/locked its body and
      // the next model is allowed to try. Do not treat this as a terminal model error.
      const locked = isLockedStreamError(error);
      if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
        clearStickyComboSession(comboName, sessionId);
      }
      lastError = error?.message || String(error);
      if (!lastStatus) lastStatus = 500;
      log.warn("COMBO", `Model ${modelStr} threw error during combo attempt`, {
        phase: "handleSingleModel",
        model: modelStr,
        lockedStream: locked,
        error: lastError,
        name: error?.name || "Error",
        stack: error?.stack ? String(error.stack).split("\n").slice(0, 4).join(" | ") : null,
      });
      if (locked) {
        log.warn("COMBO", `Model ${modelStr} stream was already locked, trying next`, { model: modelStr, error: lastError, lockedStream: true });
        continue;
      }
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError });
    }
  }

  // At least one member rejected the request itself. Hand back that member's own
  // response — status and body — rather than the synthesized envelope below: the
  // synthesized one reaches the client as a 200 carrying an error object, which
  // reads as an empty success, and it buries the member that named the real cause.
  // This is also what the caller saw before combos advanced on these errors.
  if (requestScopedResult) {
    log.warn("COMBO", `No model served the request; returning the first request-scoped failure (${requestScopedResult.status})`);
    return requestScopedResult;
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) - 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const allDisabled = lastError && lastError.toLowerCase().includes("no credentials");
  const status = allDisabled ? 503 : (lastStatus || 503);
  const msg = lastError || "All combo models unavailable";

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`);
    return unavailableResponse(status, msg, earliestRetryAfter, retryHuman);
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Extract assistant text from a non-stream completion across formats
 * (OpenAI chat, Claude messages, Gemini, OpenAI Responses). Returns "" if none.
 * Panel responses are already translated to the client format by chatCore, so the
 * leaf content→string step reuses the translator's own extractTextContent.
 */
function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";

  // OpenAI chat completion
  const choice = json.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  // Claude messages (text blocks share OpenAI's {type:"text"} shape)
  const claudeText = extractTextContent(json.content);
  if (claudeText.trim()) return claudeText;

  // Gemini (parts carry .text without a type discriminator)
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }

  // OpenAI Responses API
  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }

  return "";
}

/**
 * Append a synthesized user turn to whichever message array the request format uses.
 * Preserves the original conversation + system prompt so the judge has full context.
 */
function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [...body.contents, { role: "user", parts: [{ text }] }];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}

/**
 * Build the judge directive. Per OpenRouter's Fusion design, the judge does NOT
 * merge - it analyzes (consensus / contradictions / partial coverage / unique
 * insights / blind spots) then writes one answer grounded in that analysis.
 * ~3/4 of fusion's quality lift comes from this synthesis step.
 *
 * Sources are anonymized ("Source N") so the judge weighs substance, not the
 * reputation of a model brand.
 */
function buildJudgePrompt(answers) {
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text}`)
    .join("\n\n");

  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on - treat as higher-confidence), contradictions (where they disagree - resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis - more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

// Fusion tuning. Overridable per-combo via settings.comboStrategies[name].
const FUSION_DEFAULTS = {
  minPanel: 2,             // answers needed before stragglers get a grace window
  stragglerGraceMs: 8000,  // wait this long for laggards once quorum is reached
  panelHardTimeoutMs: 90000, // absolute cap so one hung model can't stall forever
};

/** Marker results the panel collector can receive in place of a Response. */
interface PanelTimeout {
  __timeout: true;
}

interface PanelError {
  __error: unknown;
}

type PanelOutcome<T> = T | PanelTimeout | PanelError;

// Resolve a Response (or {__error}) within ms; the loser keeps running but is ignored.
function withTimeout<T>(promise: Promise<T> | T, ms: number): Promise<PanelOutcome<T>> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); resolve({ __error: e }); });
  });
}

/**
 * Collect panel responses with quorum-grace: as soon as `minPanel` calls succeed,
 * start a short grace timer for the rest, then proceed with whatever arrived. This
 * caps the straggler penalty (the slowest model otherwise dominates wall time) while
 * still preferring a full panel when everyone is fast. Bounded by a hard timeout.
 * Returns a sparse array aligned to `calls` (undefined = not yet / dropped).
 */
function collectPanel<T>(
  calls: Array<Promise<PanelOutcome<T>> | PanelOutcome<T>>,
  { minPanel, stragglerGraceMs, panelHardTimeoutMs }: typeof FUSION_DEFAULTS
): Promise<Array<PanelOutcome<T> | undefined>> {
  return new Promise((resolve) => {
    const out: Array<PanelOutcome<T> | undefined> = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(out);
    };
    const hardTimer = setTimeout(finish, panelHardTimeoutMs);
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { out[i] = v; })
        .catch((e) => { out[i] = { __error: e }; })
        .finally(() => {
          settled++;
          if (out[i] && (out[i] as Response).ok) ok++;
          if (settled === calls.length) return finish();
          if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs);
        });
    });
  });
}

/**
 * Handle a fusion combo: fan the prompt out to every panel model in parallel,
 * then a judge model synthesizes one final answer from all panel responses.
 *
 * Panel calls are forced non-streaming with tools stripped (the judge needs
 * complete prose to synthesize). The judge call keeps the client's original
 * stream flag + tools, so streaming and downstream tool use still work.
 *
 * Speed: quorum-grace collection caps the straggler penalty. Quality: the judge
 * runs the consensus/contradiction/blind-spot analysis before writing.
 *
 * Degrades gracefully: 0 panel answers -> 503, exactly 1 -> return it directly.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Panel model strings
 * @param {Function} options.handleSingleModel - (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.judgeModel] - Judge model; falls back to panel[0]
 * @param {Object} [options.tuning] - Override FUSION_DEFAULTS (minPanel, grace, timeout)
 * @returns {Promise<Response>}
 */
export async function handleFusionChat({ body, models, handleSingleModel, log, comboName, judgeModel, tuning, signal = null }) {
  if (signal?.aborted) {
    return new Response(JSON.stringify({ error: { message: "Request aborted" } }), {
      status: 499,
      headers: { "Content-Type": "application/json" },
    });
  }

  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Fusion combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // A single-model fusion has nothing to fuse - just answer directly.
  if (panel.length === 1) {
    return handleSingleModel(deepCopyBody(body), panel[0]);
  }

  const cfg = { ...FUSION_DEFAULTS, ...(tuning || {}) };
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0];
  log.info("FUSION", `Combo "${comboName}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`);

  // 1. Fan out to the panel in parallel: non-streaming, tools stripped (we want prose).
  const { tools, tool_choice, stream_options, ...rest } = body;
  // Fusion runs panel models non-streaming; drop stream_options too, or providers
  // like DeepSeek reject it with "stream_options should be set along with stream = true".
  // See issue #3024.
  const panelBody = deepCopyBody({ ...rest, stream: false });

  // Flatten tool turns to prose so panel models keep context without emitting tool_calls.
  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = flattenToolHistory(panelBody.messages);
  } else if (Array.isArray(panelBody.input)) {
    panelBody.input = flattenToolHistory(panelBody.input);
  }

  const t0 = Date.now();
  // Copy the body per panel so translators in one parallel call cannot
  // mutate the objects used by the other panels.
  const calls = panel.map((m) => withTimeout(handleSingleModel(deepCopyBody(panelBody), m, true), cfg.panelHardTimeoutMs));
  const settled = await collectPanel(calls, { ...cfg, minPanel });
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);

  // 2. Collect successful answers.
  const answers = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const model = panel[i];
    if (!res) { log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`); continue; }
    if (res.__timeout) { log.warn("FUSION", `Panel ${model} timed out`); continue; }
    if (res.__error) { log.warn("FUSION", `Panel ${model} threw`, { error: res.__error?.message || String(res.__error) }); continue; }
    if (!res.ok) { log.warn("FUSION", `Panel ${model} failed`, { status: res.status }); continue; }
    try {
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (text) {
        answers.push({ model, text });
        log.info("FUSION", `Panel ${model} ok (${text.length} chars)`);
      } else {
        log.warn("FUSION", `Panel ${model} returned empty content`);
      }
    } catch (e) {
      log.warn("FUSION", `Panel ${model} unparseable`, { error: e.message || String(e) });
    }
  }

  // 3. Degrade gracefully when the panel is too thin to fuse.
  if (answers.length === 0) {
    log.warn("FUSION", "All panel models failed");
    return new Response(
      JSON.stringify({ error: { message: "All fusion panel models failed" } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  if (answers.length === 1) {
    log.info("FUSION", `Only ${answers[0].model} succeeded - answering directly (no fusion)`);
    return handleSingleModel(deepCopyBody(body), answers[0].model);
  }

  // 4. Judge analyzes + writes one final answer (streams to client if requested).
  const judgeBody = appendUserTurn(body, buildJudgePrompt(answers));
  log.info("FUSION", `Judging ${answers.length} answers with ${judge}`);
  return handleSingleModel(deepCopyBody(judgeBody), judge);
}

export {
  getStickyComboModel,
  setStickyComboModel,
  clearStickyComboSession,
  orderModelsByChoice,
} from "./systemoneRouter.ts";
