import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

if (!global._aliasCache) global._aliasCache = { data: null, ts: 0 };
const CACHE_TTL_MS = 15000;

function invalidateAliasCache() {
  global._aliasCache = { data: null, ts: 0 };
}

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  const now = Date.now();
  if (global._aliasCache.data && now - global._aliasCache.ts < CACHE_TTL_MS) {
    return global._aliasCache.data;
  }
  const data = await aliasKv.getAll();
  global._aliasCache = { data, ts: now };
  return data;
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
  invalidateAliasCache();
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
  invalidateAliasCache();
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic check-then-insert inside transaction to prevent duplicate races
export async function addCustomModel({ providerAlias, id, type = "llm", name }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT 1 FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) return;
    const value = stringifyJson({ providerAlias, id, type, name: name || id });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
