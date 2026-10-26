import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import {
  createOpencodeRelayBridge,
  formatOpencodeCliPrompt,
  withNativeOpencodeConfig,
  withRelayProviderConfig,
} from "./opencodeCliRunner";

const RELAY_PROVIDER_ID = "9router-opencode-relay";
const OPENCODE_SESSION_PROVIDER_ID = "opencode";
const SERVER_START_TIMEOUT_MS = 15_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TERMINATION_GRACE_MS = 1_000;
const BASE_TIMEOUT_MS = 120_000;
const PER_MIB_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const MEBIBYTE = 1024 * 1024;

type MessagePart = {
  type?: string;
  text?: string;
  image_url?: string | { url?: string };
  source?: { type?: string; media_type?: string; data?: string; url?: string };
  [key: string]: unknown;
};
type IncomingMessage = {
  role?: string;
  name?: string;
  content?: string | MessagePart[] | null;
  [key: string]: unknown;
};

type StoredSession = {
  sessionID: string;
  lastUsed: number;
};

type SessionStore = Record<string, StoredSession>;

type NativeInputPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; url: string };

const locks = new Map<string, Promise<void>>();

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function abortError(): Error {
  const error = new Error("OpenCode session request was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw abortError();
}

async function withLock<T>(key: string, signal: AbortSignal | null | undefined, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  try {
    if (signal?.aborted) throw abortError();
    if (signal) {
      await Promise.race([
        previous,
        new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(abortError());
          signal.addEventListener("abort", onAbort, { once: true });
          previous.finally(() => signal.removeEventListener("abort", onAbort));
        }),
      ]);
    } else {
      await previous;
    }
    throwIfAborted(signal);
    return await action();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function textContent(content: IncomingMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => typeof part === "string" ? part : String(part?.text || ""))
    .filter(Boolean)
    .join("\n");
}

function inputParts(content: IncomingMessage["content"]): NativeInputPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: NativeInputPart[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item) parts.push({ type: "text", text: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const type = String(item.type || "");
    if (type === "text" || type === "input_text" || type === "output_text") {
      if (item.text) parts.push({ type: "text", text: String(item.text) });
      continue;
    }
    if (type === "image_url") {
      const url = typeof item.image_url === "string" ? item.image_url : item.image_url?.url;
      if (url) parts.push({ type: "file", mime: "image/*", url });
      continue;
    }
    if (type === "input_image") {
      const image = item.image_url;
      const url = typeof image === "string" ? image : image?.url;
      if (url) parts.push({ type: "file", mime: "image/*", url });
      continue;
    }
    if (type === "image" && item.source) {
      const source = item.source;
      const url = source.type === "base64" && source.media_type && source.data
        ? `data:${source.media_type};base64,${source.data}`
        : source.url;
      if (url) parts.push({ type: "file", mime: source.media_type || "image/*", url });
    }
  }
  return parts;
}

function requestMessages(body: Record<string, unknown>): IncomingMessage[] {
  if (Array.isArray(body.messages)) return body.messages as IncomingMessage[];
  if (!Array.isArray(body.input)) return [];
  return body.input
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const value = item as Record<string, unknown>;
      if (value.type === "message") {
        return {
          ...value,
          role: typeof value.role === "string" ? value.role : undefined,
          content: value.content as IncomingMessage["content"],
        };
      }
      return value as IncomingMessage;
    });
}

function getSystemText(body: Record<string, unknown>, messages: IncomingMessage[]): string[] {
  const result: string[] = [];
  const system = body.system;
  if (typeof system === "string" && system.trim()) result.push(system.trim());
  if (Array.isArray(system)) {
    const text = system.map((part) => typeof part === "string" ? part : String(part?.text || ""))
      .filter(Boolean)
      .join("\n");
    if (text.trim()) result.push(text.trim());
  }
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = textContent(message.content).trim();
      if (text) result.push(text);
    }
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    result.push(
      `[Client tool definitions]\n${JSON.stringify(body.tools)}\n` +
      "These tools belong to the calling client and are not available in this OpenCode session. Do not claim to have called them.",
    );
  }
  return result;
}

function messagesForHistory(messages: IncomingMessage[], currentIndex: number): IncomingMessage[] {
  return messages.slice(0, currentIndex)
    .filter((message) => message.role !== "system" && message.role !== "developer");
}

function findCurrentTurn(messages: IncomingMessage[]): { message: IncomingMessage; index: number } | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const role = String(messages[index]?.role || "").toLowerCase();
    if (role === "user" || role === "tool") return { message: messages[index], index };
  }
  return null;
}

