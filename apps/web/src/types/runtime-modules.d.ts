/**
 * Ambient declarations for runtime modules that have no shipped types.
 *
 * `bun:sqlite` is a Bun built-in: it only exists when the app runs under Bun,
 * so it can never be installed as a dependency and there is nothing to import
 * types from. Declaring the slice of the API the adapter actually uses keeps
 * `tsc` honest on Node without pulling in a Bun type package for every build.
 *
 * This file must stay free of imports/exports so it is treated as a global
 * script rather than a module - otherwise `declare module` would only apply
 * to importers of this file.
 */

declare module "bun:sqlite" {
	export interface BunStatement {
		all(...params: unknown[]): unknown[]
		get(...params: unknown[]): unknown
		run(...params: unknown[]): unknown
		values(...params: unknown[]): unknown[][]
		finalize(): void
	}

	export class Database {
		constructor(
			filename?: string,
			options?: { create?: boolean; readwrite?: boolean; readonly?: boolean },
		)
		prepare(sql: string): BunStatement
		query(sql: string): BunStatement
		exec(sql: string): void
		run(sql: string, ...params: unknown[]): unknown
		close(): void
		transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T
	}

	export default Database
}
