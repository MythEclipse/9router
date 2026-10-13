import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import {
  OPENCODE_SESSION_RE,
  OPENCODE_REQUEST_RE,
  generateSessionId,
  generateRequestId,
  translateSessionId,
  stableSessionId,
  deriveRequestId,
} from "../../open-sse/executors/opencode.js";

function makeCredentials(overrides = {}) {
  return {
    connectionId: "conn_test",
    rawHeaders: {},
    ...overrides,
  };
}

function prepare(executor, overrides = {}) {
  const credentials = overrides.credentials || makeCredentials();
  const prepared = executor.prepareRequestCredentials({
    body: overrides.body || { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
    credentials,
    providerSessionId: overrides.providerSessionId ?? "conversation-a",
    clientTool: overrides.clientTool ?? "claude",
  });
  return { credentials, prepared };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

describe("OpenCode Free Session ID Format", () => {
  it("generates session IDs matching OpenCode canonical format (ses_ + 12 hex + 14 base62)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateSessionId();
      expect(id).toMatch(OPENCODE_SESSION_RE);
      expect(id).toHaveLength(30);
    }
  });

  it("generates request IDs matching OpenCode canonical format (msg_ + 12 hex + 14 base62)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateRequestId();
      expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(id).toHaveLength(30);
    }
  });

  it("translates arbitrary sessions into valid OpenCode session format", () => {
    const inputs = [
      "claude:550e8400-e29b-41d4-a716-446655440000",
      "antigravity:conv-abc-123",
      "session-from-codex",
      "12345",
      "",
    ];
    for (const raw of inputs) {
      const translated = translateSessionId(raw, "claude");
      expect(translated).toMatch(OPENCODE_SESSION_RE);
      expect(translated).toHaveLength(30);
    }
  });

  it("preserves already-valid OpenCode sessions without re-hashing", () => {
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    expect(translateSessionId(valid)).toBe(valid);
    expect(translateSessionId(`  ${valid}  `)).toBe(valid);
  });

  it("translates arbitrary sessions with valid inverted timestamp prefix (fixes #4780)", () => {
    const raw = "claude:non-opencode-uuid-12345";
    const translated = translateSessionId(raw, "claude");
    expect(translated).toMatch(OPENCODE_SESSION_RE);
    expect(translated).toHaveLength(30);

    // Upstream Zen verifies the 12-hex prefix decodes to ~(BigInt(Date.now()) * 4096n + counter)
    // The lowest byte of ~(...) always produces 'fe' in hex (ending with 'ffe' in the 12-hex prefix).
    const timeHex = translated.slice(4, 16);
    expect(timeHex.endsWith("fe")).toBe(true);

    // Stability across repeated translations of the same input
    const repeated = translateSessionId(raw, "claude");
    expect(repeated).toBe(translated);
  });

  it("keys the translation on the full composite id, not a bare client hint", () => {
    // The cache key is whatever the resolver hands in. Session resolution
    // combines the client hint with the conversation anchor before calling this,
    // so a shared literal like "default" reaches here already disambiguated.
    const one = translateSessionId("default:aaa", "claude");
    const two = translateSessionId("default:bbb", "claude");
    expect(one).not.toBe(two);
    expect(one).toMatch(OPENCODE_SESSION_RE);
    expect(two).toMatch(OPENCODE_SESSION_RE);
    expect(translateSessionId("default:aaa", "claude")).toBe(one);
  });
});

