import { randomUUID } from "node:crypto";
import { DefaultExecutor } from "./default.ts";
import { proxyAwareFetch } from "../utils/proxyFetch.ts";
import { buildStreamErrorBytes } from "../utils/streamHelpers.ts";
import { normalizePerchExpiry, readPerchCliSession, type PerchCliSession } from "../shared/perchCredentials.ts";
import type { ChatRequestBody, Credentials, ExecuteOptions, ExecutorResult } from "../types.ts";

const MODEL_OPTIONS: Record<string, string> = {
  "gemini-4-argon": "gemini-gemini-4-argon",
  "claude-opus-5.5": "anthropic-claude-opus-5-5",
  "claude-sonnet-5.5": "anthropic-claude-sonnet-5-5",
  "claude-haiku-5.5": "anthropic-claude-haiku-5-5",
  "gpt-6.1-sol": "azure-foundry-gpt-6-1-sol",
  "gpt-6-sol": "azure-foundry-gpt-6-sol",
  "gpt-6-luna": "azure-foundry-gpt-6-luna",
  "gpt-5.6-sol": "azure-foundry-gpt-5-6-sol",
  "gpt-5.6-luna": "azure-foundry-gpt-5-6-luna",
  "gpt-5.6-terra": "azure-foundry-gpt-5-6-terra",
  "grok-4.7": "azure-foundry-grok-4-7",
  "grok-4.6": "bedrock-mantle-xai-grok-4-6",
  "kimi-3.1-pro": "openrouter-moonshotai-kimi-k3-1-pro",
  "kimi-3": "azure-foundry-fw-kimi-k3",
  "kimi-2.7": "wandb-kimi-k2-7-code",
  "deepseek-v4.1-flash": "dashscope-deepseek-v4-1-flash",
  "deepseek-v4.1-flash-1017": "openrouter-deepseek-deepseek-v4-1-flash-1017",
  "deepseek-v4": "wandb-deepseek-ai-deepseek-v4-pro",
  "deepseek-flash-starter": "openrouter-deepseek-deepseek-v4-1-flash-1017-cloudflare",
  "glm-5.3": "azure-foundry-fw-glm-5-3",
  "glm-5.3-flash": "wandb-zai-org-glm-5-3-flash",
  "glm-5.3-flash-starter": "openrouter-z-ai-glm-5-3-flash",
  "glm-5.2": "wandb-zai-org-glm-5-2",
  "qwen-3.8-max": "openrouter-qwen-qwen3-8-max-0902",
  "qwen-3.8": "wandb-qwen-qwen3-8-27b",
  "qwen-3.8-flash": "openrouter-qwen-qwen3-8-flash",
  "qwen-3.7-plus": "fireworks-accounts-fireworks-models-qwen3p7-plus",
  "minimax-m3": "wandb-minimax-m3",
  "minimax-m3.1-flash-starter": "openrouter-minimax-minimax-m3-1-flash-free",
  "beam-1.0": "wandb-reflection-beam-1-0-501b-a23b",
  "beam-1.0-starter": "openrouter-reflection-beam-1-0-501b-a23b",
  "nemotron-ultra": "wandb-nvidia-nvidia-nemotron-3-ultra-550b-a55b",
  "nemotron-lightning": "wandb-nvidia-nvidia-nemotron-3-5-lightning-30b-a3b",
  "laguna-s": "poolside-poolside-laguna-s-2-1",
  inkling: "fireworks-accounts-fireworks-models-inkling",
};

const AUTO_TIERS = new Set(["standard", "pro", "starter", "standard_max", "pro_max"]);
const TICKET_CACHE = new Map<string, { ticket: string; runId: string; expiresAt: number }>();
const DEFAULT_APP_URL = "https://app.perchai.app";
const SUPABASE_ANON_KEY = process.env.PERCHAI_SUPABASE_ANON_KEY || "";

type PerchSession = PerchCliSession;

async function refreshSession(session: PerchSession, proxyOptions: ExecuteOptions["proxyOptions"]): Promise<PerchSession | null> {
  if (!session.refreshToken) return null;
  if (!SUPABASE_ANON_KEY) {
    throw new Error("PERCHAI_SUPABASE_ANON_KEY is required to refresh Perch AI OAuth sessions");
  }
  const response = await proxyAwareFetch(
    "https://zlfuvsfjtgsdtqcaykia.supabase.co/auth/v1/token?grant_type=refresh_token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    },
    proxyOptions,
  );
  if (!response.ok) return null;
  const token = await response.json();
  if (typeof token.access_token !== "string") {
    throw new Error("Perch AI refresh response did not contain an access token");
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || session.refreshToken,
    expiresAt: normalizePerchExpiry(token.expires_at) || Math.floor(Date.now() / 1000) + (Number(token.expires_in) || 3600),
    userId: token.user?.id || session.userId,
    email: token.user?.email || session.email,
    appUrl: DEFAULT_APP_URL,
  };
}

