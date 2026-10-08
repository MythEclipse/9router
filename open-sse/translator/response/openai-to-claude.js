import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, CLAUDE_BLOCK, MODEL_FALLBACK } from "../schema/index.js";
import { fromOpenAIFinish } from "../concerns/finishReason.js";
import { extractReasoningText } from "../concerns/reasoning.js";

// Legacy "proxy_" prefix used by older request translators. Response strips it
// defensively so tool names from such turns resolve back (e.g. proxy_Read → Read
// for arg sanitization). Current request translator emits no prefix ("") — strip
// is then a no-op. Kept intentionally; do NOT couple to request's empty prefix.
const CLAUDE_OAUTH_TOOL_PREFIX = "proxy_";

// Sanitize tool call arguments to fix bad params from non-Anthropic models
function sanitizeToolArgs(toolName, argsJson) {
  try {
    const args = JSON.parse(argsJson);
    const name = toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
      ? toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
      : toolName;
    if (name === "Read") sanitizeReadArgs(args);
    return JSON.stringify(args);
  } catch {
    return argsJson;
  }
}

function sanitizeReadArgs(args) {
  if (typeof args.limit === "string" && /^\d+$/.test(args.limit)) args.limit = Number(args.limit);
  if (typeof args.offset === "string" && /^-?\d+$/.test(args.offset)) args.offset = Number(args.offset);

  if (typeof args.limit === "number") {
    if (args.limit > 2000) args.limit = 2000;
    if (args.limit < 1) delete args.limit;
  }
  if (typeof args.offset === "number" && args.offset < 0) args.offset = 0;

  if ("pages" in args && !isValidPdfPagesArg(args.file_path, args.pages)) {
    delete args.pages;
  }
}

function isValidPdfPagesArg(filePath, pages) {
  return typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".pdf") &&
    typeof pages === "string" &&
    /^\d+(?:-\d+)?$/.test(pages);
}

// Helper: stop thinking block if started
function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({
    type: "content_block_stop",
    index: state.thinkingBlockIndex
  });
  state.thinkingBlockStarted = false;
}

// Helper: stop text block if started
function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({
    type: "content_block_stop",
    index: state.textBlockIndex
  });
  state.textBlockStarted = false;
}