describe("OpenCode Free payload-driven session scoping (one shared credential)", () => {
  // The free tier authenticates everyone with the same literal credential
  // ("Bearer public") and hands every caller connectionId "noauth", so neither a
  // key nor a connection can separate conversations — only the payload can.
  const NOAUTH = { id: "noauth", connectionId: "noauth", accessToken: "public" };
  // One key handed to a whole team: it must not affect session identity at all.
  const SHARED = { authorization: "Bearer sk-shared-by-everyone" };

  function upstreamSession(body, downstreamHeaders = SHARED) {
    const executor = getExecutor("opencode");
    const credentials = { ...NOAUTH, rawHeaders: { ...downstreamHeaders } };
    const prepared = executor.prepareRequestCredentials({
      body,
      credentials,
      providerSessionId: undefined,
      clientTool: "claude",
    });
    return executor.buildHeaders(prepared, true, executor.buildUrl("big-pickle"))["x-opencode-session"];
  }

  const prompt = (text) => ({ model: "big-pickle", messages: [{ role: "user", content: text }] });
  const thread = (...texts) => ({
    model: "big-pickle",
    messages: texts.flatMap((t, i) => (i === 0 ? [{ role: "user", content: t }] : [
      { role: "assistant", content: `Balasan panjang untuk giliran ${i} agar history terus bertambah.` },
      { role: "user", content: t },
    ])),
  });

  it("keeps two conversations apart with no session id at all", () => {
    expect(upstreamSession(prompt("tolong jelaskan docker")))
      .not.toBe(upstreamSession(prompt("tolong jelaskan kubernetes")));
  });

  it("keeps them apart even when both send the same literal session id", () => {
    const shared = { ...SHARED, "x-opencode-session": "default" };
    expect(upstreamSession(prompt("pertanyaan soal database"), shared))
      .not.toBe(upstreamSession(prompt("pertanyaan soal frontend"), shared));
  });

  it("ignores the caller's credential when separating conversations", () => {
    // Different keys, same conversation -> still one session.
    expect(upstreamSession(prompt("pertanyaan yang sama"), { authorization: "Bearer sk-a" }))
      .toBe(upstreamSession(prompt("pertanyaan yang sama"), { authorization: "Bearer sk-b" }));
  });

  it("holds one session for the whole conversation as history grows", () => {
    const first = upstreamSession(thread("hai"));
    const second = upstreamSession(thread("hai", "lanjut"));
    const third = upstreamSession(thread("hai", "lanjut", "lagi"));
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("holds one session when the client also sends a stable session id", () => {
    const withId = { ...SHARED, "x-opencode-session": "conv-9" };
    const first = upstreamSession(thread("prompt pertama"), withId);
    const second = upstreamSession(thread("prompt pertama", "prompt kedua"), withId);
    const third = upstreamSession(thread("prompt pertama", "prompt kedua", "prompt ketiga"), withId);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("still separates distinct conversations of the same caller", () => {
    expect(upstreamSession(prompt("a"), { ...SHARED, "x-opencode-session": "conv-1" }))
      .not.toBe(upstreamSession(prompt("a"), { ...SHARED, "x-opencode-session": "conv-2" }));
  });

  it("still passes a native OpenCode session through untouched", () => {
    const native = "ses_ecc5937c7ffeZq7Xk2Lm9PwRtX";
    expect(upstreamSession(prompt("a"), { ...SHARED, "x-opencode-session": native })).toBe(native);
  });
});

describe("OpenCode Zen resolves sessions from the payload too", () => {
  // opencode-zen used to resolve through sessionManager's assistant-text
  // heuristic, which re-minted the session mid-thread and could not separate
  // conversations sharing one credential. It now shares the Free executor's
  // payload-driven resolution.
  const NOAUTH = { id: "noauth", connectionId: "noauth", accessToken: "public" };
  const SHARED = { authorization: "Bearer sk-shared-by-everyone" };

  function zenSession(body, rawHeaders = SHARED) {
    const executor = getExecutor("opencode-zen");
    return executor.prepareRequestCredentials({
      body,
      credentials: { ...NOAUTH, rawHeaders: { ...rawHeaders } },
      providerSessionId: undefined,
      clientTool: "claude",
    })._opencodeZenSession;
  }

  const u = (t) => ({ role: "user", content: t });
  const a = (t) => ({ role: "assistant", content: t });
  const prompt = (t) => ({ model: "grok-code", messages: [u(t)] });
  const thread = (...turns) => ({
    model: "grok-code",
    messages: turns.flatMap((t, i) => (i === 0
      ? [u(t)]
      : [a(`Balasan panjang untuk giliran ${i} agar history terus bertambah.`), u(t)])),
  });

  it("keeps one session for the whole conversation as history grows", () => {
    const first = zenSession(thread("hai"));
    const second = zenSession(thread("hai", "lanjut"));
    const third = zenSession(thread("hai", "lanjut", "lagi"));
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("separates conversations that share one credential", () => {
    expect(zenSession(prompt("jelaskan docker")))
      .not.toBe(zenSession(prompt("jelaskan kubernetes")));
    const literal = { ...SHARED, "x-opencode-session": "default" };
    expect(zenSession(prompt("jelaskan docker"), literal))
      .not.toBe(zenSession(prompt("jelaskan kubernetes"), literal));
  });

  it("emits a valid session and passes a native one through", () => {
    expect(zenSession(prompt("a"))).toMatch(OPENCODE_SESSION_RE);
    const native = "ses_ecc5937c7ffeZq7Xk2Lm9PwRtX";
    expect(zenSession(prompt("a"), { ...SHARED, "x-opencode-session": native })).toBe(native);
  });
});

describe("OpenCode Free Executor Session Resolution", () => {
  it("uses request-local session credentials without mutating source credentials", () => {
    const executor = getExecutor("opencode");
    const { credentials, prepared } = prepare(executor);

    expect(executor.constructor.name).toBe("OpenCodeExecutor");
    expect(prepared).not.toBe(credentials);
    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(credentials).not.toHaveProperty("_opencodeSession");
    expect(executor).not.toHaveProperty("_currentSessionId");
  });

  it("preserves valid native x-opencode-session header case-insensitively", () => {
    const executor = getExecutor("opencode");
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "X-OpenCode-Session": ` ${valid} ` } }),
    });

    expect(prepared._opencodeSession).toBe(valid);
  });

  it("translates invalid native x-opencode-session header into a valid session", () => {
    const executor = getExecutor("opencode");
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "x-opencode-session": "invalid-session-uuid" } }),
    });

    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(prepared._opencodeSession).not.toBe("invalid-session-uuid");
  });

  it("translates conversation session deterministically", () => {
    const executor = getExecutor("opencode");
    const first = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;
    const second = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;

    expect(first).toBe(second);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("isolates different conversations and tools", () => {
    const executor = getExecutor("opencode");
    const convA = prepare(executor, { providerSessionId: "conversation-a" }).prepared._opencodeSession;
    const convB = prepare(executor, { providerSessionId: "conversation-b" }).prepared._opencodeSession;
    const toolClaude = prepare(executor, { providerSessionId: "same", clientTool: "claude" }).prepared._opencodeSession;
    const toolCodex = prepare(executor, { providerSessionId: "same", clientTool: "codex" }).prepared._opencodeSession;

    expect(convA).not.toBe(convB);
    expect(toolClaude).not.toBe(toolCodex);
  });

  it("adds the valid session header to fetch requests", async () => {
    const executor = getExecutor("opencode");
    const credentials = makeCredentials();
    const result = await executor.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
      stream: false,
      credentials,
      providerSessionId: "conversation-fetch-test",
      clientTool: "claude",
    });

    expect(result.headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers["x-opencode-session"]).toBe(result.headers["x-opencode-session"]);
    expect(fetchMock.mock.calls[0][1].headers["Authorization"]).toBe("Bearer public");
    expect(credentials).not.toHaveProperty("_opencodeSession");
  });

  it("falls back to a valid generated session in buildHeaders when called standalone", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({});

    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(headers["Authorization"]).toBe("Bearer public");
  });
  it("handles null or undefined body gracefully in transformRequest", () => {
    const executor = getExecutor("opencode");
    expect(() => executor.transformRequest("muse-spark-1.3-contributor-free", null, false, {})).not.toThrow();
    expect(() => executor.transformRequest("big-pickle", undefined, false, {})).not.toThrow();
  });
});

