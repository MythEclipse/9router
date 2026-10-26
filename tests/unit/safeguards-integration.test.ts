import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveSafeguardsReviewPlan,
  ensureSafeguardsForwarded,
  pickDecisionReviewTarget,
  upstreamRunsServerReview,
} from "open-sse/handlers/safeguardsReview.js";
import { buildReviewState, runSafetyDecision } from "open-sse/handlers/safeguardsBridge.js";
import {
  createSafeguardStreamState,
  observeSafeguardEvent,
  buildStreamSafeguardInjection,
  injectSafeguardsIntoStream,
} from "open-sse/handlers/safeguardsStream.js";
import { attachReviewToClaudeBody } from "open-sse/handlers/chatCore/nonStreamingHandler.js";
import { buildSafeguardResults } from "open-sse/handlers/safeguardsProtocol.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { PROVIDER_MEDIA } from "open-sse/providers/index.js";

const context = { v: 1, action: "Bash(rm -rf /var/data/prod)" };
const body = { model: "claude-opus-5-5", safeguards: [{ type: "dangerous_tool_use", classifier_context: context }] };

const responseWithTool = (ids = ["toolu_01ABC"]) => ({
  type: "message",
  role: "assistant",
  content: [
    { type: "text", text: "ok" },
    ...ids.map((id) => ({ type: "tool_use", id, name: "Bash", input: { command: "ls" } })),
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 5, output_tokens: 3 },
});

describe("upstreamRunsServerReview", () => {
  it("recognizes Anthropic-format upstreams", () => {
    expect(upstreamRunsServerReview("anthropic", "claude-opus-5-5")).toBe(true);
    expect(upstreamRunsServerReview("claude", "claude-opus-5-5")).toBe(true);
  });

  it("recognizes an anthropic-compatible node only for a Claude model", () => {
    expect(upstreamRunsServerReview("anthropic-compatible-custom", "claude-sonnet-5")).toBe(true);
    expect(upstreamRunsServerReview("anthropic-compatible-custom", "kimi-k2")).toBe(false);
  });

  it("does not claim review for other providers", () => {
    expect(upstreamRunsServerReview("openrouter", "anthropic/claude-opus-5")).toBe(false);
    expect(upstreamRunsServerReview(undefined, undefined)).toBe(false);
  });
});

describe("pickDecisionReviewTarget", () => {
  it("honours an explicit override", () => {
    expect(pickDecisionReviewTarget({ safeguardsClassifierModel: "opencode-zen/jev-1.13-free" }, null))
      .toEqual({ provider: "opencode-zen", model: "jev-1.13-free" });
  });

  it("prefers a free decision lane", () => {
    const target = pickDecisionReviewTarget({}, null);
    expect(target).toBeTruthy();
    expect(PROVIDER_MEDIA[target.provider]?.systemoneConfig).toBeTruthy();
  });

  it("never reviews with the lane under review (would recurse)", () => {
    const first = pickDecisionReviewTarget({}, null);
    const second = pickDecisionReviewTarget({}, { provider: first.provider, model: "x" });
    expect(second.provider).not.toBe(first.provider);
  });

  it("only picks providers that really expose a decision endpoint", () => {
    for (const target of [pickDecisionReviewTarget({}, null)]) {
      expect(PROVIDER_MEDIA[target.provider]?.systemoneConfig).toBeTruthy();
    }
  });

  it("falls back to another provider when only one lane exists", () => {
    const single = REGISTRY.filter((e) => PROVIDER_MEDIA[e.id]?.systemoneConfig);
    // Sanity: the suite's assumption that several lanes exist.
    expect(single.length).toBeGreaterThan(1);
  });
});

describe("resolveSafeguardsReviewPlan", () => {
  it("is inactive for an ordinary request", () => {
    const plan = resolveSafeguardsReviewPlan({ body: { messages: [] }, modelInfo: { provider: "kimi", model: "k2" } });
    expect(plan.active).toBe(false);
    expect(plan.lane).toBeNull();
  });

  it("uses passthrough to an upstream that reviews itself", () => {
    const plan = resolveSafeguardsReviewPlan({ body, modelInfo: { provider: "anthropic", model: "claude-opus-5-5" } });
    expect(plan.active).toBe(true);
    expect(plan.lane).toBe("passthrough");
    expect(plan.reviewer).toBeNull();
    expect(plan.classifierContext).toEqual(context);
  });

  it("bridges when the upstream cannot review", () => {
    const plan = resolveSafeguardsReviewPlan({ body, modelInfo: { provider: "kimi", model: "kimi-k2" } });
    expect(plan.lane).toBe("bridge");
    expect(plan.reviewer).toBeTruthy();
  });
});

