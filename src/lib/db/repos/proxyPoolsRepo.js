import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// Proxy pools cache (TTL: 15s)
if (!global._proxyPoolsCache) global._proxyPoolsCache = { data: null, ts: 0 };
const CACHE_TTL_MS = 15000;

function invalidateProxyPoolsCache() {
  global._proxyPoolsCache = { data: null, ts: 0 };
}

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function poolToRow(p) {
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, p) {
  const r = poolToRow(p);
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive, testStatus=excluded.testStatus,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.isActive, r.testStatus, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProxyPools(filter = {}) {
  const now = Date.now();
  if (!global._proxyPoolsCache.data || now - global._proxyPoolsCache.ts >= CACHE_TTL_MS) {
    const db = await getAdapter();
    const rows = db.all(`SELECT * FROM proxyPools`);
    const list = rows.map(rowToPool);
    list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    global._proxyPoolsCache.data = list;
    global._proxyPoolsCache.ts = now;
  }

  let result = global._proxyPoolsCache.data;
  if (filter.isActive !== undefined) {
    const activeFlag = filter.isActive;
    result = result.filter(p => p.isActive === activeFlag);
  }
  if (filter.testStatus) {
    result = result.filter(p => p.testStatus === filter.testStatus);
  }
  return JSON.parse(JSON.stringify(result));
}

export async function getProxyPoolById(id) {
  const pools = await getProxyPools();
  return pools.find(p => p.id === id) || null;
}

export async function createProxyPool(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, pool);
  invalidateProxyPoolsCache();
  return pool;
}

export async function updateProxyPool(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToPool(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  if (result) invalidateProxyPoolsCache();
  return result;
}

export async function deleteProxyPool(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToPool(row);
    db.run(`DELETE FROM proxyPools WHERE id = ?`, [id]);
  });
  if (removed) invalidateProxyPoolsCache();
  return removed;
}
