// CJS reader for MITM standalone process. Reads mitmAlias from JSON cache
// at $DATA_DIR/mitm/aliases.json (synced by app from SQLite on startup + writes).
// JSON-only: no SQLite native binding required in MITM bundle.
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

const CACHE_FILE = path.join(DATA_DIR, "mitm", "aliases.json");

let memoryCache = null;
let lastMtime = 0;
let lastCheckTime = 0;
const STAT_TTL_MS = 1000;

function readCache() {
  const now = Date.now();
  if (now - lastCheckTime < STAT_TTL_MS) {
    return memoryCache;
  }
  lastCheckTime = now;

  try {
    const stat = fs.statSync(CACHE_FILE);
    if (stat.mtimeMs > lastMtime || memoryCache === null) {
      const raw = fs.readFileSync(CACHE_FILE, "utf-8");
      memoryCache = JSON.parse(raw);
      lastMtime = stat.mtimeMs;
    }
  } catch (e) {
    if (e.code === "ENOENT") {
      memoryCache = null;
      lastMtime = 0;
    }
    // On parse errors (e.g. transient corrupted state during atomic replace), 
    // we simply retain the last known good memoryCache.
  }
  
  return memoryCache;
}

function getMitmAlias(toolName) {
  const all = readCache();
  return all?.[toolName] || null;
}

module.exports = { getMitmAlias };
