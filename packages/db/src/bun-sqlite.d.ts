/**
 * Minimal `bun:sqlite` declaration.
 *
 * The adapter types nothing from this module — it calls `exec`, `prepare`,
 * `transaction` and `close` on an `any` handle — but TypeScript still has to
 * resolve the module specifier. Declaring just that shape here keeps
 * `@types/bun` out of every consumer of this package: pulling the full Bun
 * typings in redefines `fetch`, which once turned `cache: "no-store"` into a
 * type error in code that never runs on Node.
 *
 * Only what this package and its consumers actually touch is declared.
 */
declare module "bun:sqlite" {
	export interface BunStatement {
		run(...params: unknown[]): { changes?: number; lastInsertRowid?: number }
		get(...params: unknown[]): unknown
		all(...params: unknown[]): unknown[]
	}

	export class Database {
		constructor(filename: string, options?: { create?: boolean; readwrite?: boolean })
		exec(sql: string): void
		prepare(sql: string): BunStatement
		/** Prepare and return a statement in one step; used by the API migrator. */
		query(sql: string): BunStatement
		transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R
		close(): void
	}
}
