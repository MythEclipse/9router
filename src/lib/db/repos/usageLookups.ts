/**
 * Display-name lookups for the usage report.
 *
 * A usage row stores ids, never names: `usageDaily` keeps a masked api key, a
 * connection id and a provider node id, and the report has to turn each back into
 * something a human recognises. These builders were inlined at the top of
 * `getUsageStats`, which made a 500-line function open with 40 lines of plumbing
 * and hid where the real work started.
 *
 * The api-key bucket id is NOT redefined here: it must stay byte-identical to the
 * one the write path stamps into `usageDaily` (see `usageRepo.apiKeyBucketId`,
 * which carries the AUDIT-002 reasoning), or the report stops finding its own rows.
 */

/** What the report shows for an api key. */
export interface ApiKeyLabel {
  name: string;
  id: string;
  createdAt: string;
}

/** Connection id → display name. */
export type ConnectionMap = Record<string, string>;

/** Provider node id → display name. */
export type ProviderNodeNameMap = Record<string, string>;

/** A row shape the builders tolerate: anything may be missing. */
interface Named {
  id?: string;
  name?: string;
  email?: string;
}

/** Build the connection id → display name map. */
export function buildConnectionMap(connections: Named[] | null | undefined): ConnectionMap {
  const map: ConnectionMap = {};
  for (const c of connections || []) {
    if (c?.id) map[c.id] = c.name || c.email || c.id;
  }
  return map;
}

/** Build the provider node id → display name map. */
export function buildProviderNodeNameMap(nodes: Named[] | null | undefined): ProviderNodeNameMap {
  const map: ProviderNodeNameMap = {};
  for (const n of nodes || []) if (n?.id && n?.name) map[n.id] = n.name;
  return map;
}

/** The two api-key lookups a report needs. */
export interface ApiKeyMaps {
  /** Raw (trimmed) key → label, for the live-history branch. */
  byKey: Record<string, ApiKeyLabel>;
  /** Bucket id → label, for the `usageDaily` branch. */
  byBucketId: Record<string, ApiKeyLabel>;
}

/**
 * Build both api-key lookups in one pass.
 *
 * The daily branch cannot look a name up by raw key the way the live-history
 * branch does — `usageDaily` stores only the masked key plus the bucket id
 * embedded in its entry key — so both shapes are built together from one read
 * rather than each reader rebuilding its own.
 *
 * @param bucketId the write path's own bucket function, injected so there is
 *   exactly one implementation of that digest in the codebase
 */
export function buildApiKeyMaps(
  keys: Array<{ key?: string | null; name?: string; id?: string; createdAt?: string }> | null | undefined,
  bucketId: (key: string) => string
): ApiKeyMaps {
  const byKey: Record<string, ApiKeyLabel> = {};
  const byBucketId: Record<string, ApiKeyLabel> = {};
  for (const k of keys || []) {
    if (!k?.key) continue;
    const trimmed = k.key.trim();
    const label: ApiKeyLabel = {
      name: k.name as string,
      id: k.id as string,
      createdAt: k.createdAt as string,
    };
    byKey[trimmed] = label;
    byBucketId[bucketId(trimmed)] = label;
  }
  return { byKey, byBucketId };
}
