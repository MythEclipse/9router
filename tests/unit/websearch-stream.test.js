/**
 * Web search streaming — call observation and block injection.
 *
 * The injected frames must be parseable by a Claude-protocol client, so these
 * tests assert on the decoded SSE, not on the byte string.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createWebSearchStreamState,
  observeWebSearchFrame,
  normalizeToolUseId,
  pendingSearchCalls,
  buildStreamWebSearchInjection,
  injectWebSearchIntoStream,
} from "../../open-sse/handlers/webSearchStream.js";
import {
  SERVER_TOOL_USE_BLOCK,
  WEB_SEARCH_RESULT_BLOCK,
  SERVER_TOOL_USE_ID_RE,
} from "../../open-sse/config/webSearchConstants.js";

/** Build an SSE stream from raw frame text. */
function sseStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** Decode an injected SSE blob into its `data:` payloads. */
function parseSse(text) {
  return text
    .split("\n\n")
    .filter((f) => f.includes("data:"))
    .map((f) => JSON.parse(f.split("\n").find((l) => l.startsWith("data:")).slice(5).trim()));
}

const textDelta = (text) => `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`;
const toolUseFrame = (id, query) =>
  `event: content_block_start\ndata: ${JSON.stringify({
    type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "web_search", input: { query } },
  })}\n\n`;

describe("normalizeToolUseId", () => {
  it("leaves a valid Anthropic id untouched", () => {
    expect(normalizeToolUseId("srvtoolu_abc")).toBe("srvtoolu_abc");
  });

  it("rewrites a model's toolu_ id into the required shape", () => {
    expect(normalizeToolUseId("toolu_01ABC")).toMatch(SERVER_TOOL_USE_ID_RE);
  });

  it("strips characters Anthropic rejects", () => {
    expect(normalizeToolUseId("toolu_has-dash")).toMatch(SERVER_TOOL_USE_ID_RE);
    expect(normalizeToolUseId("weird id!")).toMatch(SERVER_TOOL_USE_ID_RE);
  });

  it("survives an empty id", () => {
    expect(normalizeToolUseId(undefined)).toMatch(SERVER_TOOL_USE_ID_RE);
    expect(normalizeToolUseId("")).toMatch(SERVER_TOOL_USE_ID_RE);
  });
});

