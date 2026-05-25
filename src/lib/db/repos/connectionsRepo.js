import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// Connection cache (TTL: 15s)
if (!global._connectionsCache) global._connectionsCache = { data: null, ts: 0 };
const CACHE_TTL_MS = 15000;

function invalidateConnectionsCache() {
  global._connectionsCache = { data: null, ts: 0 };
}

// Background batch writer for connection usage updates (avoids blocking hot-path)
if (!global._connectionUsageState) {
  global._connectionUsageState = { buffer: new Map(), timer: null, flushing: false };
}
const USAGE_FLUSH_MS = 1000;

function _flushConnectionUsage() {
  const st = global._connectionUsageState;
  if (st.flushing || st.buffer.size === 0) return;
  st.flushing = true;
  
  const entries = Array.from(st.buffer.entries());
  st.buffer.clear();
  st.timer = null;

  getAdapter()
    .then((db) => {
      db.transaction(() => {
        for (const [id, updates] of entries) {
          const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
          if (!row) continue;
          
          const existing = rowToConn(row);
          const merged = { ...existing, ...updates, updatedAt: updates.updatedAt || new Date().toISOString() };
          
          const r = connToRow(merged);
          db.run(
            `UPDATE providerConnections SET provider=?, authType=?, name=?, email=?, priority=?, isActive=?, data=?, updatedAt=? WHERE id=?`,
            [r.provider, r.authType, r.name, r.email, r.priority, r.isActive, r.data, r.updatedAt, id]
          );
        }
      });
    })
    .catch((err) => console.error("[connectionsRepo] usage batch write failed:", err.message))
    .finally(() => { st.flushing = false; });
}

export function updateProviderConnectionUsage(id, data) {
  // Synchronously update cache for instant round-robin resolution
  if (global._connectionsCache.data) {
    const idx = global._connectionsCache.data.findIndex((c) => c.id === id);
    if (idx !== -1) {
      global._connectionsCache.data[idx] = { ...global._connectionsCache.data[idx], ...data, updatedAt: new Date().toISOString() };
    }
  }

  // Push to async batch writer
  const st = global._connectionUsageState;
  const current = st.buffer.get(id) || {};
  st.buffer.set(id, { ...current, ...data });

  if (!st.timer) {
    st.timer = setTimeout(() => {
      st.timer = null;
      _flushConnectionUsage();
    }, USAGE_FLUSH_MS);
  }
}

const OPTIONAL_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount",
];

function rowToConn(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, c) {
  const r = connToRow(c);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.provider, r.authType, r.name, r.email, r.priority, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProviderConnections(filter = {}) {
  const now = Date.now();
  if (!global._connectionsCache.data || now - global._connectionsCache.ts >= CACHE_TTL_MS) {
    const db = await getAdapter();
    const rows = db.all(`SELECT * FROM providerConnections`);
    const list = rows.map(rowToConn);
    list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
    global._connectionsCache.data = list;
    global._connectionsCache.ts = now;
  }

  // Filter against cached array
  let result = global._connectionsCache.data;
  if (filter.provider) {
    result = result.filter(c => c.provider === filter.provider);
  }
  if (filter.isActive !== undefined) {
    const activeFlag = filter.isActive;
    result = result.filter(c => c.isActive === activeFlag);
  }

  // Deep clone to prevent accidental mutations by callers
  return JSON.parse(JSON.stringify(result));
}

export async function getProviderConnectionById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
  return rowToConn(row);
}

// Internal sync reorder — must be called INSIDE a transaction
function reorderInTx(db, providerId) {
  const list = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]).map(rowToConn);
  list.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  list.forEach((c, i) => {
    db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [i + 1, c.id]);
  });
}

export async function createProviderConnection(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let result;

  db.transaction(() => {
    const all = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);

    let existing = null;
    if (data.authType === "oauth" && data.email) {
      const incomingWs = data.providerSpecificData?.chatgptAccountId;
      existing = all.find(c => {
        if (c.authType !== "oauth" || c.email !== data.email) return false;
        // If both sides have a workspace ID, they must match for dedup
        const existingWs = c.providerSpecificData?.chatgptAccountId;
        if (incomingWs && existingWs) return incomingWs === existingWs;
        return true; // fallback: email-only match for non-workspace providers
      });
    } else if (data.authType === "apikey" && data.name) {
      existing = all.find(c => c.authType === "apikey" && c.name === data.name);
    }
    // access_token: never dedup — user manages duplicates manually

    if (existing) {
      const merged = { ...existing, ...data, updatedAt: now };
      upsert(db, merged);
      result = merged;
      return;
    }

    let connectionName = data.name || null;
    if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
      connectionName = data.email || `Account ${all.length + 1}`;
    }
    let connectionPriority = data.priority;
    if (!connectionPriority) {
      connectionPriority = all.reduce((m, c) => Math.max(m, c.priority || 0), 0) + 1;
    }

    const conn = {
      id: uuidv4(),
      provider: data.provider,
      authType: data.authType || "oauth",
      name: connectionName,
      priority: connectionPriority,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };
    for (const f of OPTIONAL_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      conn.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) conn.email = data.email;

    upsert(db, conn);
    reorderInTx(db, data.provider);
    result = conn;
  });

  if (result) invalidateConnectionsCache();
  return result;
}

// Critical: OAuth refresh token race — atomic merge inside transaction
export async function updateProviderConnection(id, data) {
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) { result = null; return; }
    const existing = rowToConn(row);
    const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    if (data.priority !== undefined) reorderInTx(db, existing.provider);
    result = merged;
  });
  if (result) invalidateConnectionsCache();
  return result;
}

export async function deleteProviderConnection(id) {
  const db = await getAdapter();
  let ok = false;
  db.transaction(() => {
    const row = db.get(`SELECT provider FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
    reorderInTx(db, row.provider);
    ok = true;
  });
  if (ok) invalidateConnectionsCache();
  return ok;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getAdapter();
  const before = db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [providerId]);
  db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId]);
  invalidateConnectionsCache();
  return before?.n || 0;
}

export async function reorderProviderConnections(providerId) {
  const db = await getAdapter();
  db.transaction(() => reorderInTx(db, providerId));
  invalidateConnectionsCache();
}

export async function cleanupProviderConnections() {
  const db = await getAdapter();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM providerConnections`);
    for (const row of rows) {
      const conn = rowToConn(row);
      let dirty = false;
      for (const f of fieldsToCheck) {
        if (conn[f] === null || conn[f] === undefined) {
          if (f in conn) { delete conn[f]; cleaned++; dirty = true; }
        }
      }
      if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
        delete conn.providerSpecificData;
        cleaned++;
        dirty = true;
      }
      if (dirty) upsert(db, conn);
    }
  });
  if (cleaned > 0) invalidateConnectionsCache();
  return cleaned;
}
