import { extractAssistantText, formatGatewayError } from "./modelResponse.ts";

// One streaming chat-completions client, so Compare Models talks to the gateway through
// exactly the same code as any other client.

/** Error thrown by the gateway, carrying the parsed detail for the UI. */
export interface ChatStreamError extends Error {
  detail?: string;
  status?: string;
  cooldown?: unknown;
  model?: string;
}

/** Gateway error shape returned by `formatGatewayError`. */
interface GatewayErrorInfo {
  message: string;
  detail?: string;
  status?: string | number;
  cooldown?: unknown;
  model?: string;
}

function buildError(info: GatewayErrorInfo, status: number | string | null): ChatStreamError {
  const err = new Error(info.message) as ChatStreamError;
  err.detail = info.detail;
  err.status = info.status != null ? String(info.status) : String(status || "");
  err.cooldown = info.cooldown;
  err.model = info.model || "";
  return err;
}

/** Options accepted by {@link streamChatCompletion}. */
export interface StreamChatCompletionOptions {
  model: string;
  messages: unknown[];
  apiKey?: string;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  maxTokens?: number;
  stream?: boolean;
  endpoint?: string;
}

/** Aggregated result of one streamed chat request. */
export interface StreamChatCompletionResult {
  kind: "text" | "thinking" | "tool" | "empty";
  text: string;
  thinking: string;
  toolCalls: unknown[];
  finishReason: string;
  usage: unknown;
  ms: number;
  ttftMs: number | null;
}

function collectUsage(seen: unknown, candidate: unknown): unknown {
  if (!candidate || typeof candidate !== "object") return seen;
  const record = candidate as Record<string, unknown>;
  const hasTokens = record.prompt_tokens ?? record.completion_tokens ?? record.total_tokens;
  return hasTokens ? candidate : seen;
}

/**
 * Sends one chat request and streams the answer.
 * Resolves with `{ text, thinking, kind, usage, ms, ttftMs }`; throws an Error
 * carrying `.detail`, `.status` and `.cooldown` when the gateway reports failure.
 */
export async function streamChatCompletion({
  model,
  messages,
  apiKey,
  signal,
  onDelta,
  onThinking,
  maxTokens,
  stream = true,
  endpoint = "/v1/chat/completions",
}: StreamChatCompletionOptions): Promise<StreamChatCompletionResult> {
  const started = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body: Record<string, unknown> & { stream?: boolean } = {
    model,
    messages,
    ...(Number(maxTokens) > 0 ? { max_tokens: Number(maxTokens) } : {}),
  };
  if (stream) body.stream = true;

  let res;
  try {
    res = await fetch(endpoint, { method: "POST", headers, signal, body: JSON.stringify(body) });
  } catch (err) {
    const error = err as Error | undefined;
    if (error?.name === "AbortError") throw err;
    throw buildError(formatGatewayError(error?.message || "Request failed"), "");
  }

  if (!res.ok) {
    const bad = await res.json().catch(() => ({}));
    throw buildError(formatGatewayError(bad?.error || bad?.message || bad), res.status);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!stream || !res.body || !contentType.includes("event-stream")) {
    const json = await res.json().catch(() => ({}));
    const answer = extractAssistantText(json);
    const out = answer.kind === "thinking" ? answer.thinking : answer.text;
    if (out && onDelta) onDelta(out);
    return {
      ...answer,
      usage: json?.usage || null,
      ms: Date.now() - started,
      ttftMs: answer.kind === "empty" ? null : Date.now() - started,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let thinking = "";
  let usage: unknown = null;
  let finishReason = "";
  let ttftMs: number | null = null;

  const emit = (chunk: string, sink: (value: string) => void) => {
    if (!chunk) return;
    if (ttftMs === null) ttftMs = Date.now() - started;
    sink(chunk);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          nl = -1;
          break;
        }
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta || parsed?.choices?.[0] || {};
          const piece = typeof delta.content === "string" ? delta.content : "";
          const think = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
          if (piece) {
            text += piece;
            emit(piece, (v) => onDelta && onDelta(v));
          }
          if (think) {
            thinking += think;
            if (ttftMs === null) ttftMs = Date.now() - started;
            if (onThinking) onThinking(think);
            else if (onDelta) onDelta(think);
          }
          if (parsed?.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
          usage = collectUsage(usage, parsed?.usage);
        } catch {
          /* keep-alive and non-JSON frames are ignored */
        }
      }
      nl = buffer.indexOf("\n");
    }
  }

  const kind = text.trim() ? "text" : thinking.trim() ? "thinking" : "empty";
  return {
    kind,
    text,
    thinking,
    toolCalls: [],
    finishReason,
    usage,
    ms: Date.now() - started,
    ttftMs,
  };
}
