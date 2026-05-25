import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

if (!global._nodesCache) global._nodesCache = { data: null, ts: 0 };
const CACHE_TTL_MS = 15000;

function invalidateNodesCache() {
  global._nodesCache = { data: null, ts: 0 };
}

function rowToNode(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    type: row.type,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function nodeToRow(n) {
  const { id, type, name, createdAt, updatedAt, ...rest } = n;
  return {
    id,
    type: type ?? null,
    name: name ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, n) {
  const r = nodeToRow(n);
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.type, r.name, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProviderNodes(filter = {}) {
  const now = Date.now();
  if (!global._nodesCache.data || now - global._nodesCache.ts >= CACHE_TTL_MS) {
    const db = await getAdapter();
    const sql = `SELECT * FROM providerNodes`;
    global._nodesCache.data = db.all(sql).map(rowToNode);
    global._nodesCache.ts = now;
  }
  
  let nodes = global._nodesCache.data;
  if (filter.type) {
    nodes = nodes.filter(n => n.type === filter.type);
  }
  return nodes;
}

export async function getProviderNodeById(id) {
  const db = await getAdapter();
  return rowToNode(db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]));
}

export async function createProviderNode(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix,
    apiType: data.apiType,
    baseUrl: data.baseUrl,
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, node);
  invalidateNodesCache();
  return node;
}

export async function updateProviderNode(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToNode(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  if (result) invalidateNodesCache();
  return result;
}

export async function deleteProviderNode(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToNode(row);
    db.run(`DELETE FROM providerNodes WHERE id = ?`, [id]);
  });
  if (removed) invalidateNodesCache();
  return removed;
}
