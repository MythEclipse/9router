import type { DbAdapter } from "../types.ts"
import type { Migration } from "./index.ts"

/** The subset of a `PRAGMA table_info(…)` row this migration reads. */
interface TableColumnInfo {
	name: string
}

const migration: Migration = {
	version: 5,
	name: "api key endpoint allowlist",
	up(db: DbAdapter) {
		const columns = db.all<{ name: string }>("PRAGMA table_info(apiKeys)")
		if (!columns.some((column) => column.name === "allowedEndpoints")) {
			db.exec("ALTER TABLE apiKeys ADD COLUMN allowedEndpoints TEXT NOT NULL DEFAULT '[]'")
		}
	},
}

export default migration