describe("OpenCode Free User-Agent Validation", () => {
  it("defaults User-Agent to opencode/1.18.31 for non-opencode downstream clients", () => {
    const executor = getExecutor("opencode");
    const headersNoUa = executor.buildHeaders({});
    expect(headersNoUa["User-Agent"]).toBe("opencode/1.18.31");

    const headersClaude = executor.buildHeaders({ rawHeaders: { "user-agent": "Claude-Code/1.0" } });
    expect(headersClaude["User-Agent"]).toBe("opencode/1.18.31");
  });

  it("replaces bare opencode with versioned opencode/1.18.31 to prevent 403 FreeTierError", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode" } });
    expect(headers["User-Agent"]).toBe("opencode/1.18.31");
  });

  it("upgrades outdated opencode versions (< 1.17) to prevent 426 Upgrade Required", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.15.0" } });
    expect(headers["User-Agent"]).toBe("opencode/1.18.31");
  });

  it("preserves valid opencode versions (>= 1.17)", () => {
    const executor = getExecutor("opencode");
    const headers118 = executor.buildHeaders({
      rawHeaders: { "user-agent": "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14" },
    });
    expect(headers118["User-Agent"]).toBe("opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14");

    const headersFuture = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.19.0" } });
    expect(headersFuture["User-Agent"]).toBe("opencode/1.19.0");
  });
});

