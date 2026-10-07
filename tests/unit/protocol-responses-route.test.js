import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);

const { POST } = await import("../../src/app/api/v1/responses/route.js");

async function post(body) {
  return POST(new Request("https://router.test/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

describe("POST /v1/responses — OpenAI Responses protocol enforcement", () => {
  it("requires `input` and answers with the OpenAI error envelope", async () => {
    const res = await post({ model: "codex/gpt-5-codex" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("input");
    expect(body.error.type).toBe("invalid_request_error");
    // Responses clients are OpenAI-ecosystem clients — no Anthropic envelope
    expect(body.type).toBeUndefined();
  });

  it("rejects a non-string/non-array input", async () => {
    const res = await post({ model: "codex/gpt-5-codex", input: 7 });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("input");
  });

  it("returns the OpenAI envelope for auth failures, not Anthropic", async () => {
    db.getSettings.mockResolvedValueOnce({ requireApiKey: true });
    const res = await post({ model: "codex/gpt-5-codex", input: "hi" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe("authentication_error");
    expect(body.type).toBeUndefined();
  });

  it("invalid JSON keeps the OpenAI envelope", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });
});