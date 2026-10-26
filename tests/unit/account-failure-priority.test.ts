import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

beforeEach(() => {
  vi.clearAllMocks();
  db.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
});

describe("account selection failure history", () => {
  it("keeps selecting the next healthier account after a failed account's lock expires", async () => {
    db.getProviderConnections.mockResolvedValue([
      {
        id: "account-1",
        priority: 1,
        rateLimitCount: 1,
        lastRateLimitAt: "2026-10-24T18:00:00.000Z",
        modelLock_test: "2026-10-24T18:01:00.000Z",
      },
      { id: "account-2", priority: 2, rateLimitCount: 0 },
      { id: "account-3", priority: 3, rateLimitCount: 0 },
    ]);

    const credentials = await getProviderCredentials("openai", null, "test");

    expect(credentials.connectionId).toBe("account-2");
  });

  it("honours an explicitly preferred connection even when it has failure history", async () => {
    db.getProviderConnections.mockResolvedValue([
      { id: "account-1", priority: 1, rateLimitCount: 1 },
      { id: "account-2", priority: 2, rateLimitCount: 0 },
    ]);

    const credentials = await getProviderCredentials("openai", null, "test", {
      preferredConnectionId: "account-1",
    });

    expect(credentials.connectionId).toBe("account-1");
  });
});
