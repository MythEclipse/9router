import { beforeEach, describe, expect, it, vi } from "vitest";

const { findBinaryMock, executeNativeSessionMock, fetchMock } = vi.hoisted(() => ({
  findBinaryMock: vi.fn(),
  executeNativeSessionMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/opencodeCliRunner.js", () => ({
  findOpencodeBinary: findBinaryMock,
}));

vi.mock("../../open-sse/utils/opencodeNativeSession.js", () => ({
  executeOpencodeNativeSession: executeNativeSessionMock,
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { OpenCodeV2Executor } from "../../open-sse/executors/opencode.js";

beforeEach(() => {
  findBinaryMock.mockReset().mockReturnValue("/usr/bin/opencode");
  executeNativeSessionMock.mockReset().mockResolvedValue({ url: "opencode://session/ses_test" });
  fetchMock.mockReset();
});

describe("OpenCode native-session execution", () => {
  it("executes requests through a native OpenCode session", async () => {
    const result = await new OpenCodeV2Executor().execute({
      model: "model-a",
      body: { messages: [{ role: "user", content: "hello" }] },
    });

    expect(result.url).toBe("opencode://session/ses_test");
    expect(executeNativeSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/model-a",
      rawModel: "model-a",
      body: { messages: [{ role: "user", content: "hello" }] },
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails instead of using HTTP when the CLI is unavailable", async () => {
    findBinaryMock.mockReturnValue(null);

    await expect(new OpenCodeV2Executor().execute({
      model: "model-a",
      body: { messages: [{ role: "user", content: "hello" }] },
    })).rejects.toThrow("OpenCode CLI is required");

    expect(executeNativeSessionMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends requests with client tools through the CLI instead of HTTP", async () => {
    const body = {
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "lookup" } }],
    };
    await new OpenCodeV2Executor().execute({ model: "model-a", body });

    expect(executeNativeSessionMock).toHaveBeenCalledWith(expect.objectContaining({ body }));
    expect(executeNativeSessionMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps client tool definitions and prior tool results in the CLI prompt", async () => {
    const { formatOpencodeCliPrompt: formatPrompt } = await vi.importActual(
      "../../open-sse/utils/opencodeCliRunner.js",
    );
    const prompt = formatPrompt({
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      messages: [
        { role: "user", content: "Find the value." },
        { role: "assistant", content: null, tool_calls: [{ id: "call-1", function: { name: "lookup" } }] },
        { role: "tool", name: "lookup", content: "value is 42" },
        { role: "user", content: "What did you find?" },
      ],
    });

    expect(prompt).toContain("Client Tool Definitions");
    expect(prompt).toContain('"name":"lookup"');
    expect(prompt).toContain("Tool calls:");
    expect(prompt).toContain("Tool result (lookup): value is 42");
    expect(prompt).toContain("User: What did you find?");
  });

  it("passes large message bodies through to the native session without using HTTP", async () => {
    const content = "x".repeat(24000);
    await new OpenCodeV2Executor().execute({
      model: "model-a",
      body: { messages: [{ role: "user", content }] },
    });

    expect(executeNativeSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      body: { messages: [{ role: "user", content }] },
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates CLI failures without retrying over HTTP", async () => {
    executeNativeSessionMock.mockRejectedValue(new Error("OpenCode server failed"));

    await expect(new OpenCodeV2Executor().execute({
      model: "model-a",
      body: { messages: [{ role: "user", content: "hello" }] },
    })).rejects.toThrow("OpenCode server failed");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