function buildCurrentParts(message: IncomingMessage): NativeInputPart[] {
  const parts = inputParts(message.content);
  if (message.role === "tool") {
    const text = textContent(message.content);
    return text
      ? [{ type: "text", text: `Tool result (${message.name || "tool"}):\n${text}\nContinue by responding to the user.` }]
      : [];
  }
  return parts;
}

function buildPromptInput(parts: NativeInputPart[], system: string[]): { text: string; files: Array<{ uri: string }> } {
  const text = parts
    .filter((part): part is Extract<NativeInputPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n\n");
  const files = parts
    .filter((part): part is Extract<NativeInputPart, { type: "file" }> => part.type === "file")
    .map((part) => ({ uri: part.url }));
  const instructions = system.length
    ? `[System instructions]\n${system.join("\n\n")}`
    : "";
  return {
    text: [instructions, text || (files.length ? "Please inspect the attached file(s)." : "")]
      .filter(Boolean)
      .join("\n\n"),
    files,
  };
}

function getSessionTitle(sessionKey: string): string {
  return `9router-${sessionKey}`;
}

function getDataRoot(env: NodeJS.ProcessEnv, routeKey: string): string {
  const base = env.DATA_DIR
    ? path.join(env.DATA_DIR, "opencode-native")
    : path.join(env.HOME || tmpdir(), ".9router", "opencode-native");
  return path.join(base, routeKey);
}

async function readSessionStore(file: string): Promise<SessionStore> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OpenCode native session store must be a JSON object");
    }
    return parsed as SessionStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeSessionStore(file: string, store: SessionStore): Promise<void> {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(store), { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function getFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    throw new Error("Unable to reserve a local port for OpenCode server");
  }
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForServer(
  baseURL: string,
  authorization: string,
  signal: AbortSignal,
  childState: { exit?: string; error?: Error },
): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (childState.error) throw childState.error;
    if (childState.exit) throw new Error(`OpenCode server exited before ready: ${childState.exit}`);
    try {
      const response = await fetch(`${baseURL}/api/info`, {
        headers: { authorization },
        signal: AbortSignal.any([signal, AbortSignal.timeout(750)]),
        cache: "no-store",
      });
      if (response.status === 401) throw new Error("OpenCode server rejected its local API credentials");
      if (response.ok && response.headers.get("content-type")?.includes("application/json")) return;
      if (response.ok) throw new Error("OpenCode server returned a non-JSON API readiness response");
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (childState.error) throw childState.error;
      if (childState.exit) throw new Error(`OpenCode server exited before ready: ${childState.exit}`);
      if (!(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "TypeError"))) {
        throw error;
      }
    }
    await delay(100, signal);
  }
  throw new Error(`OpenCode server did not become ready within ${SERVER_START_TIMEOUT_MS}ms`);
}

