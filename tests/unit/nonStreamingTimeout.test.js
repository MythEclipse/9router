import { describe, it, expect, vi } from "vitest";
import { readProviderResponseBody } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

describe("readProviderResponseBody", () => {
  it("cancels provider body when JSON read times out", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = {
      body: { cancel },
      json: () => new Promise(() => {})
    };

    try {
      const expectation = expect(readProviderResponseBody(response, "json", 100)).rejects.toThrow("provider response body timeout");
      await vi.advanceTimersByTimeAsync(101);

      await expectation;
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels provider body when text read times out", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = {
      body: { cancel },
      text: () => new Promise(() => {})
    };

    try {
      const expectation = expect(readProviderResponseBody(response, "text", 100)).rejects.toThrow("provider response body timeout");
      await vi.advanceTimersByTimeAsync(101);

      await expectation;
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
