// Locks edge cases flagged in docs 11 §1/§4 that were only covered indirectly.
import { describe, it, expect } from "vitest";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { parseDataUri, encodeDataUri } from "../../open-sse/translator/concerns/image.js";

describe("normalizeClaudePassthrough — haiku adaptive thinking (docs 11 §1)", () => {
  it("downgrades adaptive thinking to enabled+budget for haiku models", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-haiku-4-5");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  });

  it("keeps adaptive thinking for sonnet/opus", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-sonnet-4-6");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  it("folds mid-conversation system messages into the neighbouring user turn", () => {
    // Not hoisted into body.system: that would put volatile content ahead of the
    // whole conversation and invalidate the prefix cache on every request.
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "be brief" },
      ],
    };
    const original = body.messages;
    const out = normalizeClaudePassthrough(body, "claude-sonnet-4-6");

    // No top-level system is created, and no system-role message survives.
    expect(out.system).toBeUndefined();
    expect(out.messages.every((m) => m.role !== "system")).toBe(true);
    // The text is preserved on the preceding user turn instead.
    expect(JSON.stringify(out.messages)).toContain("be brief");

    // The caller's original messages array is not mutated in place: normalize
    // builds a fresh array and folds copy-on-write, so the array captured before
    // the call still holds the untouched turns.
    expect(out.messages).not.toBe(original);
    expect(original[1].role).toBe("system");
    expect(original[0].content).toBe("hi");
  });
});

describe("parseDataUri / encodeDataUri (docs 11 §4)", () => {
  it("parses a base64 data uri", () => {
    expect(parseDataUri("data:image/png;base64,AAAB")).toEqual({ mimeType: "image/png", base64: "AAAB" });
  });

  it("tolerates newlines inside base64 payload", () => {
    expect(parseDataUri("data:image/jpeg;base64,AA\nBB")?.base64).toBe("AA\nBB");
  });

  it("returns null for http urls and non-strings", () => {
    expect(parseDataUri("https://x/y.png")).toBeNull();
    expect(parseDataUri(null)).toBeNull();
  });

  it("encode/parse roundtrip", () => {
    const uri = encodeDataUri("image/webp", "ZZZ");
    expect(parseDataUri(uri)).toEqual({ mimeType: "image/webp", base64: "ZZZ" });
  });
});
