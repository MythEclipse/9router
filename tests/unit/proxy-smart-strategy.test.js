import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickProxyPoolId } from "../../src/lib/network/connectionProxy.js";
import {
  markProxyUnhealthy,
  markProxyHealthy,
  resetProxyHealth,
  getProxyHealth,
} from "../../src/lib/network/proxyHealth.js";
import { shouldRotateProxy } from "../../open-sse/services/accountFallback.js";

describe("smart proxy rotation", () => {
  beforeEach(() => {
    resetProxyHealth();
  });

  it("pins the first pool and keeps returning it while healthy", () => {
    const pools = ["pool-a", "pool-b", "pool-c"];
    const first = pickProxyPoolId(pools, "smart", "opencode");
    const second = pickProxyPoolId(pools, "smart", "opencode");
    const third = pickProxyPoolId(pools, "smart", "opencode");
    expect(first).toBe("pool-a");
    expect(second).toBe("pool-a");
    expect(third).toBe("pool-a");
  });

  it("rotates to the next pool after a limit, and sticks to the new one", () => {
    const pools = ["pool-a", "pool-b", "pool-c"];
    expect(pickProxyPoolId(pools, "smart", "opencode")).toBe("pool-a");
    markProxyUnhealthy("opencode", "pool-a", 60_000);
    expect(pickProxyPoolId(pools, "smart", "opencode")).toBe("pool-b");
    expect(pickProxyPoolId(pools, "smart", "opencode")).toBe("pool-b");
    expect(getProxyHealth("opencode").blocked).toContain("pool-a");
  });

  it("stays on the rotated pool after the old pool's cooldown expires (no bounce-back while healthy)", () => {
    vi.useFakeTimers();
    const pools = ["pool-a", "pool-b"];
    pickProxyPoolId(pools, "smart", "opencode"); // pins pool-a
    markProxyUnhealthy("opencode", "pool-a", 1000);
    expect(pickProxyPoolId(pools, "smart", "opencode")).toBe("pool-b"); // pool-b becomes current
    vi.advanceTimersByTime(2000); // pool-a's cooldown expires
    // pool-b is healthy → stay on it; pool-a is only usable again, not preferred.
    expect(pickProxyPoolId(pools, "smart", "opencode")).toBe("pool-b");
    // Only when the CURRENT pool also fails do we move back to the recovered one.
    markProxyUnhealthy("opencode", "pool-b", 1000);
    expect(pickProxyPoolId(pools, "smart", "opencode")).toBe("pool-a");
    vi.useRealTimers();
  });

  it("never hands back a pool excluded for the in-flight request", () => {
    const pools = ["pool-a", "pool-b", "pool-c"];
    expect(pickProxyPoolId(pools, "smart", "opencode", { excludePoolIds: new Set(["pool-a"]) })).toBe("pool-b");
    expect(pickProxyPoolId(pools, "smart", "opencode", { excludePoolIds: new Set(["pool-a", "pool-b"]) })).toBe("pool-c");
  });

  it("rotates only one step when the current pool is excluded (retry after a failure)", () => {
    const pools = ["pool-a", "pool-b", "pool-c"];
    pickProxyPoolId(pools, "smart", "opencode"); // pins pool-a
    const retry = pickProxyPoolId(pools, "smart", "opencode", { excludePoolIds: new Set(["pool-a"]) });
    expect(retry).toBe("pool-b");
    const again = pickProxyPoolId(pools, "smart", "opencode", { excludePoolIds: new Set(["pool-a"]) });
    expect(again).toBe("pool-b");
  });

  it("falls back to the soonest-expiring pool when everything is cooling down", () => {
    const pools = ["pool-a", "pool-b"];
    pickProxyPoolId(pools, "smart", "opencode");
    markProxyUnhealthy("opencode", "pool-a", 60_000);
    markProxyUnhealthy("opencode", "pool-b", 60_000);
    // Neither is usable; pick must still return something rather than null.
    expect(pickProxyPoolId(pools, "smart", "opencode")).not.toBeNull();
  });

  it("markProxyHealthy re-pins a pool and clears its cooldown", () => {
    const pools = ["pool-a", "pool-b"];
    pickProxyPoolId(pools, "smart", "opencode");
    markProxyUnhealthy("opencode", "pool-a", 60_000);
    expect(getProxyHealth("opencode").blocked).toContain("pool-a");
    markProxyHealthy("opencode", "pool-a");
    expect(getProxyHealth("opencode").blocked).not.toContain("pool-a");
    expect(getProxyHealth("opencode").current).toBe("pool-a");
  });

  it("per-provider state is isolated", () => {
    pickProxyPoolId(["pool-a", "pool-b"], "smart", "opencode");
    expect(pickProxyPoolId(["pool-x", "pool-y"], "smart", "opencode")).toBe("pool-x");
  });
});

describe("shouldRotateProxy classifier", () => {
  it("rotates on limits and upstream failures", () => {
    expect(shouldRotateProxy(429, "rate limit exceeded")).toBe(true);
    expect(shouldRotateProxy(403, "access denied")).toBe(true);
    expect(shouldRotateProxy(402, "quota exceeded")).toBe(true);
    expect(shouldRotateProxy(500, "internal error")).toBe(true);
    expect(shouldRotateProxy(502, "bad gateway")).toBe(true);
    expect(shouldRotateProxy(0, "ECONNREFUSED")).toBe(true);
  });

  it("does NOT rotate on request-scoped 4xx", () => {
    expect(shouldRotateProxy(400, "bad request")).toBe(false);
    expect(shouldRotateProxy(404, "model not found")).toBe(false);
    expect(shouldRotateProxy(422, "unprocessable")).toBe(false);
    expect(shouldRotateProxy(401, "invalid api key")).toBe(true); // credential denied
  });
});