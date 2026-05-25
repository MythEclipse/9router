import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/shared/utils/machineId.js", () => ({
  getConsistentMachineId: async () => "test-machine",
}));

const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
const { parseUpstreamError } = await import("../../open-sse/utils/error.js");

describe("Codex Cloudflare challenge handling", () => {
  function cloudflareChallengeResponse() {
    return new Response("<html>Cloudflare challenge</html>", {
      status: 403,
      headers: {
        "cf-mitigated": "challenge",
        "content-type": "text/html; charset=UTF-8",
      },
    });
  }

  it("reports Cloudflare challenge as upstream challenge instead of generic 403", async () => {
    const result = await parseUpstreamError(cloudflareChallengeResponse(), new CodexExecutor());

    expect(result.statusCode).toBe(503);
    expect(result.message).toContain("Cloudflare challenge");
    expect(result.message).toContain("configure a proxy pool");
  });

  it("does not refresh credentials for Cloudflare challenge", () => {
    expect(new CodexExecutor().shouldRefreshCredentials(cloudflareChallengeResponse())).toBe(false);
  });
});
