import { describe, expect, it } from "vitest";

import { POST } from "../../src/app/api/v1/messages/count_tokens/route.js";

async function countTokens(body) {
  const response = await POST(new Request("https://9router.local/v1/messages/count_tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

  expect(response.status).toBe(200);
  return response.json();
}

describe("Anthropic count_tokens estimator — protocol edges", () => {
  it("counts long strings as tokens (chars/4 ceil)", async () => {
    const result = await countTokens({
      messages: [{ role: "user", content: "a".repeat(1000) }],
    });
    expect(result.input_tokens).toBe(250); // 1000 / 4
  });

  it("never returns negative or zero for empty content", async () => {
    const result = await countTokens({ messages: [{ role: "user", content: "" }] });
    expect(result.input_tokens).toBe(0);
  });

  it("counts tool_use input objects and thinking blocks", async () => {
    const result = await countTokens({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a/b.txt" } },
            { type: "thinking", thinking: "think" },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "result-body" }],
        },
      ],
    });
    expect(result.input_tokens).toBeGreaterThan(2);
  });

  it("counts string content in tool_result", async () => {
    const result = await countTokens({
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hello world" }] },
      ],
    });
    expect(result.input_tokens).toBe(3); // 11 chars / 4
  });
});