describe("frame observation", () => {
  it("records the model's web_search call and its query", () => {
    const state = createWebSearchStreamState();
    observeWebSearchFrame(state, toolUseFrame("toolu_1", "how to test"));

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].query).toBe("how to test");
    expect(pendingSearchCalls(state)).toHaveLength(1);
  });

  it("marks calls the upstream already answered so they are not re-run", () => {
    const state = createWebSearchStreamState();
    observeWebSearchFrame(state, toolUseFrame("srvtoolu_up", "q"));
    observeWebSearchFrame(state, `data: ${JSON.stringify({
      type: "content_block_start",
      content_block: { type: WEB_SEARCH_RESULT_BLOCK, tool_use_id: "srvtoolu_up", content: [] },
    })}\n\n`);

    // A result block alone proves the upstream ran the search: the call must
    // not be re-run, even though no server_tool_use block was seen.
    expect(pendingSearchCalls(state)).toHaveLength(0);
    expect(state.sawUpstreamSearch).toBe(true);
  });

  it("ignores unrelated tool calls", () => {
    const state = createWebSearchStreamState();
    observeWebSearchFrame(state, `data: ${JSON.stringify({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "toolu_x", name: "Read", input: {} },
    })}\n\n`);

    expect(state.calls).toHaveLength(0);
  });

  it("survives a malformed frame without throwing", () => {
    const state = createWebSearchStreamState();
    expect(() => observeWebSearchFrame(state, "data: {not json\n\n")).not.toThrow();
    expect(() => observeWebSearchFrame(state, "")).not.toThrow();
  });

  it("merges the streamed input delta so the query is not lost", () => {
    // Anthropic sends tool arguments in a follow-up content_block_delta frame,
    // so the start frame's input is empty. Without merging, the call looks
    // query-less and would be wrongly errored.
    const state = createWebSearchStreamState();
    observeWebSearchFrame(state, `data: ${JSON.stringify({
      type: "content_block_start", index: 2,
      content_block: { type: "tool_use", id: "toolu_1", name: "web_search", input: {} },
    })}\n\n`);
    expect(state.calls[0].query).toBe("");

    observeWebSearchFrame(state, `data: ${JSON.stringify({
      type: "content_block_delta", index: 2,
      delta: { type: "input_json_delta", partial_json: '{"query":"streaming query"}' },
    })}\n\n`);

    expect(state.calls[0].query).toBe("streaming query");
  });

  it("tolerates a partial_json delta that does not parse yet", () => {
    const state = createWebSearchStreamState();
    observeWebSearchFrame(state, `data: ${JSON.stringify({
      type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "web_search", input: {} },
    })}\n\n`);
    observeWebSearchFrame(state, `data: ${JSON.stringify({
      type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: '{"query":"half' },
    })}\n\n`);

    expect(() => observeWebSearchFrame(state, `data: ${JSON.stringify({
      type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: '-way"}' },
    })}\n\n`)).not.toThrow();
    expect(state.calls).toHaveLength(1);
  });

  it("does not record an upstream server_tool_use as a bridge call to re-run", () => {
    const state = createWebSearchStreamState();
    observeWebSearchFrame(state, `data: ${JSON.stringify({
      type: "content_block_start",
      content_block: { type: SERVER_TOOL_USE_BLOCK, id: "srvtoolu_z", name: "web_search", input: { query: "q" } },
    })}\n\n`);

    expect(state.sawUpstreamSearch).toBe(true);
  });
});

describe("buildStreamWebSearchInjection", () => {
  const plan = { active: true, lane: "bridge", maxUses: 3 };

  it("appends the block pair for each pending call", async () => {
    const state = createWebSearchStreamState();
    observeWebSearchFrame(state, toolUseFrame("toolu_1", "q1"));

    const runSearch = vi.fn().mockResolvedValue([
      { title: "T", url: "https://e.test/1", snippet: "s", published_at: null },
    ]);
    const sse = await buildStreamWebSearchInjection({ webSearchPlan: plan, state, runSearch });

    const payloads = parseSse(sse);
    const serverUse = payloads.find((p) => p.content_block?.type === SERVER_TOOL_USE_BLOCK);
    const result = payloads.find((p) => p.content_block?.type === WEB_SEARCH_RESULT_BLOCK);

    expect(serverUse).toBeTruthy();
    expect(result).toBeTruthy();
    expect(result.content_block.tool_use_id).toBe(serverUse.content_block.id);
    expect(serverUse.content_block.id).toMatch(SERVER_TOOL_USE_ID_RE);
  });

  it("emits nothing when there is no search call", async () => {
    const state = createWebSearchStreamState();
    const runSearch = vi.fn();
    const sse = await buildStreamWebSearchInjection({ webSearchPlan: plan, state, runSearch });

    expect(sse).toBe("");
    expect(runSearch).not.toHaveBeenCalled();
  });

  it("emits nothing when the upstream already streamed the blocks", async () => {
    const state = createWebSearchStreamState();
    observeWebSearchFrame(state, toolUseFrame("toolu_1", "q"));
    state.sawUpstreamSearch = true;

    const runSearch = vi.fn();
    const sse = await buildStreamWebSearchInjection({ webSearchPlan: plan, state, runSearch });

    expect(sse).toBe("");
    expect(runSearch).not.toHaveBeenCalled();
  });

  it("respects max_uses", async () => {
    const state = createWebSearchStreamState();
    observeWebSearchFrame(state, toolUseFrame("toolu_1", "q1"));
    observeWebSearchFrame(state, toolUseFrame("toolu_2", "q2"));
    observeWebSearchFrame(state, toolUseFrame("toolu_3", "q3"));

    const runSearch = vi.fn().mockResolvedValue([]);
    await buildStreamWebSearchInjection({
      webSearchPlan: { ...plan, maxUses: 1 }, state, runSearch,
    });

    expect(runSearch).toHaveBeenCalledTimes(1);
  });

  it("emits an error block rather than dropping a failed search", async () => {
    const state = createWebSearchStreamState();
    observeWebSearchFrame(state, toolUseFrame("toolu_1", "q"));

    const runSearch = vi.fn().mockRejectedValue(new Error("engine down"));
    const sse = await buildStreamWebSearchInjection({ webSearchPlan: plan, state, runSearch });

    const payloads = parseSse(sse);
    const result = payloads.find((p) => p.content_block?.type === WEB_SEARCH_RESULT_BLOCK);
    expect(result.content_block.error_code).toBe("unavailable");
  });

  it("errors a call that carried no query instead of searching for nothing", async () => {
    const state = createWebSearchStreamState();
    observeWebSearchFrame(state, `data: ${JSON.stringify({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "toolu_1", name: "web_search", input: {} },
    })}\n\n`);

    const runSearch = vi.fn();
    const sse = await buildStreamWebSearchInjection({ webSearchPlan: plan, state, runSearch });

    expect(runSearch).not.toHaveBeenCalled();
    const payloads = parseSse(sse);
    expect(payloads.some((p) => p.content_block?.type === WEB_SEARCH_RESULT_BLOCK)).toBe(true);
  });
});