// Convert OpenAI stream chunk to Claude format
export function openaiToClaudeResponse(chunk, state) {
  // End-of-stream flush: stream.js calls translateResponse(..., null, state)
  // when the upstream body closes ([DONE], final buffer flush, or a relay that
  // dropped the connection mid-stream — e.g. the Vercel relays' 25s
  // FUNCTION_INVOCATION_TIMEOUT). If the upstream never sent a finish frame,
  // everything we emitted so far may be just message_start, and the client
  // then aborts with "Streaming response ended before any complete data was
  // received" / StreamNoEventsError ("1 stream event received... none in the
  // final 5 ms") because no message_stop ever arrived. Close the message
  // ourselves: stop any open block, emit message_delta + message_stop, and
  // return null if the message was never opened (nothing to salvage).
  if (!chunk) {
    if (!state?.messageStartSent || state.messageStopped) return null;

    const results = [];
    if (state.textBlockStarted) {
      results.push({ type: "content_block_stop", index: state.textBlockIndex });
      state.textBlockStarted = false;
      state.textBlockClosed = true;
    }
    if (state.thinkingBlockStarted) {
      results.push({ type: "content_block_stop", index: state.thinkingBlockIndex });
      state.thinkingBlockStarted = false;
      state.thinkingBlockClosed = true;
    }

    state.messageStopped = true;
    state.finishReason = state.finishReason || "stop";
    results.push({
      type: "message_delta",
      delta: { stop_reason: convertFinishReason(state.finishReason) },
      usage: state.usage || { input_tokens: 0, output_tokens: 0 }
    });
    results.push({ type: "message_stop" });
    return results;
  }

  // OpenAI-compatible upstreams (notably the OpenCode zen relay / poolside)
  // sometimes emit a usage-only terminal frame as the FIRST and ONLY frame of
  // a stream:  data: {"id":"mai-api-...","object":"chat.completion.chunk",
  // "choices":[],"usage":{...}}
  // when the model produced no content at all (empty completion, immediate
  // stop). With `chunk.choices?.[0]` nil this short-circuited below, so the
  // translate mode emitted nothing — the client saw an HTTP 200 SSE stream
  // with zero events and Anthropic SDKs failed with StreamNoEventsError
  // ("no_events, ... 1 stream event received") / "empty or malformed response
  // (HTTP 200)". Treat it as a legitimate empty completion: synthesize the
  // full message (message_start → empty text block → message_delta → stop)
  // with the tracked usage so the client gets a complete, well-formed message.
  //
  // A delta-less keep-alive frame (choices[0].delta == null, no finish_reason)
  // is NOT terminal: it only synthesizes message_start when nothing has been
  // emitted yet (again so an empty first frame can't become a no_events
  // failure) and is otherwise a no-op.
  if (!chunk.choices?.length || !chunk.choices[0].delta) {
    const results = [];

    // Track usage from OpenAI chunk if available
    if (chunk.usage && typeof chunk.usage === "object") {
      const promptTokens = typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : 0;
      const outputTokens = typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : 0;
      const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
      const cacheCreationTokens = chunk.usage.prompt_tokens_details?.cache_creation_tokens;
      const cacheReadTokens = typeof cachedTokens === "number" ? cachedTokens : 0;
      const cacheCreateTokens = typeof cacheCreationTokens === "number" ? cacheCreationTokens : 0;
      const inputTokens = promptTokens - cacheReadTokens - cacheCreateTokens;
      state.usage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cacheReadTokens > 0 ? { cache_read_input_tokens: cacheReadTokens } : {}),
        ...(cacheCreateTokens > 0 ? { cache_creation_input_tokens: cacheCreateTokens } : {})
      };
    }

    const emptyChoicesTerminal = !chunk.choices?.length;
    const alreadyStopped = state.finishReason || state.messageStopped;

    // First chunk - ALWAYS send message_start first
    if (!state.messageStartSent) {
      state.messageStartSent = true;
      state.messageId = chunk.id?.replace("chatcmpl-", "") || `msg_${Date.now()}`;
      if (!state.messageId || state.messageId === "chat" || state.messageId.length < 8) {
        state.messageId = chunk.extend_fields?.requestId ||
          chunk.extend_fields?.traceId ||
          `msg_${Date.now()}`;
      }
      state.model = chunk.model || MODEL_FALLBACK;
      state.nextBlockIndex = 0;
      results.push({
        type: "message_start",
        message: {
          id: state.messageId,
          type: "message",
          role: ROLE.ASSISTANT,
          model: state.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      });
    }

    // Empty-choices = terminal usage frame: close the message cleanly with an
    // empty text block + stop so the client has a complete, zero-content turn.
    if (emptyChoicesTerminal) {
      if (!alreadyStopped && !state.textBlockStarted && !state.thinkingBlockStarted) {
        state.textBlockIndex = state.nextBlockIndex++;
        state.textBlockStarted = true;
        state.textBlockClosed = false;
        results.push({
          type: "content_block_start",
          index: state.textBlockIndex,
          content_block: { type: CLAUDE_BLOCK.TEXT, text: "" }
        });
        state.textBlockClosed = true;
        state.textBlockStarted = false;
        results.push({
          type: "content_block_stop",
          index: state.textBlockIndex
        });
      }

      if (!alreadyStopped) {
        state.finishReason = "stop";
        state.messageStopped = true;
        const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
        results.push({
          type: "message_delta",
          delta: { stop_reason: convertFinishReason("stop") },
          usage: finalUsage
        });
        results.push({ type: "message_stop" });
      }
    }

    return results.length > 0 ? results : null;
  }

  const results = [];
  const choice = chunk.choices[0];
  const delta = choice.delta;

  // Track usage from OpenAI chunk if available
  if (chunk.usage && typeof chunk.usage === "object") {
    const promptTokens = typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : 0;
    const outputTokens = typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : 0;

    // Extract cache tokens from prompt_tokens_details
    const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
    const cacheCreationTokens = chunk.usage.prompt_tokens_details?.cache_creation_tokens;
    const cacheReadTokens = typeof cachedTokens === "number" ? cachedTokens : 0;
    const cacheCreateTokens = typeof cacheCreationTokens === "number" ? cacheCreationTokens : 0;

    // input_tokens = prompt_tokens - cached_tokens - cache_creation_tokens
    // Because OpenAI's prompt_tokens includes all prompt-side tokens
    const inputTokens = promptTokens - cacheReadTokens - cacheCreateTokens;

    state.usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    };

    // Add cache_read_input_tokens if present
    if (cacheReadTokens > 0) {
      state.usage.cache_read_input_tokens = cacheReadTokens;
    }

    // Add cache_creation_input_tokens if present
    if (cacheCreateTokens > 0) {
      state.usage.cache_creation_input_tokens = cacheCreateTokens;
    }

    // Note: completion_tokens_details.reasoning_tokens is already included in output_tokens
    // No need to add separately as Claude expects total output_tokens
  }

  // First chunk - ALWAYS send message_start first
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId = chunk.id?.replace("chatcmpl-", "") || `msg_${Date.now()}`;
    if (!state.messageId || state.messageId === "chat" || state.messageId.length < 8) {
      state.messageId = chunk.extend_fields?.requestId ||
        chunk.extend_fields?.traceId ||
        `msg_${Date.now()}`;
    }
    state.model = chunk.model || MODEL_FALLBACK;
    state.nextBlockIndex = 0;
    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: ROLE.ASSISTANT,
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  // Handle reasoning (thinking) across vendor shapes - GLM/DeepSeek/Qwen/MiniMax/etc.
  const reasoningContent = extractReasoningText(delta);
  if (reasoningContent) {
    stopTextBlock(state, results);

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: CLAUDE_BLOCK.THINKING, thinking: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent }
    });
  }

  // Handle regular content
  if (delta?.content) {
    stopThinkingBlock(state, results);

    if (!state.textBlockStarted) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: CLAUDE_BLOCK.TEXT, text: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: delta.content }
    });
  }

  // Tool calls
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;

      // GLM/fireworks repeats id+null-name on every arg chunk; open block once per idx
      if (tc.id && !state.toolCalls.has(idx)) {
        stopThinkingBlock(state, results);
        stopTextBlock(state, results);

        const toolBlockIndex = state.nextBlockIndex++;
        state.toolCalls.set(idx, { id: tc.id, name: tc.function?.name || "", blockIndex: toolBlockIndex });

        // Strip prefix from tool name for response
        let toolName = tc.function?.name || "";
        if (toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
          toolName = toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
        }

        results.push({
          type: "content_block_start",
          index: toolBlockIndex,
          content_block: {
            type: CLAUDE_BLOCK.TOOL_USE,
            id: tc.id,
            name: toolName,
            input: {}
          }
        });
      }

      if (tc.function?.arguments) {
        const toolInfo = state.toolCalls.get(idx);
        if (toolInfo) {
          // Buffer args instead of streaming — sanitize at finish to fix bad params
          if (!state.toolArgBuffers) state.toolArgBuffers = new Map();
          state.toolArgBuffers.set(idx, (state.toolArgBuffers.get(idx) || "") + tc.function.arguments);
        }
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    for (const [idx, toolInfo] of state.toolCalls) {
      // Emit buffered + sanitized args as single delta before stop
      const buffered = state.toolArgBuffers?.get(idx);
      if (buffered) {
        const sanitized = sanitizeToolArgs(toolInfo.name, buffered);
        results.push({
          type: "content_block_delta",
          index: toolInfo.blockIndex,
          delta: { type: "input_json_delta", partial_json: sanitized }
        });
      }
      results.push({
        type: "content_block_stop",
        index: toolInfo.blockIndex
      });
    }

    // Mark finish for later usage injection in stream.js
    state.finishReason = choice.finish_reason;
    state.messageStopped = true;

    // Use tracked usage (will be estimated in stream.js if not valid)
    const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
    results.push({
      type: "message_delta",
      delta: { stop_reason: convertFinishReason(choice.finish_reason) },
      usage: finalUsage
    });
    results.push({ type: "message_stop" });
  }

  return results.length > 0 ? results : null;
}

const convertFinishReason = (reason) => fromOpenAIFinish(reason, "claude");

// Register
register(FORMATS.OPENAI, FORMATS.CLAUDE, null, openaiToClaudeResponse);