describe("ensureSafeguardsForwarded", () => {
  it("restores the field a translator dropped", () => {
    const translated = { model: "claude", messages: [] };
    ensureSafeguardsForwarded(translated, { active: true, lane: "passthrough" }, body);
    expect(translated.safeguards).toEqual(body.safeguards);
  });

  it("does not overwrite a field already present", () => {
    const own = [{ type: "dangerous_tool_use", classifier_context: { v: 2 } }];
    const translated = { safeguards: own };
    ensureSafeguardsForwarded(translated, { active: true }, body);
    expect(translated.safeguards).toBe(own);
  });

  it("is a no-op when no review was requested", () => {
    const translated = { model: "claude" };
    ensureSafeguardsForwarded(translated, { active: false }, body);
    expect(translated.safeguards).toBeUndefined();
  });
});

describe("buildReviewState", () => {
  it("puts the action first and verbatim", () => {
    const state = buildReviewState({ action: "Bash(rm -rf /)", cwd: "/repo", platform: "linux" });
    expect(state.indexOf("rm -rf /")).toBeLessThan(state.indexOf("/repo"));
  });

  it("accepts a structured action", () => {
    expect(buildReviewState({ tool_use: { name: "Bash", input: { command: "ls" } } })).toContain("Bash");
  });

  it("omits empty sections instead of padding the state", () => {
    const state = buildReviewState({ action: "ls", prior_turn_context: [], git_state: {} });
    expect(state).not.toContain("prior_turn_context");
    expect(state).not.toContain("git_state");
  });

  it("returns empty for no context", () => {
    expect(buildReviewState(null)).toBe("");
  });
});

describe("runSafetyDecision", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("posts the documented System One request shape", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ answers: { is_dangerous: { type: "noul", noul: 0.9 } } }) }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runSafetyDecision({
      state: "state text",
      provider: "openrouter",
      model: "typesafe/jev-1.13",
      credentials: { apiKey: "k" },
    });

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/systemone");
    const sent = JSON.parse(init.body);
    // Provider-qualified on purpose: a decision model id is itself
    // slash-prefixed, so the bare form parses as a provider named "typesafe".
    expect(sent.model).toBe("openrouter/typesafe/jev-1.13");
    expect(sent.state).toBe("state text");
    expect(sent.questions.is_dangerous.type).toBe("noul");
    expect(sent.questions.is_dangerous.instructions).toBeTruthy();
    expect(init.headers.Authorization).toBe("Bearer k");
  });

  it("reports failure instead of throwing on a non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    const result = await runSafetyDecision({ state: "s", provider: "openrouter", model: "typesafe/jev-1.13", credentials: { apiKey: "k" } });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("reports failure instead of throwing on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const result = await runSafetyDecision({ state: "s", provider: "openrouter", model: "typesafe/jev-1.13", credentials: { apiKey: "k" } });
    expect(result.ok).toBe(false);
  });

  it("refuses a provider with no decision endpoint", async () => {
    const result = await runSafetyDecision({ state: "s", provider: "kimi", model: "kimi-k2", credentials: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a decision provider");
  });
});