async function resolveSession(
  credentials: Credentials,
  proxyOptions: ExecuteOptions["proxyOptions"],
): Promise<PerchSession | null> {
  const accessToken = credentials.accessToken || credentials.apiKey;
  const refreshToken = credentials.refreshToken || credentials.providerSpecificData?.refreshToken;
  const expiresAtRaw = credentials.expiresAt ?? credentials.providerSpecificData?.expiresAt;
  const expiresAt = normalizePerchExpiry(expiresAtRaw);

  let session: PerchSession | null = typeof accessToken === "string" && accessToken.trim()
    ? { accessToken: accessToken.trim(), refreshToken: typeof refreshToken === "string" ? refreshToken : undefined, expiresAt }
    : readPerchCliSession();
  if (!session) return null;
  if (session.expiresAt && session.expiresAt <= Math.floor(Date.now() / 1000) + 90 && session.refreshToken) {
    const refreshed = await refreshSession(session, proxyOptions);
    if (refreshed) {
      session = refreshed;
      if (credentials && typeof credentials === "object") {
        credentials.accessToken = refreshed.accessToken;
        credentials.apiKey = refreshed.accessToken;
        credentials.refreshToken = refreshed.refreshToken;
        credentials.expiresAt = refreshed.expiresAt;
      }
    }
  }
  return session;
}

