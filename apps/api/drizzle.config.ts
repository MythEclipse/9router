import { defineConfig } from "drizzle-kit"

/**
 * Migration generation only. Migrations are source-controlled SQL run by
 * `src/infrastructure/db/migrate.ts`; `drizzle-kit push` is a dev convenience
 * and is never part of a release, so production schema changes always go
 * through a committed file.
 */
export default defineConfig({
	dialect: "sqlite",
	schema: "./src/infrastructure/db/schema.ts",
	out: "./migrations",
})
