import { describe, it, expect, vi } from "vitest";
import { createStreamController, pipeWithDisconnect, createDisconnectAwareStream } from "../../open-sse/utils/streamHandler.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

async function readWithTimeout(reader, timeoutMs = 100) {
  return Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("read timed out")), timeoutMs))
  ]);
}

async function readStreamText(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
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

  it("sends DONE before closing when upstream ends while transform flush hangs", async () => {
    vi.useFakeTimers();

    const providerResponse = new Response(new Blob(["data: hello\n\n"]).stream());
    const encoder = new TextEncoder();
    const transformStream = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush() {
        return new Promise(() => {});
      }
    });
    const streamController = createStreamController({ provider: "test", model: "model" });
    const stream = pipeWithDisconnect(providerResponse, transformStream, streamController, {
      onFlushTimeout: (controller) => controller.enqueue(encoder.encode("data: [DONE]\n\n"))
    });
    const reader = stream.getReader();

    try {
      const first = await readWithTimeout(reader);
      expect(new TextDecoder().decode(first.value)).toBe("data: hello\n\n");

      const secondPromise = reader.read();
      await vi.advanceTimersByTimeAsync(35_001);

      const second = await secondPromise;
      expect(second.done).toBe(false);
      expect(new TextDecoder().decode(second.value)).toBe("data: [DONE]\n\n");
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
      await reader.cancel().catch(() => {});
    }
  });
});

describe("createDisconnectAwareStream", () => {
  it("removes timeout abort listener after a normal read", async () => {
    const timeoutController = new AbortController();
    const addEventListener = vi.spyOn(timeoutController.signal, "addEventListener");
    const removeEventListener = vi.spyOn(timeoutController.signal, "removeEventListener");
    const streamController = createStreamController({ provider: "test", model: "model" });
    const sourceStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
        controller.close();
      }
    });

    const stream = createDisconnectAwareStream({
      readable: sourceStream,
      writable: { getWriter: () => ({ abort: () => Promise.resolve() }) }
    }, streamController, timeoutController.signal);
    const reader = stream.getReader();
    const first = await reader.read();

    expect(first.done).toBe(false);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });
});

describe("createPassthroughStreamWithLogger", () => {
  it("does not append duplicate DONE when upstream already sent DONE", async () => {
    const input = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    const output = input.pipeThrough(createPassthroughStreamWithLogger("test"));
    const text = await readStreamText(output);

    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });
});