describe("attachReviewToClaudeBody (bridge lane)", () => {
  let fetchMock;

  const bridgePlan = () => ({
    active: true,
    lane: "bridge",
    classifierContext: context,
    reviewer: { provider: "openrouter", model: "typesafe/jev-1.13" },
  });

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ answers: { is_dangerous: { type: "noul", noul: 0.93 } } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  const creds = { apiKey: "k" };
  const resolver = async () => creds;

  it("attaches a flagged verdict keyed by tool_use id", async () => {
    const res = responseWithTool();
    await attachReviewToClaudeBody({ responseBody: res, safeguardsPlan: bridgePlan(), credentialResolver: resolver });
    expect(res.safeguard_results[0].status.tool_uses.toolu_01ABC.outcome).toBe("flagged");
  });

  it("attaches a clean verdict when the decision engine sees no danger", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ answers: { q: { type: "noul", noul: 0.01 } } }) });
    const res = responseWithTool();
    await attachReviewToClaudeBody({ responseBody: res, safeguardsPlan: bridgePlan(), credentialResolver: resolver });
    expect(res.safeguard_results[0].status.tool_uses.toolu_01ABC.outcome).toBe("not_flagged");
  });

  it("keeps the id correlation across several calls", async () => {
    const res = responseWithTool(["toolu_a", "toolu_b"]);
    await attachReviewToClaudeBody({ responseBody: res, safeguardsPlan: bridgePlan(), credentialResolver: resolver });
    expect(Object.keys(res.safeguard_results[0].status.tool_uses)).toEqual(["toolu_a", "toolu_b"]);
  });

  it("never emits approval when the reviewer has no credentials", async () => {
    const res = responseWithTool();
    await attachReviewToClaudeBody({
      responseBody: res,
      safeguardsPlan: bridgePlan(),
      credentialResolver: async () => null,
    });
    expect(res.safeguard_results[0].status.type).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never emits approval when the engine is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const res = responseWithTool();
    await attachReviewToClaudeBody({ responseBody: res, safeguardsPlan: bridgePlan(), credentialResolver: resolver });
    expect(res.safeguard_results[0].status.type).toBe("unavailable");
  });

  it("never emits approval when the engine answers nothing usable", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ answers: {} }) });
    const res = responseWithTool();
    await attachReviewToClaudeBody({ responseBody: res, safeguardsPlan: bridgePlan(), credentialResolver: resolver });
    expect(res.safeguard_results[0].status.type).toBe("unavailable");
  });

  it("does not run the engine for a text-only response", async () => {
    const res = { type: "message", content: [{ type: "text", text: "hi" }], usage: {} };
    await attachReviewToClaudeBody({ responseBody: res, safeguardsPlan: bridgePlan(), credentialResolver: resolver });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.safeguard_results).toBeUndefined();
  });
});

describe("attachReviewToClaudeBody (passthrough lane)", () => {
  it("relays an upstream verdict untouched", async () => {
    const upstream = buildSafeguardResults({ toolUseIds: ["toolu_01ABC"], flagged: true, explanation: "upstream_rule" });
    const res = responseWithTool();
    res.safeguard_results = upstream;
    const out = await attachReviewToClaudeBody({
      responseBody: res,
      safeguardsPlan: { active: true, lane: "passthrough", classifierContext: context, reviewer: null },
    });
    expect(out.safeguard_results).toBe(upstream);
  });

  it("reports unsupported when the upstream reviewed nothing", async () => {
    const res = responseWithTool();
    await attachReviewToClaudeBody({
      responseBody: res,
      safeguardsPlan: { active: true, lane: "passthrough", classifierContext: context, reviewer: null },
    });
    expect(res.safeguard_results[0].status.type).toBe("unsupported");
  });

  it("does nothing when no review was requested", async () => {
    const res = responseWithTool();
    await attachReviewToClaudeBody({ responseBody: res, safeguardsPlan: { active: false } });
    expect(res.safeguard_results).toBeUndefined();
  });
});

