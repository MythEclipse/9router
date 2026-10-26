import fs from "fs";
import path from "path";
import { spawn, execFileSync, execSync } from "child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const OPENCODE_RELAY_TARGET = "https://opencode.ai";
const OPENCODE_RELAY_PROVIDER_ID = "9router-opencode-relay";
const OPENCODE_SESSION_PROVIDER_ID = "opencode";
const CLI_TIMEOUT_BASE_MS = 120_000;
const CLI_TIMEOUT_PER_MIB_MS = 60_000;
const CLI_MAX_TIMEOUT_MS = 15 * 60_000;
const MEBIBYTE = 1024 * 1024;
const CLI_TERMINATION_GRACE_MS = 1_000;
const SERVER_START_TIMEOUT_MS = 15_000;
const NATIVE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const standaloneSupportByBinary = new Map();
const nativeSessionLocks = new Map();
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function supportsStandaloneFlag(executable, isWin) {
  if (standaloneSupportByBinary.has(executable)) {
    return standaloneSupportByBinary.get(executable);
  }

  const help = execFileSync(executable, ["run", "--help"], {
    encoding: "utf8",
    timeout: 2000,
    windowsHide: true,
    shell: isWin,
  });
  const supported = /(?:^|\s)--standalone(?:\s|$)/m.test(help);
  standaloneSupportByBinary.set(executable, supported);
  return supported;
}

function shouldStripRelayHeader(name) {
  const lower = name.toLowerCase();
  return HOP_BY_HOP_HEADERS.has(lower)
    || lower === "host"
    || lower === "x-real-ip"
    || lower === "x-relay-target"
    || lower === "x-relay-path"
    || lower.startsWith("x-forwarded-")
    || lower.startsWith("x-vercel-");
}

export type OpencodeTraceLogger = {
  info?: (provider: string, message: string) => void;
  warn?: (provider: string, message: string) => void;
  error?: (provider: string, message: string) => void;
  debug?: (provider: string, message: string) => void;
};

export type OpencodeTrace = {
  reqTag?: string;
  log?: OpencodeTraceLogger | null;
  providerTag?: string;
};

export async function createOpencodeRelayBridge(relayUrl: string, fetchImpl: typeof fetch = fetch, trace: OpencodeTrace = {}) {
  let relay;
  try {
    relay = new URL(relayUrl);
  } catch {
    throw new Error("OpenCode relay URL is invalid");
  }
  if (relay.protocol !== "https:" || relay.username || relay.password) {
    throw new Error("OpenCode relay URL must be HTTPS and must not include credentials");
  }
  const relayLocation = `${relay.host}${relay.pathname}`;
  const tracePrefix = `[${trace.reqTag || "-"}]`;
  const traceLog = (level, message) => {
    trace.log?.[level]?.(trace.providerTag || "OPENCODE", `${tracePrefix} relay ${message}`);
  };
  let requestCount = 0;

  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const controller = new AbortController();
    request.on("aborted", () => controller.abort());
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (!requestUrl.pathname.startsWith("/")) {
        response.writeHead(400).end("Invalid relay request path");
        return;
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (!value || shouldStripRelayHeader(name)) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.set("x-relay-target", OPENCODE_RELAY_TARGET);
      headers.set("x-relay-path", `${requestUrl.pathname}${requestUrl.search}`);
      requestCount += 1;
      traceLog("info", `request start ${request.method} ${requestUrl.pathname} via ${relayLocation}`);

      const options: RequestInit & { duplex?: "half" } = {
        method: request.method,
        headers,
        signal: controller.signal,
        redirect: "manual",
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        options.body = Readable.toWeb(request);
        options.duplex = "half";
      }

      const relayResponse = await fetchImpl(relay.href, options);
      if (relayResponse.status >= 300 && relayResponse.status < 400) {
        traceLog("warn", `redirect rejected status=${relayResponse.status} method=${request.method} path=${requestUrl.pathname} elapsed=${Date.now() - startedAt}ms`);
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "OpenCode relay redirected; refusing any direct upstream fallback" }));
        return;
      }
      response.statusCode = relayResponse.status;
      response.statusMessage = relayResponse.statusText;
      traceLog(relayResponse.status >= 400 ? "warn" : "info", `response status=${relayResponse.status} method=${request.method} path=${requestUrl.pathname} content-type=${relayResponse.headers.get("content-type") || "unknown"} elapsed=${Date.now() - startedAt}ms`);
      for (const [name, value] of relayResponse.headers) {
        if (!shouldStripRelayHeader(name)) response.setHeader(name, value);
      }

      if (!relayResponse.body) {
        response.end();
        return;
      }
      // `relayResponse.body` is a WHATWG ReadableStream; node:stream/promises
      // wants Node streams on both ends, so go through Readable.fromWeb.
      await pipeline(Readable.fromWeb(relayResponse.body as import("node:stream/web").ReadableStream<Uint8Array>), response);
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) {
        traceLog("warn", `request aborted method=${request.method} path=${new URL(request.url || "/", "http://127.0.0.1").pathname} elapsed=${Date.now() - startedAt}ms`);
        return;
      }
      traceLog("warn", `request failed method=${request.method} elapsed=${Date.now() - startedAt}ms error=${error.message}`);
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `OpenCode relay request failed: ${error.message}` }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(undefined);
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OpenCode relay bridge failed to bind a TCP port");
  }
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    get requestCount() {
      return requestCount;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve(undefined));
      server.closeAllConnections?.();
    }),
  };
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };

