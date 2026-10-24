// Runtime interceptor for Custom Plugins.
//
// Plugins are REAL, not prompt injection:
//   - Image Vision (OCR Auto Image-to-Text): extracts text from attached images via
//     automatic scripting (sharp metadata/chunks/OCR transcript), converting image blocks
//     for text-only models and providing OCR enhancement for vision models.
//   - Think Deeper (Adaptive Thinking & Superpowers CoT): integrates Superpowers multi-perspective
//     reasoning, hypothesis stress-testing, and Chain of Thought with adaptive depth,
//     plus native reasoning parameters (reasoning_effort: high, Claude thinking budget).
//   - JSON Guard: repairs machine-readable output on the way back (fenced JSON,
//     prose around it, Python literals, a tail cut off by the output limit) and
//     removes tool-call argument names the declared schema never had.
//   - OpenAI Tool Bridge: recovers tool calls a text-only model wrote out in prose
//     and provides function calling to web-session or non-tool backends.
//   - Anti-Slop: injects anti-slop rules to strip generic AI cliches, robotic phrases,
//     and verbose preambles.
//
// Speed Mode (plugin 3) and Context Squeezer (plugin 5) removed per user configuration.

import { getSettings } from "@/lib/localDb";
import { matchesModel } from "@/shared/utils/pluginModelMatch";
import { FORMATS } from "open-sse/translator/formats.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { applyAntiSlop } from "open-sse/rtk/antislop.js";
import { injectSystemPrompt } from "open-sse/rtk/systemInject.js";
import { extractImageBuffer, convertImageToTextScript } from "./imageTextExtractor.js";

// Default plugin state for fresh installs / missing settings
const DEFAULT_PLUGINS = {
  imageVision: { enabled: false, models: [] },
  thinkDeeper: { enabled: false, models: [] },
  jsonGuard: { enabled: false, models: [] },
  openaiToolBridge: { enabled: false, models: [] },
  antiSlop: { enabled: false, models: [] },
};

// Cached plugin settings to avoid DB hits on every stream chunk
let cachedPlugins = null;
let lastFetch = 0;
const CACHE_TTL_MS = 2000;

async function getPluginConfig() {
  const now = Date.now();
  if (cachedPlugins && now - lastFetch < CACHE_TTL_MS) {
    return cachedPlugins;
  }
  try {
    const settings = await getSettings();
    cachedPlugins = settings?.customPlugins || DEFAULT_PLUGINS;
    lastFetch = now;
  } catch {
    cachedPlugins = DEFAULT_PLUGINS;
  }
  return cachedPlugins;
}

export function clearPluginCache() {
  cachedPlugins = null;
  lastFetch = 0;
}

/**
 * Every name this request could be called by, in the order the layers know it.
 */
export function modelKeysToTest(requestedModel, provider, model) {
  const keys = [
    requestedModel,
    `${provider}/${model}`,
    model,
  ].filter(Boolean);

  if (requestedModel && requestedModel.includes("/")) {
    keys.push(requestedModel.split("/").pop());
  }
  return keys;
}

/**
 * Image Vision / OCR Auto Image-to-Text - REAL Scripting Implementation.
 *
 * Scans incoming messages for image blocks. Converts image content into
 * structured OCR text transcripts via automated scripting.
 * - For text-only models (!caps?.vision): converts image blocks into clean text blocks
 *   so the model reads the image text without 400 errors.
 * - For vision models: appends the OCR transcript for enhanced accuracy.
 */
