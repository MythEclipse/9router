/**
 * sql.js ships no type declarations, and installing `@types/sql.js` only for
 * the last-resort fallback driver is not worth a dependency. This declares the
 * subset `adapters/sqljsAdapter.ts` uses, mirroring sql.js 1.15 — see
 * https://github.com/sql-js/sql.js/blob/master/README.md for the runtime shape.
 */
declare module "sql.js" {
	/** One bind value as sql.js accepts it. */
	export type SqlJsValue = number | string | Uint8Array | null

	export interface Statement {
		bind(values?: SqlJsValue[]): boolean
		step(): boolean
		getAsObject(): Record<string, SqlJsValue>
		free(): boolean
	}

	export interface QueryExecResult {
		columns: string[]
		values: SqlJsValue[][]
	}

	export class Database {
		constructor(data?: ArrayLike<number> | Buffer | null)
		prepare(sql: string): Statement
		run(sql: string, params?: SqlJsValue[]): void
		exec(sql: string): QueryExecResult[]
		getRowsModified(): number
		close(): void
		export(): Uint8Array
	}

	export interface SqlJsStatic {
		Database: typeof Database
	}

	/** Loads the wasm module; resolves once the runtime is ready to open a database. */
	export default function initSqlJs(config?: {
		locateFile?: (file: string) => string
	}): Promise<SqlJsStatic>
}
