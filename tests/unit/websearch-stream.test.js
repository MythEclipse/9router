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
