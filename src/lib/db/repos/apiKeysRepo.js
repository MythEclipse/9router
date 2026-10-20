import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

// Per-request key lookups.
//
// Every /v1 call resolves the presented key twice — once to authenticate it
// (`validateApiKey`) and once to read its allow-list (`getApiKeyByKey`) — and
// both used to be `SELECT * FROM apiKeys WHERE key = ?`, pulling every column
// including the key itself just to read one boolean. A key's row changes only
// when the dashboard edits it, so a short TTL cache in front of BOTH paths
// removes two synchronous queries per request.
//
// Invalidation is a full clear, not a targeted delete: `updateApiKey` can change
// the key STRING, and `importDb` rewrites the table behind this repo, so an
// id-based eviction would leave the old string authenticating a stale row. Keys
// are written by hand, a handful of times ever, so clearing costs nothing.
const KEY_CACHE_TTL_MS = 5000;
const keyCache = new Map(); // key -> { row, ts }

export function invalidateApiKeyCache() {
  keyCache.clear();
}

async function loadKeyRow(key) {
  const hit = keyCache.get(key);
  if (hit && Date.now() - hit.ts <= KEY_CACHE_TTL_MS) return hit.row;

  const db = await getAdapter();
  // `apiKeys` is small (one row per issued key) and this is an indexed lookup,
  // but caching keeps the query off the per-request path entirely.
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]) || null;

  keyCache.set(key, { row, ts: Date.now() });
  // Bounded: an unknown-key flood must not grow this without limit.
  if (keyCache.size > 500) keyCache.delete(keyCache.keys().next().value);
  return row;
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  return rowToKey(await loadKeyRow(key));
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    access: { restricted: false, allow: [] },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, cols.accessRestricted, cols.accessAllow]
  );
  invalidateApiKeyCache();
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    const cols = keyAccessToColumns(merged.access);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, cols.accessRestricted, cols.accessAllow, id]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  // The key string may have changed and a deactivated key must stop
  // authenticating at once, so clear rather than evict by id.
  invalidateApiKeyCache();
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  invalidateApiKeyCache();
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  // Shares the cache with getApiKeyByKey: the same request resolves its key
  // twice, and both answers come from one row.
  const row = await loadKeyRow(key);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