describe("OpenCode Stable Session Reuse (429 follow-up)", () => {
  function anonymousCredentials(auth) {
    return makeCredentials({ connectionId: undefined, rawHeaders: { authorization: `Bearer ${auth}` } });
  }

  it("reuses one stable upstream session instead of minting a new one per request", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const first = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });
    const second = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });

    expect(first._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(second._opencodeSession).toBe(first._opencodeSession);
  });

  it("does not key sessions on the caller's credential", () => {
    // The free tier hands the same literal credential to everyone, so a key is
    // not an identity. Two callers with different keys on the same conversation
    // belong on the same session; two conversations must not share one.
    const executor = getExecutor("opencode");
    const conversation = (text) => ({ messages: [{ role: "user", content: text }] });
    const forBody = (body, auth) => executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials(auth),
      providerSessionId: null,
      clientTool: "claude",
    })._opencodeSession;

    expect(forBody(conversation("hello"), "user-A")).toBe(forBody(conversation("hello"), "user-B"));
    expect(forBody(conversation("hello"), "user-A")).not.toBe(forBody(conversation("goodbye"), "user-A"));
    expect(forBody(conversation("hello"), "user-A")).toMatch(OPENCODE_SESSION_RE);
  });

  it("exposes the stable session helper directly", () => {
    const first = stableSessionId({ connectionId: "direct-conn" });
    expect(stableSessionId({ connectionId: "direct-conn" })).toBe(first);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("derives deterministic, canonical request ids per message", () => {
    const session = stableSessionId({ connectionId: "req-conn" });
    const body = { messages: [{ role: "user", content: "ping" }] };
    const first = deriveRequestId(session, body);
    expect(first).toMatch(OPENCODE_REQUEST_RE);
    expect(deriveRequestId(session, body)).toBe(first);
    expect(
      deriveRequestId(session, { messages: [{ role: "user", content: "a different question" }] }),
    ).not.toBe(first);
  });

  it("preserves a valid downstream x-opencode-request header", () => {
    const executor = getExecutor("opencode");
    const validReq = "msg_0ae8d9cd3001swxaFbM248jcIF";
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "x-opencode-request": validReq } }),
    });
    expect(prepared._opencodeRequest).toBe(validReq);
  });

  it("keeps the standalone buildHeaders session stable across calls", () => {
    const executor = getExecutor("opencode");
    const first = executor.buildHeaders({})["x-opencode-session"];
    const second = executor.buildHeaders({})["x-opencode-session"];
    expect(first).toMatch(OPENCODE_SESSION_RE);
    expect(second).toBe(first);
  });

  it("applies the full lowercase free-tier fingerprint quartet", () => {
  const executor = getExecutor("opencode");

  const chatNoTools = executor.transformRequest("nemotron-3-ultra-free", {
    messages: [{ role: "user", content: "hi" }],
  });
  expect(chatNoTools.stream).toBe(true);
  expect(chatNoTools.tool_choice).toBe("none");
  expect(chatNoTools.tools.map((t) => t.function?.name)).toEqual([
    "bash", "glob", "grep", "read",
  ]);

  const chatWithTools = executor.transformRequest("nemotron-3-ultra-free", {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "Bash", description: "Claude Code tool" } },
      { type: "function", function: { name: "Glob", description: "Claude Code tool" } },
      { type: "function", function: { name: "Grep", description: "Claude Code tool" } },
      { type: "function", function: { name: "Read", description: "Claude Code tool" } },
    ],
    tool_choice: "auto",
  });
  expect(chatWithTools.tool_choice).toBe("auto");
  expect(chatWithTools.tools.map((t) => t.function?.name)).toEqual([
    "bash", "glob", "grep", "read",
  ]);

  const chatPartial = executor.transformRequest("nemotron-3-ultra-free", {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "bash", description: "existing" } },
      { type: "function", function: { name: "read", description: "existing" } },
    ],
  });
  expect(chatPartial.tools.map((t) => t.function?.name)).toEqual([
    "bash", "read", "glob", "grep",
  ]);
  expect(chatPartial.tools[0].function.description).toBe("existing");
});

  it("cloaks Muse Responses requests even when the client already supplies tools", () => {
    const executor = getExecutor("opencode");
    const transformed = executor.transformRequest("muse-spark-1.3-contributor-free(xhigh)", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{
        type: "function",
        name: "zcode_search",
        description: "client-provided tool",
        parameters: { type: "object", properties: {} },
      }],
      tool_choice: "auto",
      reasoning_effort: "xhigh",
    }, true, {});

    expect(transformed.stream).toBe(true);
    expect(transformed.reasoning?.effort).toBe("xhigh");
    const names = transformed.tools.map((tool) => tool.name);
    expect(names).toContain("zcode_search");
    expect(names).toContain("bash");
    expect(names).toContain("read");
    expect(names.filter((name) => name === "bash")).toHaveLength(1);
    expect(names.filter((name) => name === "read")).toHaveLength(1);
  });

  it("declares forceStream on the opencode transport so chatCore serves SSE upstream", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    expect(PROVIDERS.opencode?.forceStream).toBe(true);
  });
});
