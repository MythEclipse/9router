import type { DbAdapter } from "../types.ts"
import type { Migration } from "./index.ts"

const migration: Migration = {
	version: 2,
	name: "drop budget groups",
	up(db: DbAdapter) {
		try {
			db.exec("DROP TABLE IF EXISTS budgetGroups")
		} catch {}
		// budgetGroupId column left in apiKeys - harmless, additive sync won't recreate it
	},
}

export default migration
