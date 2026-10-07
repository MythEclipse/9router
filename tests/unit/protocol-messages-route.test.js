import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);

// handleChat resolves settings before the model check. Mock the pieces the route
// imports that would otherwise touch the real DB, then hit the real POST.
const { POST } = await import("../../src/app/api/v1/messages/route.js");

async function postMessages(body) {
  return POST(new Request("https://router.test/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

describe("POST /v1/messages — Anthropic protocol enforcement", () => {
  it("returns Anthropic envelope for invalid JSON", async () => {
    const res = await postMessages("{not json");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBeUndefined();
  });

  it("rejects a body missing max_tokens with a protocol-shaped 400", async () => {
    const res = await postMessages({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.message).toContain("max_tokens");
  });

  it("rejects an empty messages array", async () => {
    const res = await postMessages({ max_tokens: 10, messages: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("messages");
  });

  it("accepts a valid Anthropic body past validation (requireApiKey goes 401 envelope)", async () => {
    db.getSettings.mockResolvedValueOnce({ requireApiKey: true });
    const res = await postMessages({ max_tokens: 10, model: "cc/claude-opus-5-5", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
  });

  it("keeps OpenAI endpoints on the OpenAI envelope", async () => {
    const { POST: chatPost } = await import("../../src/app/api/v1/chat/completions/route.js");
    db.getSettings.mockResolvedValueOnce({ requireApiKey: true });
    const res = await chatPost(new Request("https://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe("authentication_error");
    expect(body.type).toBeUndefined();
  });

  it("never applies Anthropic's max_tokens rule to /v1/chat/completions", async () => {
    const { POST: chatPost } = await import("../../src/app/api/v1/chat/completions/route.js");
    db.getSettings.mockResolvedValueOnce({ requireApiKey: true });
    const res = await chatPost(new Request("https://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // OpenAI has no max_tokens requirement — this must reach auth, not a 400
      body: JSON.stringify({ model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] }),
    }));
    const body = await res.json();
    expect(res.status).not.toBe(400);
    expect(body.error.message).not.toContain("max_tokens");
  });
});