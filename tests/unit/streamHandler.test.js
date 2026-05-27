import { describe, it, expect, vi } from "vitest";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";

async function readWithTimeout(reader, timeoutMs = 100) {
  return Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("read timed out")), timeoutMs))
  ]);
}

describe("pipeWithDisconnect", () => {
  it("does not leave client stream stuck when upstream ends while transform flush hangs", async () => {
    vi.useFakeTimers();

    const providerResponse = new Response(new Blob(["data: hello\n\n"]).stream());
    const transformStream = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush() {
        return new Promise(() => {});
      }
    });
    const streamController = createStreamController({ provider: "test", model: "model" });
    const stream = pipeWithDisconnect(providerResponse, transformStream, streamController);
    const reader = stream.getReader();

    try {
      const first = await readWithTimeout(reader);
      expect(first.done).toBe(false);

      const secondPromise = reader.read();
      await vi.advanceTimersByTimeAsync(35_001);

      await expect(secondPromise).resolves.toEqual({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
      await reader.cancel().catch(() => {});
    }
  });
});
