import { getAdapter } from "../driver";
import { parseJson, stringifyJson } from "./jsonCol";

/** A scope-scoped key/value facade over the `kv` table. */
export interface KvStore {
  get<T>(key: string, fallback?: T): Promise<T | null>;
  getAll<T = unknown>(): Promise<Record<string, T>>;
  set(key: string, value: unknown): Promise<void>;
  setMany(obj: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

export function makeKv(scope: string): KvStore {
  return {
    async get<T>(key: string, fallback: T | null = null): Promise<T | null> {
      const db = await getAdapter();
      const row = db.get<{ value: string }>(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [scope, key]);
      return row ? parseJson<T>(row.value, fallback as T) : fallback;
    },
    async getAll<T = unknown>(): Promise<Record<string, T>> {
      const db = await getAdapter();
      const rows = db.all<{ key: string; value: string }>(`SELECT key, value FROM kv WHERE scope = ?`, [scope]);
      const out: Record<string, T> = {};
      for (const r of rows) out[r.key] = parseJson<T>(r.value);
      return out;
    },
    async set(key: string, value: unknown) {
      const db = await getAdapter();
      db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [scope, key, stringifyJson(value)]);
    },
    async setMany(obj: Record<string, unknown>) {
      const db = await getAdapter();
      db.transaction(() => {
        for (const [k, v] of Object.entries(obj)) {
          db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [scope, k, stringifyJson(v)]);
        }
      });
    },
    async remove(key) {
      const db = await getAdapter();
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [scope, key]);
    },
    async clear() {
      const db = await getAdapter();
      db.run(`DELETE FROM kv WHERE scope = ?`, [scope]);
    },
  };
}
