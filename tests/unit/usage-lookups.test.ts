import { describe, it, expect } from "vitest";
import {
  buildApiKeyMaps,
  buildConnectionMap,
  buildProviderNodeNameMap,
} from "@/lib/db/repos/usageLookups";
import { __test__ } from "@/lib/db/repos/usageRepo";

/**
 * The report's label lookups. Two things must stay true across refactors:
 *
 *   1. an id that the tables reference resolves to the name a human set, and
 *   2. the api-key bucket id is byte-identical to the one the write path stamped,
 *      or the daily branch silently stops finding its own rows.
 */
describe("buildConnectionMap", () => {
  it("prefers the display name, then the email, then the id", () => {
    const map = buildConnectionMap([
      { id: "c1", name: "Work account", email: "work@x.io" },
      { id: "c2", email: "no-name@x.io" },
      { id: "c3" },
    ]);
    expect(map).toEqual({ c1: "Work account", c2: "no-name@x.io", c3: "c3" });
  });

  it("skips rows without an id", () => {
    expect(buildConnectionMap([{ name: "orphan" }, null as any])).toEqual({});
  });

  it("returns an empty map for null or undefined", () => {
    expect(buildConnectionMap(null)).toEqual({});
    expect(buildConnectionMap(undefined)).toEqual({});
  });
});

describe("buildProviderNodeNameMap", () => {
  it("maps id to name", () => {
    expect(buildProviderNodeNameMap([{ id: "n1", name: "Router" }])).toEqual({ n1: "Router" });
  });

  it("skips nodes missing either half", () => {
    expect(buildProviderNodeNameMap([{ id: "n1" }, { name: "no-id" }])).toEqual({});
  });

  it("returns an empty map for null", () => {
    expect(buildProviderNodeNameMap(null)).toEqual({});
  });
});

describe("buildApiKeyMaps", () => {
  const bucketId = (key: string) => `B(${key})`;

  it("builds both lookups from one read", () => {
    const { byKey, byBucketId } = buildApiKeyMaps(
      [{ key: " sk-abc ", name: "Main", id: "k1", createdAt: "2026-01-01" }],
      bucketId
    );
    expect(byKey).toEqual({ "sk-abc": { name: "Main", id: "k1", createdAt: "2026-01-01" } });
    expect(byBucketId).toEqual({ "B(sk-abc)": { name: "Main", id: "k1", createdAt: "2026-01-01" } });
  });

  it("trims the key, so a padded and an unpadded key collide as they should", () => {
    const { byKey } = buildApiKeyMaps([{ key: "  sk-abc  ", name: "Main", id: "k1", createdAt: "" }], bucketId);
    expect(Object.keys(byKey)).toEqual(["sk-abc"]);
  });

  it("drops rows with no usable key", () => {
    const { byKey, byBucketId } = buildApiKeyMaps(
      [{ key: "", name: "empty", id: "k0", createdAt: "" }, { key: null, name: "null", id: "k2", createdAt: "" }, null as any],
      bucketId
    );
    expect(byKey).toEqual({});
    expect(byBucketId).toEqual({});
  });

  it("lets the most recent row win for a duplicated key", () => {
    const { byKey } = buildApiKeyMaps(
      [
        { key: "sk-dup", name: "first", id: "a", createdAt: "" },
        { key: "sk-dup", name: "second", id: "b", createdAt: "" },
      ],
      bucketId
    );
    expect(byKey["sk-dup"].name).toBe("second");
  });

  it("returns empty maps for null", () => {
    expect(buildApiKeyMaps(null, bucketId)).toEqual({ byKey: {}, byBucketId: {} });
  });
});

describe("the bucket id digest is unchanged", () => {
  /**
   * The write path stamps this digest into `usageDaily`'s entry keys. If it ever
   * changes, every historical row becomes unlabelled — so the exact value is
   * pinned here rather than left to be inferred from the implementation.
   */
  it("is sha256 truncated to 16 hex chars", () => {
    const id = __test__.apiKeyBucketId("sk-test-key");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    // Pinned value: sha256("sk-test-key") truncated. If this changes, every row
    // already written to usageDaily becomes unlabelled — edit deliberately.
    expect(id).toBe("0d62f396c1317066");
  });

  it("is stable and collapses surrounding whitespace only via the caller's trim", () => {
    expect(__test__.apiKeyBucketId("sk-abc")).toBe(__test__.apiKeyBucketId("sk-abc"));
    // The digest itself does not trim; buildApiKeyMaps does. Two padded variants
    // of the same key are therefore distinct buckets unless trimmed upstream.
    expect(__test__.apiKeyBucketId(" sk-abc")).not.toBe(__test__.apiKeyBucketId("sk-abc"));
  });

  it("does not embed the secret", () => {
    const secret = "sk-live-super-secret";
    expect(__test__.apiKeyBucketId(secret)).not.toContain("sk-live");
  });
});
