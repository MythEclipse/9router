import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  hasSafeguardsRequest,
  getClassifierContext,
  hasSafeguardsBetaHeader,
  collectToolUseIds,
  buildSafeguardResults,
  buildUnavailableResults,
  readSystemoneProbability,
  buildSafeguardResultsFromDecision,
  attachSafeguardResults,
  buildSafeguardMessageDeltaSse,
  DEFAULT_FLAG_THRESHOLD,
} from "open-sse/handlers/safeguardsProtocol.js";
import {
  DANGEROUS_TOOL_USE_BETA,
  AUTO_MODE_CLASSIFIER_BETA,
  SAFEGUARD_TYPE_DANGEROUS_TOOL_USE,
} from "open-sse/config/safeguardsConstants.js";

const claudeRequest = (context = { v: 1 }) => ({
  model: "claude-opus-5-5",
  safeguards: [{ type: "dangerous_tool_use", classifier_context: context }],
});

const claudeResponse = (ids = ["toolu_01ABC"]) => ({
  type: "message",
  role: "assistant",
  content: [
    { type: "text", text: "running it" },
    ...ids.map((id) => ({ type: "tool_use", id, name: "Bash", input: { command: "ls" } })),
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe("safeguards request detection", () => {
  it("detects the dangerous_tool_use entry", () => {
    expect(hasSafeguardsRequest(claudeRequest())).toBe(true);
  });

  it("ignores a body with no safeguards field", () => {
    expect(hasSafeguardsRequest({ model: "x", messages: [] })).toBe(false);
  });

  it("ignores an unrelated or malformed safeguards value", () => {
    expect(hasSafeguardsRequest({ safeguards: [] })).toBe(false);
    expect(hasSafeguardsRequest({ safeguards: {} })).toBe(false);
    expect(hasSafeguardsRequest({ safeguards: [{ type: "other_check" }] })).toBe(false);
  });

  it("reads back the classifier context that was sent", () => {
    const context = { v: 1, live_cwd: "/repo" };
    expect(getClassifierContext(claudeRequest(context))).toEqual(context);
  });

  it("returns null context when absent", () => {
    expect(getClassifierContext({})).toBeNull();
  });

  it("recognizes the pairing beta in either header casing", () => {
    expect(hasSafeguardsBetaHeader({ "anthropic-beta": `foo,${DANGEROUS_TOOL_USE_BETA}` })).toBe(true);
    expect(hasSafeguardsBetaHeader({ "Anthropic-Beta": DANGEROUS_TOOL_USE_BETA })).toBe(true);
  });

  it("does not treat the billed classifier beta as the server-side pairing", () => {
    // These are different betas; conflating them would make the gateway claim
    // server-side review while actually forwarding a plain classifier request.
    expect(AUTO_MODE_CLASSIFIER_BETA).not.toBe(DANGEROUS_TOOL_USE_BETA);
    expect(hasSafeguardsBetaHeader({ "anthropic-beta": AUTO_MODE_CLASSIFIER_BETA })).toBe(false);
  });
});

describe("collectToolUseIds", () => {
  it("collects ids in wire order", () => {
    expect(collectToolUseIds(claudeResponse(["toolu_a", "toolu_b"]))).toEqual(["toolu_a", "toolu_b"]);
  });

  it("returns empty for a text-only message", () => {
    expect(collectToolUseIds({ content: [{ type: "text", text: "hi" }] })).toEqual([]);
  });

  it("tolerates a missing body", () => {
    expect(collectToolUseIds(null)).toEqual([]);
    expect(collectToolUseIds({})).toEqual([]);
  });
});

describe("buildSafeguardResults", () => {
  it("keys verdicts by tool_use id, as the client correlates them", () => {
    const [result] = buildSafeguardResults({ toolUseIds: ["toolu_a", "toolu_b"], flagged: false });
    expect(result.type).toBe(SAFEGUARD_TYPE_DANGEROUS_TOOL_USE);
    expect(result.status.type).toBe("available");
    expect(Object.keys(result.status.tool_uses)).toEqual(["toolu_a", "toolu_b"]);
    expect(result.status.tool_uses.toolu_a).toEqual({ type: "evaluated", outcome: "not_flagged" });
  });

  it("marks a block as flagged with its rule explanation", () => {
    const [result] = buildSafeguardResults({ toolUseIds: ["toolu_a"], flagged: true, explanation: "destructive_fs_write" });
    expect(result.status.tool_uses.toolu_a).toEqual({
      type: "evaluated",
      outcome: "flagged",
      explanation: "destructive_fs_write",
    });
  });

  it("omits explanation on a clean verdict", () => {
    const [result] = buildSafeguardResults({ toolUseIds: ["toolu_a"], flagged: false, explanation: "ignored" });
    expect(result.status.tool_uses.toolu_a.explanation).toBeUndefined();
  });

  it("emits exactly one entry (two make the client discard the result)", () => {
    expect(buildSafeguardResults({ toolUseIds: ["a"], flagged: false })).toHaveLength(1);
  });

  it("reports review as available with no calls to judge", () => {
    const [result] = buildSafeguardResults({ toolUseIds: [], flagged: false });
    expect(result.status.type).toBe("available");
    expect(result.status.tool_uses).toEqual({});
  });
});

describe("buildUnavailableResults", () => {
  it("defaults to unsupported", () => {
    expect(buildUnavailableResults()[0].status).toEqual({ type: "unsupported" });
  });

  it("carries a reason when unavailable", () => {
    expect(buildUnavailableResults("unavailable", "engine down")[0].status)
      .toEqual({ type: "unavailable", reason: "engine down" });
  });
});

describe("readSystemoneProbability", () => {
  it("reads the live TypeSafe noul answer shape", () => {
    // Captured verbatim from a live /v1/systemone call.
    const live = {
      model: "typesafe/jev-1.13-20260917",
      answers: { is_urgent: { type: "noul", noul: 0.66 } },
      usage: { input_tokens: 311, output_tokens: 23 },
    };
    expect(readSystemoneProbability(live)).toBe(0.66);
  });

  it("accepts any question key", () => {
    expect(readSystemoneProbability({ answers: { is_dangerous: { type: "noul", noul: 0.4 } } })).toBe(0.4);
  });

  it("tolerates provider-specific aliases", () => {
    expect(readSystemoneProbability({ answers: { q: { probability: 0.9 } } })).toBe(0.9);
  });

  it("returns null when there is no usable answer", () => {
    expect(readSystemoneProbability({})).toBeNull();
    expect(readSystemoneProbability({ answers: {} })).toBeNull();
    expect(readSystemoneProbability({ answers: { q: { type: "bool" } } })).toBeNull();
    expect(readSystemoneProbability({ answers: { q: { noul: "high" } } })).toBeNull();
  });
});

describe("buildSafeguardResultsFromDecision", () => {
  it("flags at or above the threshold", () => {
    const [r] = buildSafeguardResultsFromDecision({
      systemoneResponse: { answers: { q: { type: "noul", noul: DEFAULT_FLAG_THRESHOLD } } },
      toolUseIds: ["toolu_a"],
    });
    expect(r.status.tool_uses.toolu_a.outcome).toBe("flagged");
  });

  it("clears below the threshold", () => {
    const [r] = buildSafeguardResultsFromDecision({
      systemoneResponse: { answers: { q: { type: "noul", noul: 0.49 } } },
      toolUseIds: ["toolu_a"],
    });
    expect(r.status.tool_uses.toolu_a.outcome).toBe("not_flagged");
  });

  it("honours a custom threshold", () => {
    const [r] = buildSafeguardResultsFromDecision({
      systemoneResponse: { answers: { q: { type: "noul", noul: 0.3 } } },
      toolUseIds: ["toolu_a"],
      threshold: 0.2,
    });
    expect(r.status.tool_uses.toolu_a.outcome).toBe("flagged");
  });

  it("never reports approval when the engine gives no answer", () => {
    // The critical safety property: an engine failure must fall back to the
    // client's own classifier, never read as "safe".
    const [r] = buildSafeguardResultsFromDecision({ systemoneResponse: { answers: {} }, toolUseIds: ["toolu_a"] });
    expect(r.status.type).toBe("unavailable");
    expect(r.status.tool_uses).toBeUndefined();
  });
});

describe("attachSafeguardResults", () => {
  it("adds the field to the response body", () => {
    const body = claudeResponse();
    attachSafeguardResults(body, buildSafeguardResults({ toolUseIds: ["toolu_01ABC"], flagged: false }));
    expect(body.safeguard_results).toHaveLength(1);
    expect(body.safeguard_results[0].status.tool_uses.toolu_01ABC.outcome).toBe("not_flagged");
  });

  it("leaves a body with no content array untouched", () => {
    const body = { type: "message" };
    attachSafeguardResults(body, buildSafeguardResults({ toolUseIds: [], flagged: false }));
    expect(body.safeguard_results).toBeUndefined();
  });
});

describe("buildSafeguardMessageDeltaSse", () => {
  it("emits a message_delta event carrying the verdicts", () => {
    const results = buildSafeguardResults({ toolUseIds: ["toolu_a"], flagged: true, explanation: "force_push" });
    const frame = buildSafeguardMessageDeltaSse({ safeguardResults: results });
    expect(frame.startsWith("event: message_delta\ndata: ")).toBe(true);
    const payload = JSON.parse(frame.split("data: ")[1].trim());
    expect(payload.type).toBe("message_delta");
    expect(payload.delta.safeguard_results).toEqual(results);
  });

  it("preserves the caller's stop_reason in the same delta", () => {
    const frame = buildSafeguardMessageDeltaSse({
      safeguardResults: buildSafeguardResults({ toolUseIds: [], flagged: false }),
      delta: { stop_reason: "tool_use" },
    });
    const payload = JSON.parse(frame.split("data: ")[1].trim());
    expect(payload.delta.stop_reason).toBe("tool_use");
    expect(payload.delta.safeguard_results).toHaveLength(1);
  });
});