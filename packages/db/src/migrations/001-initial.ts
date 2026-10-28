// Initial schema bootstrap. For fresh DB this creates all tables/indexes.
// For existing DB at version 0 (legacy unstamped), it's idempotent (IF NOT EXISTS).
import { buildCreateTableSql, TABLES } from "../schema.ts"
import type { DbAdapter } from "../types.ts"
import type { Migration } from "./index.ts"

const migration: Migration = {
	version: 1,
	name: "initial",
	up(db: DbAdapter) {
		for (const [name, def] of Object.entries(TABLES)) {
			db.exec(buildCreateTableSql(name, def))
			for (const idx of def.indexes || []) db.exec(idx)
		}
	},
}

export default migration