export async function applyImageVision(body, caps = null) {
  if (!body?.messages || !Array.isArray(body.messages)) return false;

  let foundImages = false;
  const isVisionModel = Boolean(caps?.vision);

  for (const msg of body.messages) {
    if (!Array.isArray(msg.content)) continue;

    const newContent = [];
    for (const block of msg.content) {
      const isImg =
        block?.type === "image_url" ||
        block?.type === "image" ||
        (block?.type === "tool_result" &&
          Array.isArray(block.content) &&
          block.content.some((c) => c?.type === "image_url" || c?.type === "image"));

      if (!isImg) {
        newContent.push(block);
        continue;
      }

      foundImages = true;
      const extracted = extractImageBuffer(block);
      let ocrText = "";
      if (extracted?.buffer) {
        ocrText = await convertImageToTextScript(extracted.buffer, extracted.mimeType);
      } else {
        const urlStr = block?.image_url?.url || "";
        ocrText = `\n\n[Attached Image Reference: ${urlStr.slice(0, 100)}]\n\n`;
      }

      if (isVisionModel) {
        // Keep original image block and prepend/append OCR transcript
        newContent.push(block);
        if (ocrText) {
          newContent.push({ type: "text", text: ocrText });
        }
      } else {
        // Text-only model: convert image to text block so model can parse it
        newContent.push({ type: "text", text: ocrText || "[Image Content Attached]" });
      }
    }
    msg.content = newContent;
  }

  if (foundImages) {
    const ocrNudge =
      "OCR Image-to-Text is active: image content has been transcribed to text. Answer questions with full awareness of the visual and textual data.";
    if (body.system && typeof body.system === "string") {
      if (!body.system.includes("OCR Image-to-Text")) {
        body.system = `${ocrNudge}\n\n${body.system}`;
      }
    } else {
      const sysIdx = body.messages.findIndex((m) => m.role === "system");
      if (sysIdx >= 0) {
        const sys = body.messages[sysIdx].content;
        if (typeof sys === "string" && !sys.includes("OCR Image-to-Text")) {
          body.messages[sysIdx].content = `${ocrNudge}\n\n${sys}`;
        }
      }
    }
  }

  return true;
}

/**
 * Adaptive Thinking & Superpowers Chain-of-Thought - REAL implementation.
 *
 * Combines Superpowers multi-perspective exploration, hypothesis stress-testing,
 * and adaptive Chain-of-Thought with native provider reasoning parameters.
 */
const ADAPTIVE_THINKING_SUPERPOWERS_PERSONA = `[Skill: Adaptive Thinking & Superpowers Chain-of-Thought Active]
You are equipped with advanced analytical superpowers and multi-step reasoning capabilities. For any non-trivial question, follow this adaptive reasoning protocol before formulating your final answer:

<thinking_process>
1. Problem Deconstruction: Identify core objectives, constraints, explicit requirements, and implicit nuances.
2. Hypothesis & Strategy: Consider 2-3 viable solution paths. Formulate hypotheses and identify potential pitfalls or edge cases.
3. Step-by-Step Resolution: Execute the selected strategy systematically. Show explicit intermediate logic, calculations, or code steps.
4. Self-Verification & Reflection: Stress-test intermediate findings against constraints. Check for logical consistency, boundary conditions, or unstated assumptions.
5. Synthesis: Deliver the final answer clearly, concisely, and directly, fully grounded in the verified reasoning steps.
</thinking_process>

Adaptive Depth Rule:
- For simple greetings, factual lookups, or straightforward tasks: keep reasoning lightweight and answer directly.
- For complex code, math, system architecture, or logical puzzles: engage the full multi-phase thinking process thoroughly.`;

export function applyThinkDeeper(body, sourceFormat) {
  if (!body) return;

  // Provider-native reasoning depth parameters
  if (sourceFormat === FORMATS.CLAUDE) {
    body.thinking = {
      type: "enabled",
      budget_tokens: body.thinking?.budget_tokens || 10240,
    };
  } else {
    body.reasoning_effort = "high";
    if (!body.reasoning) {
      body.reasoning = { effort: "high" };
    }
  }

  // Inject Superpowers CoT persona
  injectSystemPrompt(body, sourceFormat, ADAPTIVE_THINKING_SUPERPOWERS_PERSONA);
}

/* ------------------------------------------------------------------ *
 * JSON Guard - request side
 * ------------------------------------------------------------------ */