function buildRequestBody(model: string, body: ChatRequestBody, runId: string, withTicket: boolean) {
  const cleanModel = model.replace(/^perch(ai)?\//i, "").trim().toLowerCase() || "standard";
  const isAutoTier = AUTO_TIERS.has(cleanModel);
  const request = body as ChatRequestBody & Record<string, unknown>;
  return {
    request: {
      messages: Array.isArray(request.messages) ? request.messages : [],
      ...(Array.isArray(request.tools) && request.tools.length ? { tools: request.tools } : {}),
      ...(request.max_tokens ? { maxTokens: request.max_tokens } : {}),
      ...(request.max_completion_tokens ? { maxTokens: request.max_completion_tokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.tool_choice ? { toolChoice: request.tool_choice } : {}),
      ...(request.response_format ? { responseFormat: request.response_format } : {}),
    },
    runId,
    lane: "chat",
    strictManual: false,
    ...(withTicket ? { clientSurface: "cli" } : {}),
    preferredModelId: isAutoTier ? null : cleanModel,
    avoidModelIds: [],
    attribution: null,
    ...(isAutoTier
      ? { roostModelChoice: cleanModel, roostReasoning: true, effort: { level: "high", orchestration: false } }
      : { manualModelOptionId: MODEL_OPTIONS[cleanModel] || cleanModel }),
  };
}

function encodeSse(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function toToolCalls(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((tool, index) => {
    const item = tool && typeof tool === "object" ? tool as Record<string, unknown> : {};
    const fn = item.function && typeof item.function === "object" ? item.function as Record<string, unknown> : {};
    const args = item.arguments ?? fn.arguments;
    return {
      index,
      id: typeof item.id === "string" ? item.id : `call_${index}`,
      type: "function",
      function: {
        name: String(item.name || fn.name || ""),
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      },
    };
  });
}

function wrapStream(response: Response, model: string): Response {
  if (!response.body) throw new Error("Perch AI returned an empty streaming response");
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-perch-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let roleSent = false;
  let ended = false;

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: unknown) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { ...(!roleSent ? { role: "assistant" } : {}), ...delta }, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  });
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, delta: Record<string, unknown>, finishReason: string | null = null, usage?: unknown) => {
    roleSent = true;
    controller.enqueue(encodeSse(chunk(delta, finishReason, usage)));
  };
  const finish = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (ended) return;
    ended = true;
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  };
  const fail = (controller: TransformStreamDefaultController<Uint8Array>, message: string) => {
    if (ended) return;
    ended = true;
    controller.enqueue(buildStreamErrorBytes(502, message, null));
  };
  const processLine = (raw: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    let line = raw.trim();
    if (!line || line.startsWith(":")) return;
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (!line || line === "[DONE]") {
      finish(controller);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") return;
    const event = payload as Record<string, unknown>;
    if (event.type === "answer_delta" && typeof event.text === "string") emit(controller, { content: event.text });
    else if (event.type === "reasoning_delta" && typeof event.text === "string") emit(controller, { reasoning_content: event.text });
    else if ((event.type === "tool_call_delta" || event.type === "tool_use_end") && Array.isArray(event.toolCalls)) {
      emit(controller, { tool_calls: toToolCalls(event.toolCalls) });
    } else if (event.type === "error" || (event.type === "done" && event.ok === false)) {
      const detail = event.message || event.error;
      const errorMessage = typeof detail === "string"
        ? detail
        : detail && typeof detail === "object" && "message" in detail
          ? String(detail.message)
          : "Perch AI model call failed";
      fail(controller, errorMessage);
    } else if (event.type === "done") {
      const calls = toToolCalls(event.toolCalls);
      emit(controller, calls.length ? { tool_calls: calls } : {}, calls.length ? "tool_calls" : "stop", event.usage);
      finish(controller);
    }
  };

  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        processLine(buffer.slice(0, newline), controller);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim()) processLine(buffer, controller);
      finish(controller);
    },
  }));
  return new Response(stream, {
    status: response.status,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

async function wrapNonStream(response: Response, model: string): Promise<Response> {
  const payload = await response.json() as Record<string, unknown>;
  if (payload.ok === false || payload.error) {
    const detail = payload.error;
    const message = typeof detail === "string"
      ? detail
      : detail && typeof detail === "object" && "message" in detail
        ? String(detail.message)
        : "Perch AI model call failed";
    throw new Error(message);
  }
  const text = String(payload.answer || payload.content || payload.text || "");
  const reasoning = typeof payload.reasoning === "string" ? payload.reasoning : undefined;
  const toolCalls = toToolCalls(payload.toolCalls);
  const message = {
    role: "assistant",
    content: text || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index: _index, ...tool }) => tool) } : {}),
  };
  return Response.json({
    id: `chatcmpl-perch-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: payload.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

async function getTicket(appUrl: string, token: string, proxyOptions: ExecuteOptions["proxyOptions"]) {
  const cached = TICKET_CACHE.get(token);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached;
  const response = await proxyAwareFetch(`${appUrl}/api/perch-terminal/turn-ticket`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "perchai-cli/2.4.118",
      "x-perch-locale": "en",
    },
    body: "{}",
  }, proxyOptions);
  if (!response.ok) return null;
  const data = await response.json() as Record<string, unknown>;
  const ticket = typeof data.ticket === "string" ? data.ticket : "";
  if (!ticket) return null;
  const expiresAt = data.expiresAt ? Date.parse(String(data.expiresAt)) : Date.now() + 300_000;
  const value = {
    ticket,
    runId: typeof data.runId === "string" ? data.runId : `cli-turn-${randomUUID()}`,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 300_000,
  };
  TICKET_CACHE.set(token, value);
  return value;
}

export class PerchAiExecutor extends DefaultExecutor {
  constructor(provider = "perchai") {
    super(provider);
  }

  async execute(options: ExecuteOptions): Promise<ExecutorResult> {
    const { model, body, stream, credentials, signal, proxyOptions = null } = options;
    const session = await resolveSession(credentials, proxyOptions);
    if (!session?.accessToken) {
      throw new Error("Perch AI authentication is missing. Sign in or import a Perch CLI session.");
    }
    const appUrl = DEFAULT_APP_URL;
    const ticket = await getTicket(appUrl, session.accessToken, proxyOptions);
    const runId = ticket?.runId || `cli-turn-${randomUUID()}`;
    const payload = buildRequestBody(model, body, runId, Boolean(ticket?.ticket));
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "perchai-cli/2.4.118",
      "x-perch-locale": "en",
      Authorization: `Bearer ${session.accessToken}`,
      ...(stream ? { Accept: "text/event-stream" } : {}),
      ...(ticket?.ticket ? { "x-perch-turn-ticket": ticket.ticket } : {}),
    };
    const url = `${appUrl}/api/perch-terminal/model-call`;
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    }, proxyOptions);

    const normalized = response.ok
      ? stream ? wrapStream(response, model) : await wrapNonStream(response, model)
      : response;
    return {
      response: normalized,
      url,
      headers: { ...headers, Authorization: "Bearer [REDACTED]" },
      transformedBody: payload,
    };
  }
}