async function apiJson(
  baseURL: string,
  method: string,
  endpoint: string,
  body: Record<string, unknown> | undefined,
  signal: AbortSignal,
  authorization: string,
): Promise<unknown> {
  const response = await fetch(`${baseURL}${endpoint}`, {
    method,
    headers: {
      authorization,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
    cache: "no-store",
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (response.ok) throw new Error(`OpenCode server returned invalid JSON for ${method} ${endpoint}`);
    }
  }
  if (!response.ok) {
    const errorBody = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const detail = typeof errorBody.message === "string"
      ? errorBody.message
      : typeof errorBody.error === "string"
        ? errorBody.error
        : typeof errorBody._tag === "string"
          ? errorBody._tag
          : "";
    throw new Error(`OpenCode server ${method} ${endpoint} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return parsed;
}

async function ensureSession(
  baseURL: string,
  sessionStorePath: string,
  sessionKey: string,
  title: string,
  model: { providerID: string; id: string },
  signal: AbortSignal,
  authorization: string,
): Promise<{ sessionID: string; created: boolean }> {
  return withLock(`store:${sessionStorePath}`, signal, async () => {
    const store = await readSessionStore(sessionStorePath);
    let cleanupCount = 0;
    for (const [key, session] of Object.entries(store)) {
      if (key === sessionKey || Date.now() - session.lastUsed < SESSION_TTL_MS || cleanupCount >= 3) continue;
      try {
        await apiJson(baseURL, "DELETE", `/api/session/${encodeURIComponent(session.sessionID)}`, undefined, signal, authorization);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("HTTP 404"))) throw error;
      }
      delete store[key];
      cleanupCount++;
    }
    const existing = store[sessionKey];
    if (existing && Date.now() - existing.lastUsed < SESSION_TTL_MS) {
      try {
        await apiJson(baseURL, "GET", `/api/session/${encodeURIComponent(existing.sessionID)}`, undefined, signal, authorization);
        existing.lastUsed = Date.now();
        await writeSessionStore(sessionStorePath, store);
        return { sessionID: existing.sessionID, created: false };
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("HTTP 404"))) throw error;
        delete store[sessionKey];
      }
    } else if (existing) {
      try {
        await apiJson(baseURL, "DELETE", `/api/session/${encodeURIComponent(existing.sessionID)}`, undefined, signal, authorization);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("HTTP 404"))) throw error;
      }
      delete store[sessionKey];
    }
    const created = await apiJson(baseURL, "POST", "/api/session", { title, model }, signal, authorization);
    const createdData = created && typeof created === "object"
      ? (created as Record<string, unknown>).data
      : null;
    const sessionID = createdData && typeof createdData === "object"
      ? (createdData as Record<string, unknown>).id
      : null;
    if (typeof sessionID !== "string" || !sessionID) {
      throw new Error("OpenCode server created a session without returning its ID");
    }
    store[sessionKey] = { sessionID, lastUsed: Date.now() };
    await writeSessionStore(sessionStorePath, store);
    return { sessionID, created: true };
  });
}

function extractCompletedResponse(value: unknown, acceptedAt: number): string | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) throw new Error("OpenCode server returned an invalid session message list");
  const assistant = data
    .filter((item) => item && typeof item === "object")
    .map((item) => item as Record<string, unknown>)
    .filter((item) => {
      if (item.type !== "assistant") return false;
      const time = item.time && typeof item.time === "object" ? item.time as Record<string, unknown> : {};
      return typeof time.created === "number" && time.created >= acceptedAt;
    })
    .sort((a, b) => {
      const timeA = (a.time as Record<string, unknown>).created as number;
      const timeB = (b.time as Record<string, unknown>).created as number;
      return timeB - timeA;
    })[0];
  if (!assistant) return null;
  if (assistant.error) {
    const error = assistant.error as Record<string, unknown>;
    const errorData = error.data && typeof error.data === "object" ? error.data as Record<string, unknown> : {};
    const detail = typeof error.message === "string"
      ? error.message
      : typeof errorData.message === "string"
        ? errorData.message
        : typeof error.name === "string"
          ? error.name
          : "";
    throw new Error(`OpenCode session failed${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const time = assistant.time && typeof assistant.time === "object" ? assistant.time as Record<string, unknown> : {};
  if (typeof time.completed !== "number") return null;
  if (assistant.finish === "error") throw new Error("OpenCode session failed without a detailed error");
  const content = Array.isArray(assistant.content) ? assistant.content : [];
  return content
    .filter((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text")
    .map((part) => String((part as Record<string, unknown>).text || ""))
    .join("");
}

function buildGatewayResponse(responseText: string, rawModel: string) {
  const responseId = `chatcmpl-oc-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunks = [
    {
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model: rawModel,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    },
    {
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model: rawModel,
      choices: [{ index: 0, delta: { content: responseText }, finish_reason: null }],
    },
    {
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model: rawModel,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function executeOpencodeNativeSession({
  opencodeBin,
  targetModel,
  rawModel,
  body,
  providerSessionId,
  connectionId,
  clientTool,
  proxyOptions,
  signal,
  log,
  reqTag,
  providerTag = "OPENCODE",
}: {
  opencodeBin: string;
  targetModel: string;
  rawModel: string;
  body: Record<string, unknown>;
  providerSessionId?: string;
  connectionId?: string;
  clientTool?: string;
  proxyOptions?: Record<string, unknown> | null;
  signal?: AbortSignal | null;
  log?: { info?: (provider: string, message: string) => void; warn?: (provider: string, message: string) => void };
  reqTag?: string;
  providerTag?: string;
}) {
  throwIfAborted(signal);
  const messages = requestMessages(body);
  const current = findCurrentTurn(messages);
  if (!current) throw new Error("OpenCode native sessions require a current user or tool-result message");
  const parts = buildCurrentParts(current.message);
  if (!parts.length) throw new Error("OpenCode native session message has no supported text or image content");

  const system = getSystemText(body, messages);
  const history = messagesForHistory(messages, current.index);
  const initialHistory = history.length
    ? formatOpencodeCliPrompt({ messages: history })
    : "";
  const modelRef = {
    providerID: proxyOptions?.relayUrl || proxyOptions?.vercelRelayUrl ? RELAY_PROVIDER_ID : OPENCODE_SESSION_PROVIDER_ID,
    id: rawModel,
  };
  const estimatedSystem = [
    ...system,
    ...(initialHistory ? [`[Prior conversation before this native OpenCode session]\n${initialHistory}`] : []),
  ];
  const estimatedRequestBody = {
    model: modelRef,
    ...buildPromptInput(parts, estimatedSystem),
    resume: true,
  };
  const requestBytes = Buffer.byteLength(JSON.stringify(estimatedRequestBody), "utf8");
  const routeUrl = proxyOptions?.relayUrl || proxyOptions?.vercelRelayUrl;
  const connectionProxyUrl = proxyOptions?.connectionProxyEnabled ? proxyOptions.connectionProxyUrl : "";
  if (proxyOptions?.strictProxy && proxyOptions.proxyPoolId && !routeUrl && !connectionProxyUrl) {
    throw new Error("OpenCode native session strict proxy pool has no usable proxy; refusing a direct connection");
  }
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    BASE_TIMEOUT_MS + Math.ceil(requestBytes / MEBIBYTE) * PER_MIB_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timedOut = false;
  const timeoutListener = () => { timedOut = true; };
  controller.signal.addEventListener("abort", timeoutListener, { once: true });

  const env = { ...process.env };
  if (!env.HOME || env.HOME === "/") env.HOME = "/app/data-home";
  const routeKey = hash([
    String(connectionId || ""),
    String(proxyOptions?.proxyPoolId || ""),
    String(routeUrl || ""),
    String(connectionProxyUrl || ""),
  ].join("\0"));
  const sessionKey = hash(`${providerSessionId || ""}\0${clientTool || ""}`);
  const dataRoot = getDataRoot(env, routeKey);
  const workspace = path.join(dataRoot, "workspace");
  const sessionStorePath = path.join(dataRoot, "sessions.json");
  const lockKey = `${dataRoot}:${sessionKey}`;
  const lockKeyHash = hash(lockKey);

  return withLock(lockKey, combinedSignal, async () => {
    throwIfAborted(signal);
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const configDir = await mkdtemp(path.join(tmpdir(), "9router-opencode-native-"));
    const serverPassword = crypto.randomBytes(32).toString("hex");
    const authorization = `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}`;
    let relayBridge: Awaited<ReturnType<typeof createOpencodeRelayBridge>> | null = null;
    let child: ReturnType<typeof spawn> | null = null;
    let childClosed = false;
    let childExit: string | undefined;
    let childError: Error | undefined;
    try {
      if (routeUrl) {
        relayBridge = await createOpencodeRelayBridge(String(routeUrl), fetch, { log, reqTag, providerTag });
      }
      const rawConfig = env.OPENCODE_CONFIG_CONTENT
        || (env.OPENCODE_CONFIG ? await readFile(env.OPENCODE_CONFIG, "utf8") : undefined);
      const configContent = relayBridge
        ? withRelayProviderConfig(
            rawConfig,
            `${relayBridge.baseURL}/inference/openai/v1`,
            rawModel,
          )
        : withNativeOpencodeConfig(rawConfig);
      const configPath = path.join(configDir, "opencode.json");
      await writeFile(configPath, configContent, { mode: 0o600 });
      const port = await getFreePort();
      const baseURL = `http://127.0.0.1:${port}`;
      const serverEnv = { ...env };
      serverEnv.OPENCODE_CONFIG = configPath;
      serverEnv.OPENCODE_CONFIG_CONTENT = configContent;
      serverEnv.OPENCODE_CONFIG_PROJECT_DISABLE = "true";
      serverEnv.OPENCODE_SERVER_USERNAME = "opencode";
      serverEnv.OPENCODE_SERVER_PASSWORD = serverPassword;
      if (relayBridge) {
        for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
          delete serverEnv[name];
        }
        const noProxy = (env.NO_PROXY || env.no_proxy || "")
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean);
        serverEnv.NO_PROXY = [...new Set([...noProxy, "localhost", "127.0.0.1"])].join(",");
        serverEnv.no_proxy = serverEnv.NO_PROXY;
      } else if (connectionProxyUrl) {
        serverEnv.HTTP_PROXY = String(connectionProxyUrl);
        serverEnv.HTTPS_PROXY = String(connectionProxyUrl);
        serverEnv.ALL_PROXY = String(connectionProxyUrl);
        serverEnv.http_proxy = String(connectionProxyUrl);
        serverEnv.https_proxy = String(connectionProxyUrl);
        serverEnv.all_proxy = String(connectionProxyUrl);
      }
      log?.info?.(providerTag, `[${reqTag || "-"}] native server start model=${rawModel} promptBytes=${requestBytes} timeout=${timeoutMs}ms route=${routeUrl ? "relay" : connectionProxyUrl ? "HTTP proxy" : "direct"}`);
      child = spawn(opencodeBin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: workspace,
        env: serverEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        windowsHide: true,
      });
      let serverLog = "";
      child.stdout?.on("data", (chunk) => { if (serverLog.length < 8192) serverLog += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk) => { if (serverLog.length < 8192) serverLog += chunk.toString("utf8"); });
      child.once("error", (error) => { childError = error; });
      child.once("close", (code, processSignal) => {
        childClosed = true;
        childExit = `code=${code} signal=${processSignal || "none"}`;
      });

      await waitForServer(baseURL, authorization, combinedSignal, { get exit() { return childExit; }, get error() { return childError; } });
      const session = await ensureSession(
        baseURL,
        sessionStorePath,
        sessionKey,
        getSessionTitle(sessionKey),
        modelRef,
        combinedSignal,
        authorization,
      );
      const systemForTurn = [...system];
      if (session.created && initialHistory) {
        systemForTurn.push(`[Prior conversation before this native OpenCode session]\n${initialHistory}`);
        log?.info?.(providerTag, `[${reqTag || "-"}] native session created with prior-turn bootstrap context`);
      }
      const promptInput = buildPromptInput(parts, systemForTurn);
      const sessionPath = `/api/session/${encodeURIComponent(session.sessionID)}`;
      await apiJson(
        baseURL,
        "POST",
        `${sessionPath}/model`,
        { model: modelRef },
        combinedSignal,
        authorization,
      );
      const promptStartedAt = Date.now();
      const accepted = await apiJson(
        baseURL,
        "POST",
        `${sessionPath}/prompt`,
        { ...promptInput, resume: true },
        combinedSignal,
        authorization,
      );
      const acceptedData = accepted && typeof accepted === "object"
        ? (accepted as Record<string, unknown>).data
        : null;
      const acceptedTime = acceptedData && typeof acceptedData === "object"
        ? (acceptedData as Record<string, unknown>).time
        : null;
      const acceptedAt = acceptedTime && typeof acceptedTime === "object"
        && typeof (acceptedTime as Record<string, unknown>).created === "number"
        ? (acceptedTime as Record<string, number>).created
        : promptStartedAt;
      let responseText = "";
      const pollDeadline = Date.now() + timeoutMs;
      while (Date.now() < pollDeadline) {
        const messages = await apiJson(
          baseURL,
          "GET",
          `${sessionPath}/message?limit=50&order=desc`,
          undefined,
          combinedSignal,
          authorization,
        );
        const completedText = extractCompletedResponse(messages, acceptedAt);
        if (completedText !== null) {
          responseText = completedText;
          break;
        }
        await delay(250, combinedSignal);
      }
      if (!responseText) throw new Error("OpenCode native session returned no completed text output");
      if (!responseText.trim()) throw new Error("OpenCode native session returned no text output");
      if (relayBridge && relayBridge.requestCount === 0) {
        throw new Error("OpenCode native session completed without using the configured relay");
      }

      const store = await readSessionStore(sessionStorePath);
      if (store[sessionKey]) {
        store[sessionKey].lastUsed = Date.now();
        await writeSessionStore(sessionStorePath, store);
      }
      log?.info?.(providerTag, `[${reqTag || "-"}] native session completed session=${lockKeyHash.slice(0, 12)} outputChars=${responseText.length}`);
      return {
        response: buildGatewayResponse(responseText, rawModel),
        url: `opencode://session/${session.sessionID}`,
        headers: {},
        transformedBody: { model: targetModel, sessionID: session.sessionID },
      };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timedOut || controller.signal.aborted) {
        throw new Error(`OpenCode native session timed out after ${timeoutMs}ms`);
      }
      log?.warn?.(providerTag, `[${reqTag || "-"}] native session failed${childError ? ` serverError=${childError.message}` : ""}`);
      throw error;
    } finally {
      if (child && !childClosed) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => child?.once("close", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS)),
        ]);
        if (!childClosed) {
          child.kill("SIGKILL");
          await Promise.race([
            new Promise<void>((resolve) => child?.once("close", () => resolve())),
            new Promise<void>((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS)),
          ]);
        }
      }
      try {
        await rm(configDir, { recursive: true, force: true });
      } finally {
        await relayBridge?.close();
      }
    }
  }).finally(() => {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", timeoutListener);
  });
}