describe("injectWebSearchIntoStream", () => {
  const plan = { active: true, lane: "bridge", maxUses: 3 };

  const readAll = async (stream) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  };

  it("forwards upstream bytes and appends the search blocks", async () => {
    const runSearch = vi.fn().mockResolvedValue([{ title: "T", url: "https://e.test/1" }]);
    const wrapped = injectWebSearchIntoStream({
      stream: sseStream([textDelta("hello "), toolUseFrame("toolu_1", "q")]),
      webSearchPlan: plan, runSearch,
    });

    const out = await readAll(wrapped);
    // Original upstream text is untouched.
    expect(out).toContain("hello ");
    const payloads = parseSse(out);
    expect(payloads.some((p) => p.content_block?.type === SERVER_TOOL_USE_BLOCK)).toBe(true);
    expect(payloads.some((p) => p.content_block?.type === WEB_SEARCH_RESULT_BLOCK)).toBe(true);
  });

  it("closes the stream so the client is not left waiting", async () => {
    const runSearch = vi.fn().mockResolvedValue([]);
    const wrapped = injectWebSearchIntoStream({
      stream: sseStream([toolUseFrame("toolu_1", "q")]), webSearchPlan: plan, runSearch,
    });
    await expect(readAll(wrapped)).resolves.toBeTypeOf("string");
  });

  it("passes the stream through untouched on the passthrough lane", () => {
    const original = sseStream([textDelta("x")]);
    const out = injectWebSearchIntoStream({
      stream: original, webSearchPlan: { ...plan, lane: "passthrough" }, runSearch: vi.fn(),
    });
    expect(out).toBe(original);
  });

  it("passes the stream through untouched when inactive", () => {
    const original = sseStream([textDelta("x")]);
    const out = injectWebSearchIntoStream({
      stream: original, webSearchPlan: { active: false, lane: "none" }, runSearch: vi.fn(),
    });
    expect(out).toBe(original);
  });

  it("injects nothing when the model never called search", async () => {
    const runSearch = vi.fn();
    const wrapped = injectWebSearchIntoStream({
      stream: sseStream([textDelta("no tools here")]), webSearchPlan: plan, runSearch,
    });
    const out = await readAll(wrapped);
    expect(runSearch).not.toHaveBeenCalled();
    expect(out).toBe("data: " + JSON.stringify({
      type: "content_block_delta", delta: { type: "text_delta", text: "no tools here" },
    }) + "\n\n");
  });
});

