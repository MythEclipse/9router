import { describe, it, expect, vi } from "vitest";
import { cancelProviderResponseBody } from "../../open-sse/handlers/chatCore.js";

describe("chatCore connection cleanup", () => {
  it("cancels stale provider response body before replacing it", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = { body: { cancel } };

    await cancelProviderResponseBody(response);

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("ignores body cancel failures", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("already closed"));
    const response = { body: { cancel } };

    await expect(cancelProviderResponseBody(response)).resolves.toBeUndefined();
  });
});
