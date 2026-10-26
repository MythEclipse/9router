import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadRuntimeDepMock, fetchMock, closeMock } = vi.hoisted(() => ({
  loadRuntimeDepMock: vi.fn(),
  fetchMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock("../../open-sse/services/lazyRuntime.js", () => ({
  loadRuntimeDep: loadRuntimeDepMock,
}));

async function importClient() {
  vi.resetModules();
  return import("../../open-sse/services/opencodeTlsClient.js");
}

beforeEach(() => {
  loadRuntimeDepMock.mockReset().mockResolvedValue({
    createSession: () => ({ fetch: fetchMock, close: closeMock }),
  });
  fetchMock.mockReset().mockResolvedValue(new Response("ok", { status: 201 }));
  closeMock.mockReset();
});

describe("OpenCode TLS transport", () => {
  it("creates one session and forwards request, timeout, and abort signal", async () => {
    const { opencodeTlsFetch } = await importClient();
    const abortController = new AbortController();

    const response = await opencodeTlsFetch(
      "https://opencode.ai/inference/v1/chat/completions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      { signal: abortController.signal, timeoutMs: 5000 }
    );

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("ok");
    expect(loadRuntimeDepMock).toHaveBeenCalledWith("wreq-js");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/inference/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        timeout: 5000,
        signal: abortController.signal,
      })
    );
    expect(loadRuntimeDepMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a clear error when the optional TLS dependency is unavailable", async () => {
    loadRuntimeDepMock.mockRejectedValue(new Error("MODULE_NOT_FOUND"));
    const { opencodeTlsFetch } = await importClient();

    await expect(opencodeTlsFetch("https://opencode.ai")).rejects.toThrow(
      "wreq-js unavailable (MODULE_NOT_FOUND)"
    );
    expect(loadRuntimeDepMock).toHaveBeenCalledTimes(1);
  });
});