describe("real Claude Code tool-call sequence", () => {
  const plan = { active: true, lane: "bridge", maxUses: 5, defaultMaxResults: 5, allowedDomains: [], blockedDomains: [] };

  /** The exact frame order Anthropic emits for a web_search tool call. */
  const claudeFrames = (id, partials) => [
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start", index: 1,
      content_block: { type: "tool_use", id, name: "web_search", input: {} },
    })}\n\n`,
    ...partials.map((p) => `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta", index: 1,
      delta: { type: "input_json_delta", partial_json: p },
    })}\n\n`),
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
  ];

  const readAll = async (stream) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  };

  it("captures the query from a split-argument tool call", async () => {
    // Anthropic streams tool arguments in fragments; the query only exists
    // after the last fragment is merged.
    const runSearch = vi.fn().mockResolvedValue([{ title: "T", url: "https://a.test" }]);
    const wrapped = injectWebSearchIntoStream({
      stream: sseStream(claudeFrames("toolu_01Realistic", ['{"que', 'ry":"latest AI ', 'news"}'])),
      webSearchPlan: plan,
      runSearch,
    });

    const out = await readAll(wrapped);
    expect(runSearch).toHaveBeenCalledOnce();
    expect(runSearch.mock.calls[0][0].query).toBe("latest AI news");
    expect(parseSse(out).some((p) => p.content_block?.type === SERVER_TOOL_USE_BLOCK)).toBe(true);
  });

  it("carries search_type through when the client asks for news", async () => {
    const runSearch = vi.fn().mockResolvedValue([]);
    const wrapped = injectWebSearchIntoStream({
      stream: sseStream(claudeFrames("toolu_02News", ['{"query":"ai","search_type":"news"}'])),
      webSearchPlan: plan,
      runSearch,
    });

    await readAll(wrapped);
    expect(runSearch.mock.calls[0][0].searchType).toBe("news");
  });

  it("emits a usable id, not the model's raw toolu_ id", async () => {
    const runSearch = vi.fn().mockResolvedValue([{ title: "T", url: "https://a.test" }]);
    const wrapped = injectWebSearchIntoStream({
      stream: sseStream(claudeFrames("toolu_01Weird_id", ['{"query":"q"}'])),
      webSearchPlan: plan,
      runSearch,
    });

    const payloads = parseSse(await readAll(wrapped));
    const serverUse = payloads.find((p) => p.content_block?.type === SERVER_TOOL_USE_BLOCK);
    expect(serverUse.content_block.id).toMatch(SERVER_TOOL_USE_ID_RE);
    expect(serverUse.content_block.id).not.toBe("toolu_01Weird_id");
  });

  it("survives a stream that closes with no tool call at all", async () => {
    const runSearch = vi.fn();
    const wrapped = injectWebSearchIntoStream({
      stream: sseStream([textDelta("just prose")]),
      webSearchPlan: plan,
      runSearch,
    });

    await expect(readAll(wrapped)).resolves.toContain("just prose");
    expect(runSearch).not.toHaveBeenCalled();
  });
});


describe("OpenAI-shaped upstream tool_calls (the path Claude Code actually takes)", () => {
  // The bridge wraps the PROVIDER response. For an OpenAI-compatible upstream
  // (antigravity, and every provider Claude Code traffic uses) the frames are
  // chat-completions `tool_calls`, not Anthropic content_block events — those
  // only appear after translation. Recognising only the Anthropic shape made the
  // bridge a no-op for every such provider.
  const runSearch = async () => [{ title: "Docs", url: "https://example.com/docs", content: "body" }];

  const plan = {
    active: true,
    lane: "bridge",
    maxUses: 5,
    defaultMaxResults: 5,
    allowedDomains: [],
    blockedDomains: [],
    isClaudeCodeClientTool: true,
  };

  const chunk = (delta, extra = {}) =>
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta, ...extra }] })}\n\n`;

  async function collect(frames) {
    const out = injectWebSearchIntoStream({ stream: sseStream(frames), webSearchPlan: plan, runSearch });
    const reader = out.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    const starts = [];
    for (const line of buf.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const e = JSON.parse(line.slice(6));
        if (e.type === "content_block_start") starts.push(e.content_block?.type);
      } catch { /* not a frame */ }
    }
    return { starts, raw: buf };
  }

  it("converts a split tool_call into server_tool_use + web_search_tool_result", async () => {
    const { starts } = await collect([
      chunk({ role: "assistant", content: "Checking. " }),
      chunk({ tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "WebSearch", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"query":"anthropic pricing"}' } }] }),
      chunk({}, { finish_reason: "tool_calls" }),
    ]);

    expect(starts).toContain("server_tool_use");
    expect(starts).toContain("web_search_tool_result");
  });

  it("reassembles arguments split across several chunks", async () => {
    const { raw } = await collect([
      chunk({ tool_calls: [{ index: 0, id: "call_split", type: "function", function: { name: "WebSearch", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"que' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ry":"a b' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'c"}' } }] }),
      chunk({}, { finish_reason: "tool_calls" }),
    ]);

    // The query only exists once the fragments are joined; a partial JSON parse
    // must not be treated as the call. The first chunk's `arguments: ""` parses
    // to `{}`, so recording on it yields an empty query and the search is then
    // rejected as query_too_long — the end-to-end symptom of this bug.
    expect(raw).toContain("server_tool_use");
    expect(raw).toContain("web_search_tool_result");
    expect(raw).not.toContain("query_too_long");
  });

  it("does not record the call from the empty-arguments opening chunk", async () => {
    const state = createWebSearchStreamState();
    observeWebSearchFrame(state, chunk({ tool_calls: [{ index: 0, id: "call_empty", type: "function", function: { name: "WebSearch", arguments: "" } }] }));

    // An empty argument string parses to {}; treating that as a finished call
    // records a query-less search.
    expect(state.calls).toHaveLength(0);
  });

  it("passes the fully reassembled query to the runner", async () => {
    const runSearch = vi.fn().mockResolvedValue([{ title: "T", url: "https://e.test/1" }]);
    const out = injectWebSearchIntoStream({
      stream: sseStream([
        chunk({ tool_calls: [{ index: 0, id: "call_full", type: "function", function: { name: "WebSearch", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"query":"anthropic web search ' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'pricing"}' } }] }),
        chunk({}, { finish_reason: "tool_calls" }),
      ]),
      webSearchPlan: plan, runSearch,
    });

    const reader = out.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(runSearch).toHaveBeenCalled();
    expect(runSearch.mock.calls[0][0].query).toBe("anthropic web search pricing");
  });

  it("normalises the tool_use id to Anthropic's srvtoolu_ shape", async () => {
    const { raw } = await collect([
      chunk({ tool_calls: [{ index: 0, id: "call_rawid", type: "function", function: { name: "WebSearch", arguments: '{"query":"q"}' } }] }),
      chunk({}, { finish_reason: "tool_calls" }),
    ]);

    expect(raw).toContain("srvtoolu_");
    // The upstream frame may legitimately pass through untouched; what matters is
    // that the block we INJECT carries the normalised id Claude Code requires.
    const injected = [...raw.matchAll(/"type":"server_tool_use","id":"([^"]+)"/g)].map((m) => m[1]);
    expect(injected.length).toBeGreaterThan(0);
    expect(injected.every((id) => id.startsWith("srvtoolu_"))).toBe(true);
  });

  it("leaves a non-search tool call alone", async () => {
    const { starts } = await collect([
      chunk({ tool_calls: [{ index: 0, id: "call_other", type: "function", function: { name: "Read", arguments: '{"path":"/x"}' } }] }),
      chunk({}, { finish_reason: "tool_calls" }),
    ]);

    expect(starts).not.toContain("server_tool_use");
    expect(starts).not.toContain("web_search_tool_result");
  });

  it("still handles Anthropic-shaped frames unchanged", async () => {
    // Claude Code's own client tool shape: a `tool_use` named WebSearch, with
    // the query inline. Added alongside the OpenAI cases to prove recognising
    // `tool_calls` did not regress the Anthropic path.
    const { starts } = await collect([
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start", index: 0,
        content_block: { type: "tool_use", id: "toolu_a", name: "WebSearch", input: { query: "anthropic" } },
      })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    ]);

    expect(starts).toContain("server_tool_use");
    expect(starts).toContain("web_search_tool_result");
  });
});


describe("suppressing the model's own search tool_use on the bridge lane", () => {
  // The bridge answers a search call with Anthropic's NATIVE server-tool pair.
  // The model's original `tool_use` must not reach the client: Claude Code
  // executes a client tool_use itself, locally, and reported "Did 0 searches"
  // while ignoring the native pair already emitted for the same call. Captured
  // from a live Claude Code 2.1.296 session through 9router.
  const plan = {
    active: true, lane: "bridge", maxUses: 5,
    defaultMaxResults: 5, allowedDomains: [], blockedDomains: [],
  };
  const runSearch = async () => [{ title: "T", url: "https://e.test/1" }];

  const f = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;

  async function collect(frames) {
    const stream = new ReadableStream({
      start(c) {
        for (const fr of frames) c.enqueue(new TextEncoder().encode(fr));
        c.close();
      },
    });
    const reader = injectWebSearchIntoStream({ stream, webSearchPlan: plan, runSearch }).getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    return buf;
  }

  const startsOf = (buf) => buf.split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => { try { return JSON.parse(l.slice(6)).content_block; } catch { return null; } })
    .filter(Boolean);

  it("drops the search tool_use and keeps only the native pair", async () => {
    const buf = await collect([
      f({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      f({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      f({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking." } }),
      f({ type: "content_block_stop", index: 0 }),
      f({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "WebSearch", input: {} } }),
      f({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"release notes"}' } }),
      f({ type: "content_block_stop", index: 1 }),
      f({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    ]);

    const types = startsOf(buf).map((b) => b.type);
    expect(types).not.toContain("tool_use");
    expect(types).toContain("server_tool_use");
    expect(types).toContain("web_search_tool_result");
    expect(buf).toContain("Looking.");
  });

  it("drops the whole block triple, not just the start frame", async () => {
    // Leaving the delta/stop behind produces orphaned frames and a mismatched
    // stop for a block that never opened.
    const buf = await collect([
      f({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      f({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "WebSearch", input: { query: "q" } } }),
      f({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"q"}' } }),
      f({ type: "content_block_stop", index: 1 }),
    ]);

    // The triple must be gone entirely: no start, no delta, no stop for the
    // suppressed block. Indices are remapped, so assert on the frames instead.
    expect(buf).not.toContain('"name":"WebSearch"');
    const stops = buf.split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => { try { return JSON.parse(l.slice(6)).type; } catch { return null; } });
    // Exactly the blocks we inject plus the opening message_start.
    expect(stops.filter((t) => t === "content_block_start")).toHaveLength(3);
  });

  it("keeps a non-search tool_use intact", async () => {
    // A turn calling WebSearch alongside Read must still deliver the Read call.
    const buf = await collect([
      f({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      f({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_r", name: "Read", input: { file_path: "/x" } } }),
      f({ type: "content_block_stop", index: 1 }),
      f({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_w", name: "WebSearch", input: { query: "q" } } }),
      f({ type: "content_block_stop", index: 2 }),
    ]);

    expect(buf).toContain('"name":"Read"');
    expect(buf).not.toContain('"name":"WebSearch","input"');
  });

  it("does not stall when a chunk contains only the suppressed block", async () => {
    // Regression: returning without enqueueing leaves the ReadableStream with
    // no work and pull() is never called again, so the response hangs until the
    // client times out. This is the exact shape a one-block chunk has.
    const buf = await collect([
      f({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      f({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "WebSearch", input: { query: "q" } } }),
    ]);

    expect(buf).toContain("server_tool_use");
  });

  it("renumbers blocks so a suppressed one leaves no hole", async () => {
    // Upstream used index 1 for the search call, which is suppressed. The client
    // must still see 0,1,2,... with no gap.
    const buf = await collect([
      f({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      f({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      f({ type: "content_block_stop", index: 0 }),
      f({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "WebSearch", input: { query: "q" } } }),
      f({ type: "content_block_stop", index: 1 }),
      f({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }),
      f({ type: "content_block_stop", index: 2 }),
    ]);

    const idxs = buf.split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => { try { const e = JSON.parse(l.slice(6)); return e.type === "content_block_start" ? e.index : null; } catch { return null; } })
      .filter((v) => v !== null);

    expect(idxs).toEqual(idxs.map((_, i) => i));
  });

  it("numbers injected blocks after the highest index already on the wire", async () => {
    // Anthropic numbers content blocks strictly increasing. Hardcoding index 0
    // collided with the blocks already emitted and Claude Code rejected the
    // turn with "The model's tool call could not be parsed".
    const buf = await collect([
      f({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      f({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      f({ type: "content_block_stop", index: 0 }),
      f({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      f({ type: "content_block_stop", index: 1 }),
      f({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_a", name: "WebSearch", input: { query: "q" } } }),
      f({ type: "content_block_stop", index: 2 }),
    ]);

    const idxs = buf.split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => { try { const e = JSON.parse(l.slice(6)); return e.type === "content_block_start" ? e.index : null; } catch { return null; } })
      .filter((v) => v !== null);

    expect(idxs.length).toBeGreaterThan(2);
    expect(idxs.every((v, i) => i === 0 || v > idxs[i - 1])).toBe(true);
    // Contiguous 0..n: suppressing a block must not leave a hole, which is what
    // made Claude Code report an unparseable tool call.
    expect(idxs).toEqual(idxs.map((_, i) => i));
  });

  it("keeps indices increasing across two searches", async () => {
    const buf = await collect([
      f({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      f({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      f({ type: "content_block_stop", index: 0 }),
      f({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "WebSearch", input: { query: "one" } } }),
      f({ type: "content_block_stop", index: 1 }),
      f({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_b", name: "WebSearch", input: { query: "two" } } }),
      f({ type: "content_block_stop", index: 2 }),
    ]);

    const idxs = buf.split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => { try { const e = JSON.parse(l.slice(6)); return e.type === "content_block_start" ? e.index : null; } catch { return null; } })
      .filter((v) => v !== null);

    expect(idxs.every((v, i) => i === 0 || v > idxs[i - 1])).toBe(true);
  });

  it("injects before message_stop, not after it", async () => {
    // Claude Code closes the turn at message_stop and treats anything after it
    // as unparseable — which surfaced as "The model's tool call could not be
    // parsed" even though the blocks themselves were well-formed.
    const buf = await collect([
      f({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      f({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      f({ type: "content_block_stop", index: 0 }),
      f({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "WebSearch", input: { query: "q" } } }),
      f({ type: "content_block_stop", index: 1 }),
      f({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      f({ type: "message_stop" }),
    ]);

    const order = buf.split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => {
        try {
          const e = JSON.parse(l.slice(6));
          if (e.type === "content_block_start") return e.content_block.type;
          if (e.type === "message_stop") return "MESSAGE_STOP";
          return null;
        } catch { return null; }
      })
      .filter(Boolean);

    expect(order).toContain("MESSAGE_STOP");
    const stopAt = order.indexOf("MESSAGE_STOP");
    expect(stopAt).toBeGreaterThan(order.indexOf("web_search_tool_result"));
    expect(order[order.length - 1]).toBe("MESSAGE_STOP");
  });

  it("still emits exactly one message_stop", async () => {
    const buf = await collect([
      f({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      f({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "WebSearch", input: { query: "q" } } }),
      f({ type: "content_block_stop", index: 1 }),
      f({ type: "message_stop" }),
    ]);

    const stops = buf.split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => { try { return JSON.parse(l.slice(6)).type; } catch { return null; } })
      .filter((t) => t === "message_stop");

    expect(stops).toHaveLength(1);
  });

  it("does not defer message_stop when nothing is injected", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`event: message_stop
data: ${JSON.stringify({ type: "message_stop" })}

`));
        c.close();
      },
    });
    const reader = injectWebSearchIntoStream({
      stream, webSearchPlan: plan, runSearch,
    }).getReader();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value, { stream: true });
    }
    expect(buf).toContain("message_stop");
  });

  it("injects before the stop_reason message_delta too", async () => {
    // message_stop was not the only terminal frame: the upstream's final
    // message_delta carries stop_reason, and a Claude client treats that as the
    // end of the turn. Injecting between the two still failed to parse.
    const buf = await collect([
      f({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      f({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      f({ type: "content_block_stop", index: 0 }),
      f({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "WebSearch", input: { query: "q" } } }),
      f({ type: "content_block_stop", index: 1 }),
      f({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      f({ type: "message_stop" }),
    ]);

    const order = buf.split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => {
        try {
          const e = JSON.parse(l.slice(6));
          if (e.type === "content_block_start") return e.content_block.type;
          if (e.type === "message_delta" && e.delta?.stop_reason) return "STOP_REASON";
          if (e.type === "message_stop") return "MESSAGE_STOP";
          return null;
        } catch { return null; }
      })
      .filter(Boolean);

    const resultAt = order.indexOf("web_search_tool_result");
    const stopReasonAt = order.indexOf("STOP_REASON");
    const stopAt = order.indexOf("MESSAGE_STOP");

    expect(resultAt).toBeGreaterThan(-1);
    expect(stopReasonAt).toBeGreaterThan(resultAt);
    expect(stopAt).toBeGreaterThan(stopReasonAt);
  });

  it("replays the terminal frames in Anthropic's order", async () => {
    const buf = await collect([
      f({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      f({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "WebSearch", input: { query: "q" } } }),
      f({ type: "content_block_stop", index: 1 }),
      f({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      f({ type: "message_stop" }),
    ]);

    expect(buf.endsWith("}\n\n")).toBe(true);
    const tail = buf.slice(-400);
    expect(tail).toContain("stop_reason");
    expect(tail.lastIndexOf("message_stop")).toBeGreaterThan(tail.lastIndexOf("stop_reason"));
  });

  it("keeps a non-terminal message_delta in place", async () => {
    // Safeguard verdicts ride on a message_delta with no stop_reason; those must
    // stay exactly where they were.
    const buf = await collect([
      f({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      f({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      f({ type: "content_block_stop", index: 0 }),
      f({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "WebSearch", input: { query: "q" } } }),
      f({ type: "content_block_stop", index: 1 }),
      f({ type: "message_delta", delta: { safeguard_results: [{ type: "dangerous_tool_use" }] } }),
      f({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      f({ type: "message_stop" }),
    ]);

    const guardAt = buf.indexOf("safeguard_results");
    const resultAt = buf.indexOf("web_search_tool_result");
    // The verdict belongs to the turn, before the injected results.
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(resultAt);
  });

  it("never drops anything on the passthrough lane", async () => {
    const frames = [
      f({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      f({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "WebSearch", input: { query: "q" } } }),
    ];
    const stream = new ReadableStream({
      start(c) { for (const fr of frames) c.enqueue(new TextEncoder().encode(fr)); c.close(); },
    });
    const out = injectWebSearchIntoStream({
      stream, webSearchPlan: { ...plan, lane: "passthrough" }, runSearch,
    });
    const reader = out.getReader();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value, { stream: true });
    }
    expect(buf).toContain('"name":"WebSearch"');
  });
});