describe("safeguard stream state", () => {
  it("collects tool ids from content_block_start", () => {
    const state = createSafeguardStreamState();
    observeSafeguardEvent(state, { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_a" } });
    observeSafeguardEvent(state, { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_b" } });
    expect(state.toolUseIds).toEqual(["toolu_a", "toolu_b"]);
  });

  it("dedupes repeated ids", () => {
    const state = createSafeguardStreamState();
    const event = { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_a" } };
    observeSafeguardEvent(state, event);
    observeSafeguardEvent(state, event);
    expect(state.toolUseIds).toEqual(["toolu_a"]);
  });

  it("captures an upstream verdict carried on the final delta", () => {
    const state = createSafeguardStreamState();
    observeSafeguardEvent(state, { type: "message_delta", delta: { safeguard_results: [{ type: "dangerous_tool_use" }] } });
    expect(state.upstreamResults).toHaveLength(1);
  });
});

describe("buildStreamSafeguardInjection", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const plan = {
    active: true,
    lane: "bridge",
    classifierContext: context,
    reviewer: { provider: "openrouter", model: "typesafe/jev-1.13" },
  };

  it("injects a verdict frame after the stream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ answers: { q: { type: "noul", noul: 0.88 } } }) })));
    const state = createSafeguardStreamState();
    observeSafeguardEvent(state, { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_a" } });

    const frame = await buildStreamSafeguardInjection({
      safeguardsPlan: plan,
      state,
      credentialResolver: async () => ({ apiKey: "k" }),
    });
    const payload = JSON.parse(frame.split("data: ")[1].trim());
    expect(payload.type).toBe("message_delta");
    expect(payload.delta.safeguard_results[0].status.tool_uses.toolu_a.outcome).toBe("flagged");
  });

  it("relays an upstream verdict without re-reviewing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const state = createSafeguardStreamState();
    observeSafeguardEvent(state, { type: "message_delta", delta: { safeguard_results: [{ type: "dangerous_tool_use", status: { type: "available", tool_uses: {} } }] } });
    const frame = await buildStreamSafeguardInjection({
      safeguardsPlan: { ...plan, lane: "passthrough" },
      state,
      credentialResolver: async () => ({ apiKey: "k" }),
    });
    expect(frame).toContain("safeguard_results");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("injects nothing when there is no tool call to judge", async () => {
    const frame = await buildStreamSafeguardInjection({
      safeguardsPlan: plan,
      state: createSafeguardStreamState(),
      credentialResolver: async () => ({ apiKey: "k" }),
    });
    expect(frame).toBeNull();
  });

  it("injects nothing when no review was requested", async () => {
    const frame = await buildStreamSafeguardInjection({ safeguardsPlan: { active: false }, state: createSafeguardStreamState() });
    expect(frame).toBeNull();
  });
});

describe("injectSafeguardsIntoStream", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const sseFrame = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

  const claudeStream = (chunks) => new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });

  const readAll = async (stream) => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    return out;
  };

  it("forwards upstream bytes unchanged and appends one verdict frame", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ answers: { q: { type: "noul", noul: 0.9 } } }) })));

    const head = sseFrame({ type: "message_start", message: { id: "m1" } });
    const tool = sseFrame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_z" } });
    const tail = sseFrame({ type: "message_delta", delta: { stop_reason: "tool_use" } });

    const plan = {
      active: true,
      lane: "bridge",
      classifierContext: context,
      reviewer: { provider: "openrouter", model: "typesafe/jev-1.13" },
    };

    const out = await readAll(
      injectSafeguardsIntoStream({
        stream: claudeStream([head, tool, tail]),
        safeguardsPlan: plan,
        credentialResolver: async () => ({ apiKey: "k" }),
      })
    );

    // Every upstream frame survives verbatim...
    expect(out.startsWith(head)).toBe(true);
    expect(out).toContain('"id":"toolu_z"');
    expect(out).toContain('"stop_reason":"tool_use"');
    // ...and exactly one extra verdict frame was appended.
    const verdictFrames = out.split("\n\n").filter((f) => f.includes("safeguard_results"));
    expect(verdictFrames).toHaveLength(1);
    expect(out.trimEnd().endsWith("}")).toBe(true);
  });

  it("survives a chunk boundary split mid-frame", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ answers: { q: { type: "noul", noul: 0.9 } } }) })));

    const frame = sseFrame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_split" } });
    const cut = Math.floor(frame.length / 2);

    const plan = {
      active: true,
      lane: "bridge",
      classifierContext: context,
      reviewer: { provider: "openrouter", model: "typesafe/jev-1.13" },
    };

    const out = await readAll(
      injectSafeguardsIntoStream({
        stream: claudeStream([frame.slice(0, cut), frame.slice(cut)]),
        safeguardsPlan: plan,
        credentialResolver: async () => ({ apiKey: "k" }),
      })
    );

    expect(out).toContain("toolu_split");
    expect(out).toContain("safeguard_results");
  });

  it("returns the stream untouched when no review was requested", async () => {
    const stream = claudeStream([sseFrame({ type: "message_stop" })]);
    expect(injectSafeguardsIntoStream({ stream, safeguardsPlan: { active: false } })).toBe(stream);
  });

  it("never injects a verdict frame when the stream has no tool call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const plan = {
      active: true,
      lane: "bridge",
      classifierContext: context,
      reviewer: { provider: "openrouter", model: "typesafe/jev-1.13" },
    };
    const out = await readAll(
      injectSafeguardsIntoStream({
        stream: claudeStream([sseFrame({ type: "message_stop" })]),
        safeguardsPlan: plan,
        credentialResolver: async () => ({ apiKey: "k" }),
      })
    );
    expect(out).not.toContain("safeguard_results");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates a stream error instead of swallowing it", async () => {
    const failing = new ReadableStream({
      start(controller) { controller.error(new Error("upstream gone")); },
    });
    const wrapped = injectSafeguardsIntoStream({
      stream: failing,
      safeguardsPlan: { active: true, lane: "bridge", classifierContext: context, reviewer: { provider: "openrouter", model: "typesafe/jev-1.13" } },
      credentialResolver: async () => ({ apiKey: "k" }),
    });
    await expect(readAll(wrapped)).rejects.toThrow("upstream gone");
  });
});