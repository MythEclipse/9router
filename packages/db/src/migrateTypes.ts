/**
 * Migration error type and legacy-blob type.
 *
 * Extracted verbatim from migrate.ts.
 */

// Thrown when row-count assertion fails. Outer transaction rolls back,
// legacy db.json kept intact, marker not written → next boot retries.
export class MigrationAborted extends Error {
	/** Rows that failed to insert - surfaced so the caller can report them. */
	droppedRows: unknown[]

	constructor(message: string, droppedRows: unknown[] = []) {
		super(message)
		this.name = "MigrationAborted"
		this.droppedRows = droppedRows
	}
}

/** Legacy export blob: arrays of rows under arbitrary top-level keys. */
export type LegacyBlob = Record<string, unknown>
