import { describe, it, expect, beforeEach, vi } from "vitest";

// A key's row is memoised for the hot path, so the ONLY thing standing between
// a revoked key and a self-service revival is this invalidation. Every one of
// these asserts an observable behaviour (does the key still authenticate?),
// not the cache's shape.
describe("api key cache invalidation", () => {
  beforeEach(async () => {
    vi.resetModules();
    delete global._dbAdapter;
    const { invalidateApiKeyCache } = await import("@/lib/db/repos/apiKeysRepo.js");
    invalidateApiKeyCache();
  });

  async function repos() {
    return await import("@/lib/db/repos/apiKeysRepo.js");
  }

  it("authenticates a freshly created key and drops it on deactivate", async () => {
    const { createApiKey, validateApiKey, updateApiKey } = await repos();

    const created = await createApiKey(`cache-${Date.now()}`, "machine-1");
    expect(await validateApiKey(created.key)).toBe(true);

    // Warm the cache, then deactivate through the repo.
    expect(await validateApiKey(created.key)).toBe(true);
    await updateApiKey(created.id, { isActive: false });

    expect(await validateApiKey(created.key)).toBe(false);
  });

  it("stops authenticating a deleted key even when it was already cached", async () => {
    const { createApiKey, validateApiKey, deleteApiKey } = await repos();

    const created = await createApiKey(`cache-del-${Date.now()}`, "machine-1");
    expect(await validateApiKey(created.key)).toBe(true);

    await deleteApiKey(created.id);

    expect(await validateApiKey(created.key)).toBe(false);
  });

  it("returns the updated access list, not the pre-edit one", async () => {
    const { createApiKey, getApiKeyByKey, updateApiKey } = await repos();

    const created = await createApiKey(`cache-access-${Date.now()}`, "machine-1");
    const before = await getApiKeyByKey(created.key);
    expect(before.access.restricted).toBe(false);

    await updateApiKey(created.id, { access: { restricted: true, allow: ["openai/gpt-4o"] } });

    const after = await getApiKeyByKey(created.key);
    expect(after.access.restricted).toBe(true);
    expect(after.access.allow).toEqual(["openai/gpt-4o"]);
  });

  it("does not authorise an unknown key", async () => {
    const { validateApiKey } = await repos();
    expect(await validateApiKey("sk-does-not-exist-anywhere")).toBe(false);
  });
});