export function applyJsonGuardRequest(body, sourceFormat) {
  if (!body) return false;

  const alreadyAsked =
    body.response_format?.type === "json_object" ||
    body.response_format?.type === "json_schema";
  if (alreadyAsked) return false;

  const haystack = [
    typeof body.system === "string" ? body.system : "",
    Array.isArray(body.messages)
      ? body.messages
          .filter((m) => m?.role === "system" || m?.role === "user")
          .slice(0, 4)
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .join(" ")
      : "",
  ]
    .join(" ")
    .slice(0, 4000);

  const wantsJson =
    /\b(?:respond|reply|answer|return|output|produce)\b[^.!?]{0,40}\bjson\b/i.test(haystack) ||
    /\bjson\s+only\b/i.test(haystack) ||
    /\bonly\s+(?:output|return)\s+json\b/i.test(haystack);
  if (!wantsJson) return false;

  if (sourceFormat === FORMATS.CLAUDE) {
    if (typeof body.system === "string" && !body.system.includes("valid JSON")) {
      body.system = `${body.system}\n\nJSON Guard is active: answer with one valid JSON value and nothing else - no prose, no markdown fence.`;
    } else {
      const sysIdx = Array.isArray(body.messages) ? body.messages.findIndex((m) => m.role === "system") : -1;
      const note = "JSON Guard is active: answer with one valid JSON value and nothing else - no prose, no markdown fence.";
      if (sysIdx >= 0 && typeof body.messages[sysIdx].content === "string") {
        body.messages[sysIdx].content = `${body.messages[sysIdx].content}\n\n${note}`;
      } else {
        body.messages = [{ role: "system", content: note }, ...(body.messages || [])];
      }
    }
  } else {
    body.response_format = { type: "json_object" };
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * OpenAI Tool Bridge - request side
 * ------------------------------------------------------------------ */

export function applyOpenAIToolBridgeRequest(body, provider, model) {
  if (!body) return false;
  if (!Array.isArray(body.tools) || !body.tools.length) {
    if (!Array.isArray(body.functions) || !body.functions.length) return false;
  }
  body._openaiToolBridge = {
    provider,
    model,
    tools: Array.isArray(body.tools) ? body.tools : [],
    functions: Array.isArray(body.functions) ? body.functions : [],
  };

  let caps = null;
  try {
    caps = getCapabilitiesForModel(provider, model);
  } catch {
    caps = null;
  }
  if (caps && caps.tools === false) {
    delete body.tools;
    delete body.tool_choice;
    if (Array.isArray(body.functions)) body.functions = [];
    return true;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

export async function applyCustomPlugins(body, provider, model, sourceFormat, requestedModel) {
  const config = await getPluginConfig();
  const keysToTest = modelKeysToTest(requestedModel, provider, model);
  const checkMatch = (modelList) => keysToTest.some((key) => matchesModel(modelList, key));

  let caps = null;
  try {
    caps = getCapabilitiesForModel(provider, model);
  } catch {
    caps = null;
  }

  const result = {
    isVisionActive: false,
    isThinkDeeperActive: false,
    isJsonGuardActive: false,
    isToolBridgeActive: false,
    isAntiSlopActive: false,
  };

  if (config.imageVision?.enabled && checkMatch(config.imageVision.models)) {
    result.isVisionActive = true;
    await applyImageVision(body, caps);
  }

  if (config.thinkDeeper?.enabled && checkMatch(config.thinkDeeper.models)) {
    result.isThinkDeeperActive = true;
    applyThinkDeeper(body, sourceFormat);
  }

  if (config.jsonGuard?.enabled && checkMatch(config.jsonGuard.models)) {
    result.isJsonGuardActive = true;
    applyJsonGuardRequest(body, sourceFormat);
  }

  if (config.openaiToolBridge?.enabled && checkMatch(config.openaiToolBridge.models)) {
    result.isToolBridgeActive = applyOpenAIToolBridgeRequest(body, provider, model);
  }

  if (config.antiSlop?.enabled && checkMatch(config.antiSlop.models)) {
    result.isAntiSlopActive = true;
    applyAntiSlop(body, sourceFormat, config.antiSlop.level);
  }

  return result;
}

export { getPluginConfig };