/**
 * Narrow a JSON value to an object map. The opencode config is user-supplied
 * (`OPENCODE_CONFIG_CONTENT`), so a key that should hold an object may hold an
 * array, a string or null; fall back to `{}` instead of spreading a non-object.
 */
function asRecord(value: JsonValue | undefined): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const DENIED_OPENCODE_TOOLS = [
  "apply_patch",
  "bash",
  "edit",
  "external_directory",
  "glob",
  "grep",
  "lsp",
  "question",
  "read",
  "skill",
  "task",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
];

function withDeniedToolPermissions(config: JsonRecord): JsonRecord {
  const permission = asRecord(config.permission);
  return {
    ...config,
    permission: {
      ...permission,
      "*": "deny",
      ...Object.fromEntries(DENIED_OPENCODE_TOOLS.map((tool) => [tool, "deny"])),
    },
  };
}

export function withNativeOpencodeConfig(rawConfig?: string): string {
  let config: JsonRecord = {};
  if (rawConfig) {
    try {
      config = JSON.parse(rawConfig) as JsonRecord;
    } catch (error) {
      throw new Error(`Invalid OPENCODE_CONFIG_CONTENT JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object");
  }
  return JSON.stringify(withDeniedToolPermissions(config));
}

export function withRelayProviderConfig(rawConfig: string | undefined, baseURL: string, modelId: string) {
  let config: JsonRecord = {};
  if (rawConfig) {
    try {
      config = JSON.parse(rawConfig) as JsonRecord;
    } catch (error) {
      throw new Error(`Invalid OPENCODE_CONFIG_CONTENT JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object");
  }

  const providers = asRecord(config.provider);
  const relayProvider = asRecord(providers[OPENCODE_RELAY_PROVIDER_ID]);
  const opencodeProvider = asRecord(providers.opencode);
  const opencodeOptions = asRecord(opencodeProvider.options);
  const relayOptions = asRecord(relayProvider.options);
  const providerOptions = { ...opencodeOptions, ...relayOptions };
  const providerHeaders: JsonRecord = {
    ...asRecord(opencodeOptions.headers),
    ...asRecord(relayOptions.headers),
  };
  const models: JsonRecord = {
    ...asRecord(opencodeProvider.models),
    ...asRecord(relayProvider.models),
  };
  const model = asRecord(models[modelId]);

  return JSON.stringify(withDeniedToolPermissions({
    ...config,
    model: `${OPENCODE_RELAY_PROVIDER_ID}/${modelId}`,
    provider: {
      ...providers,
      [OPENCODE_RELAY_PROVIDER_ID]: {
        ...relayProvider,
        name: relayProvider.name || "OpenCode Relay",
        npm: "@ai-sdk/openai-compatible",
        options: {
          ...providerOptions,
          baseURL,
          headers: { ...providerHeaders, "x-opencode-client": "cli" },
        },
        models: {
          ...models,
          [modelId]: { ...model, name: model.name || modelId },
        },
      },
    },
  }));
}

export function findOpencodeBinary() {
  const isWin = process.platform === "win32";

  const candidates = isWin
    ? [
        process.env.OPENCODE_BIN,
        path.join(process.cwd(), "node_modules", ".bin", "opencode.cmd"),
        path.join(process.cwd(), "node_modules", ".bin", "opencode.exe"),
        path.join(process.cwd(), "node_modules", ".bin", "opencode.bat"),
        path.join(process.cwd(), "node_modules", ".bin", "opencode"),
      ]
    : [
        process.env.OPENCODE_BIN,
        "/usr/local/bin/opencode",
        "/usr/bin/opencode",
        "/root/bin/opencode",
        "/tmp/oc-cli/package/bin/opencode",
        path.join(process.cwd(), "node_modules", ".bin", "opencode"),
        path.join(process.cwd(), "node_modules", ".bin", "opencode.cmd"),
      ];

  for (const bin of candidates) {
    if (!bin) continue;
    try {
      if (fs.existsSync(/* turbopackIgnore: true */ bin)) {
        if (isWin && !/\.(cmd|exe|bat)$/i.test(bin)) {
          if (fs.existsSync(/* turbopackIgnore: true */ `${bin}.cmd`)) return `${bin}.cmd`;
          if (fs.existsSync(/* turbopackIgnore: true */ `${bin}.exe`)) return `${bin}.exe`;
          if (fs.existsSync(/* turbopackIgnore: true */ `${bin}.bat`)) return `${bin}.bat`;
        }
        return bin;
      }
    } catch {
      /* ignore */
    }
  }

  // Probe system PATH
  try {
    const cmd = isWin ? "where opencode 2>nul" : "which opencode 2>/dev/null";
    const lines = execSync(cmd, { encoding: "utf8", timeout: 2000 })
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    for (const p of lines) {
      if (isWin) {
        if (/\.(cmd|exe|bat)$/i.test(p) && fs.existsSync(/* turbopackIgnore: true */ p)) return p;
        if (fs.existsSync(/* turbopackIgnore: true */ `${p}.cmd`)) return `${p}.cmd`;
        if (fs.existsSync(/* turbopackIgnore: true */ `${p}.exe`)) return `${p}.exe`;
      } else if (fs.existsSync(/* turbopackIgnore: true */ p)) {
        return p;
      }
    }
    if (lines[0] && fs.existsSync(/* turbopackIgnore: true */ lines[0])) return lines[0];
  } catch {
    /* ignore */
  }

  return null;
}

/** A system-prompt part: either plain text or an Anthropic-style text block. */
type OpencodeSystemPart = string | { text?: string; [key: string]: unknown };

/** One content part of a chat message: text, image, tool result, … */
type OpencodeContentPart = string | { text?: string; [key: string]: unknown };

/** A chat message as forwarded from an OpenAI/Anthropic client. */
type OpencodeChatMessage = {
  role?: string;
  content?: string | OpencodeContentPart[] | null;
  name?: string;
  tool_calls?: unknown[];
  [key: string]: unknown;
};

/** The incoming chat-completions request body this function renders to text. */
export type OpencodePromptBody = {
  system?: string | OpencodeSystemPart[] | null;
  messages?: OpencodeChatMessage[] | null;
  tools?: unknown[] | null;
  [key: string]: unknown;
};

export function formatOpencodeCliPrompt(body: OpencodePromptBody | null | undefined): string {
  if (!body) return "";

  const systemParts: string[] = [];

  // 1. Direct system field (Anthropic or custom)
  if (typeof body.system === "string" && body.system.trim()) {
    systemParts.push(body.system.trim());
  } else if (Array.isArray(body.system)) {
    const s = body.system
      .map((p) => (typeof p === "string" ? p : p?.text || ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (s) systemParts.push(s);
  }

  // 2. System, developer, and conversation messages from body.messages
  const dialogMsgs: { role: string; name: string; text: string }[] = [];
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg) continue;
      const role = String(msg.role || "").toLowerCase();
      const content = msg.content;
      const text = typeof content === "string"
        ? content.trim()
        : Array.isArray(content)
          ? content
              .map((c) => (typeof c === "string" ? c : c?.text || ""))
              .filter(Boolean)
              .join("\n")
              .trim()
          : "";

      if (role === "system" || role === "developer") {
        if (text) systemParts.push(text);
      } else if (role === "user" || role === "assistant" || role === "tool") {
        const toolCalls = role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length
          ? `\nTool calls: ${JSON.stringify(msg.tool_calls)}`
          : "";
        const toolName = role === "tool" && typeof msg.name === "string" ? msg.name : "tool";
        const messageText = `${text}${toolCalls}`.trim();
        if (messageText) dialogMsgs.push({ role, name: toolName, text: messageText });
      }
    }
  }

  const clientTools = Array.isArray(body.tools) && body.tools.length
    ? `[Client Tool Definitions]\n${JSON.stringify(body.tools)}\nThese tools are provided by the calling client and are not directly available to this CLI. Do not claim to have invoked them.`
    : "";
  if (clientTools) systemParts.push(clientTools);

  // If there are no dialog messages, return system text directly
  if (dialogMsgs.length === 0) {
    return systemParts.join("\n\n").trim();
  }

  // If there are no system parts and only 1 user message, return it directly
  if (systemParts.length === 0 && dialogMsgs.length === 1 && dialogMsgs[0].role === "user") {
    return dialogMsgs[0].text;
  }

  const promptSections: string[] = [];

  // Add system instructions section
  if (systemParts.length > 0) {
    promptSections.push(`[System Instructions]\n${systemParts.join("\n\n")}`);
  }

  // If multi-turn conversation, format earlier history
  if (dialogMsgs.length > 1) {
    const earlierTurns = dialogMsgs.slice(0, -1);
    const historyText = earlierTurns
      .map((m) => {
        if (m.role === "assistant") return `Assistant: ${m.text}`;
        if (m.role === "tool") return `Tool result (${m.name}): ${m.text}`;
        return `User: ${m.text}`;
      })
      .join("\n\n");
    promptSections.push(`[Conversation History]\n${historyText}`);

    const lastMsg = dialogMsgs[dialogMsgs.length - 1];
    const lastLabel = lastMsg.role === "assistant"
      ? "Assistant"
      : lastMsg.role === "tool"
        ? `Tool result (${lastMsg.name})`
        : "User";
    promptSections.push(`${lastLabel}: ${lastMsg.text}`);
  } else {
    const message = dialogMsgs[0];
    const label = message.role === "assistant"
      ? "Assistant"
      : message.role === "tool"
        ? `Tool result (${message.name})`
        : "User";
    promptSections.push(`${label}: ${message.text}`);
  }

  return promptSections.join("\n\n").trim();
}

export async function executeOpencodeCli({
  opencodeBin,
  targetModel,
  promptText,
  proxyOptions,
  signal,
  log,
  reqTag,
  rawModel,
  providerTag = "OPENCODE",
}) {
  if (signal?.aborted) {
    const error = new Error("OpenCode CLI request was aborted");
    error.name = "AbortError";
    throw error;
  }

  const env = { ...process.env };
  const promptBytes = Buffer.byteLength(promptText, "utf8");
  const cliTimeoutMs = Math.min(
    CLI_MAX_TIMEOUT_MS,
    CLI_TIMEOUT_BASE_MS
      + Math.ceil(promptBytes / MEBIBYTE) * CLI_TIMEOUT_PER_MIB_MS,
  );
  if (!env.HOME || env.HOME === "/") {
    env.HOME = "/app/data-home";
  }

  const isWin = process.platform === "win32";
  let executable = opencodeBin;
  if (isWin && !/\.(cmd|exe|bat)$/i.test(executable)) {
    if (fs.existsSync(/* turbopackIgnore: true */ `${executable}.cmd`)) {
      executable = `${executable}.cmd`;
    } else if (fs.existsSync(/* turbopackIgnore: true */ `${executable}.exe`)) {
      executable = `${executable}.exe`;
    } else if (fs.existsSync(/* turbopackIgnore: true */ `${executable}.bat`)) {
      executable = `${executable}.bat`;
    }
  }

  // A CLI request runs once; retries can duplicate work and cost.
  let finalResult = null;
  const relayUrl = proxyOptions?.relayUrl || proxyOptions?.vercelRelayUrl;
  const hasHttpProxy = proxyOptions?.connectionProxyEnabled === true
    && Boolean(proxyOptions.connectionProxyUrl);
  if (proxyOptions?.strictProxy && proxyOptions?.proxyPoolId && !relayUrl && !hasHttpProxy) {
    log?.warn?.(providerTag, `[${reqTag || "-"}] strict proxy pool=${proxyOptions.proxyPoolId} has no usable relay or HTTP proxy; refusing direct connection`);
    throw new Error("OpenCode CLI strict proxy pool has no usable proxy; refusing a direct connection");
  }
  const relayLocation = relayUrl
    ? (() => {
        const relay = new URL(relayUrl);
        return `${relay.host}${relay.pathname}`;
      })()
    : "";
  const route = relayUrl
    ? `relay type=${proxyOptions?.source || proxyOptions?.proxyType || "unknown"} url=${relayLocation}`
    : hasHttpProxy
      ? `HTTP proxy configured (${proxyOptions.source || "pool"})`
      : "direct (no proxy configured)";
  log?.info?.(providerTag, `[${reqTag || "-"}] CLI start model=${rawModel || targetModel} route=${route} promptBytes=${promptBytes} timeout=${cliTimeoutMs}ms`);
  const relayBridge = relayUrl
    ? await createOpencodeRelayBridge(relayUrl, fetch, { log, reqTag, providerTag })
    : null;
  let relayConfigDir = null;

  try {
    const useStandalone = Boolean(relayBridge || hasHttpProxy)
      ? supportsStandaloneFlag(executable, isWin)
      : false;
    let relayConfigContent = null;
    let relayConfigPath = "";
    if (relayBridge) {
      relayConfigContent = withRelayProviderConfig(
        env.OPENCODE_CONFIG_CONTENT,
        `${relayBridge.baseURL}/inference/openai/v1`,
        rawModel
      );
      relayConfigDir = await mkdtemp(path.join(tmpdir(), "9router-opencode-relay-"));
      relayConfigPath = path.join(relayConfigDir, "opencode.json");
      await writeFile(relayConfigPath, relayConfigContent, { mode: 0o600 });
    }

    const cliStartedAt = Date.now();
    const currentProxyUrl = proxyOptions?.connectionProxyEnabled
      ? proxyOptions.connectionProxyUrl
      : "";
    const runEnv = { ...env };
    const cliTargetModel = relayBridge
      ? `${OPENCODE_RELAY_PROVIDER_ID}/${rawModel}`
      : targetModel;
    if (relayBridge) {
      runEnv.OPENCODE_CONFIG = relayConfigPath;
      runEnv.OPENCODE_CONFIG_CONTENT = relayConfigContent;
      runEnv.OPENCODE_CONFIG_PROJECT_DISABLE = "true";
      for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
        delete runEnv[name];
      }
      const noProxy = (env.NO_PROXY || env.no_proxy || "")
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean);
      runEnv.NO_PROXY = [...new Set([...noProxy, "localhost", "127.0.0.1"])].join(",");
      runEnv.no_proxy = runEnv.NO_PROXY;
    } else if (currentProxyUrl) {
      runEnv.HTTP_PROXY = currentProxyUrl;
      runEnv.HTTPS_PROXY = currentProxyUrl;
      runEnv.ALL_PROXY = currentProxyUrl;
      runEnv.http_proxy = currentProxyUrl;
      runEnv.https_proxy = currentProxyUrl;
      runEnv.all_proxy = currentProxyUrl;
    }

    try {
        log?.info?.(providerTag, `[${reqTag || "-"}] CLI started`);
        finalResult = await new Promise((resolve, reject) => {
          let childProcess;
          try {
            const cliArgs = ["run"];
            if (useStandalone) cliArgs.push("--standalone");
            cliArgs.push("--model", cliTargetModel, "--format", "default");
            childProcess = spawn(
              /* turbopackIgnore: true */ executable,
              cliArgs,
              {
                cwd: process.cwd(),
                env: runEnv,
                stdio: ["pipe", "pipe", "pipe"],
                shell: isWin,
                windowsHide: true,
              }
            );
          } catch (spawnErr) {
            return reject(spawnErr);
          }

          let stdoutText = "";
          let stderrText = "";
          let timedOut = false;
          let closed = false;
          let settled = false;
          let terminationError = null;
          let timeoutTimer;
          let forceKillTimer;
          const clearProcessTimers = () => {
            clearTimeout(timeoutTimer);
            clearTimeout(forceKillTimer);
          };
          const removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
          const rejectOnce = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutTimer);
            removeAbortListener();
            reject(error);
          };
          const resolveOnce = (result) => {
            if (settled) return;
            settled = true;
            clearProcessTimers();
            removeAbortListener();
            resolve(result);
          };
          const terminate = (error) => {
            if (closed || terminationError) return;
            terminationError = error;
            childProcess.kill("SIGTERM");
            forceKillTimer = setTimeout(() => {
              if (closed) return;
              childProcess.kill("SIGKILL");
              rejectOnce(terminationError);
            }, CLI_TERMINATION_GRACE_MS);
            forceKillTimer.unref?.();
          };
          const onAbort = () => {
            const error = new Error("OpenCode CLI request was aborted");
            error.name = "AbortError";
            terminate(error);
          };

          childProcess.stdout.on("data", (chunk) => {
            stdoutText += chunk.toString("utf-8");
          });

          childProcess.stderr.on("data", (chunk) => {
            stderrText += chunk.toString("utf-8");
          });

          childProcess.stdin.on("error", (err) => {
            terminate(err);
          });

          childProcess.on("error", (err) => {
            clearProcessTimers();
            rejectOnce(err);
          });

          childProcess.on("close", (code) => {
            closed = true;
            clearProcessTimers();
            removeAbortListener();
            if (terminationError) {
              return rejectOnce(terminationError);
            }
            if (timedOut) {
              return rejectOnce(new Error(`OpenCode CLI timed out after ${cliTimeoutMs}ms`));
            }
            if (code === 0 && stdoutText.trim()) {
              return resolveOnce({ success: true, text: stdoutText.trim() });
            }

            const combined = `${stderrText} ${stdoutText}`.trim();
            if (/tunnel:\s*(400|407|502|503|504)|tunnel\s*failed|ECONNRESET|ETIMEDOUT/i.test(combined)) {
              return rejectOnce(new Error(`Proxy tunnel error (code ${code}): ${combined.slice(0, 150)}`));
            }

            if (code !== 0 && !stdoutText.trim()) {
              return rejectOnce(new Error(`CLI exited with code ${code}: ${combined.slice(0, 150)}`));
            }

            resolveOnce({ success: true, text: stdoutText.trim() });
          });

          timeoutTimer = setTimeout(() => {
            timedOut = true;
            terminate(new Error(`OpenCode CLI timed out after ${cliTimeoutMs}ms`));
          }, cliTimeoutMs);
          timeoutTimer.unref?.();
          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          }
          if (!terminationError) childProcess.stdin.end(promptText);
        });

        if (relayBridge && relayBridge.requestCount === 0) {
          throw new Error("OpenCode CLI completed without using the configured relay; refusing a direct upstream result");
        }

      if (finalResult?.success && finalResult.text) {
        log?.info?.(providerTag, `[${reqTag || "-"}] CLI completed code=0 outputChars=${finalResult.text.length} elapsed=${Date.now() - cliStartedAt}ms`);
      } else {
        log?.warn?.(providerTag, `[${reqTag || "-"}] CLI returned no output elapsed=${Date.now() - cliStartedAt}ms`);
      }
    } catch (err) {
      log?.warn?.(providerTag, `[${reqTag || "-"}] CLI failed elapsed=${Date.now() - cliStartedAt}ms error=${err.message}`);
      throw err;
    }
  } finally {
    try {
      if (relayConfigDir) await rm(relayConfigDir, { recursive: true, force: true });
    } finally {
      await relayBridge?.close();
    }
    log?.info?.(providerTag, `[${reqTag || "-"}] CLI process finished${finalResult?.success && (!relayBridge || relayBridge.requestCount > 0) ? " successfully" : " without success"}`);
  }

  const responseText = finalResult?.text ?? "";
  if (!finalResult?.success || !responseText.trim()) {
    throw new Error(`OpenCode CLI produced no output text (code: ${finalResult?.code ?? 'unknown'})`);
  }
  const responseId = `chatcmpl-oc-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const sseStream = new ReadableStream({
    start(controller) {
      const emit = (str) => {
        try {
          controller.enqueue(new TextEncoder().encode(str));
        } catch {
          /* fail open if stream closed */
        }
      };

      // Leading role chunk
      emit(
        `data: ${JSON.stringify({
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model: rawModel,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        })}\n\n`
      );

      // Content chunk
      if (responseText) {
        emit(
          `data: ${JSON.stringify({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: rawModel,
            choices: [{ index: 0, delta: { content: responseText }, finish_reason: null }],
          })}\n\n`
        );
      }

      // Stop chunk
      emit(
        `data: ${JSON.stringify({
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model: rawModel,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );

      emit("data: [DONE]\n\n");
      controller.close();
    },
  });

  return {
    response: new Response(sseStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }),
    url: "opencode://cli/run",
    headers: {},
    transformedBody: { model: targetModel, prompt: promptText.slice(0, 100) },
  };
}
