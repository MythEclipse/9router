/**
 * CSV for the usage export.
 *
 * The handler already quoted its cells, so a comma or a quote was safe. Two
 * things it did not handle:
 *
 *  - The header row was joined raw. The headers happen to be plain words today,
 *    which is why it has never broken; the moment one gains a comma the columns
 *    silently shift.
 *  - A cell beginning `=`, `+`, `-` or `@` is executed as a formula when the file
 *    is opened in a spreadsheet. Model and provider ids come from upstream
 *    catalogs and from connection names an operator types, so a value like
 *    `=HYPERLINK(...)` would arrive as a live formula in a report the operator
 *    downloaded from their own dashboard.
 *
 * Quoting alone does not prevent this: a spreadsheet unquotes the cell and then
 * evaluates it. The fix is to prefix a tab so the value is read as text.
 */

/** Cells a spreadsheet would evaluate as a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/

/**
 * One CSV cell, always quoted.
 *
 * Doubling the quotes is the RFC 4180 escape; the tab prefix defuses a formula
 * without changing the visible value in any meaningful way.
 */
export function csvCell(value: unknown): string {
	const text = value === null || value === undefined ? "" : String(value)
	const defused = FORMULA_LEAD.test(text) ? `\t${text}` : text
	return `"${defused.replace(/"/g, '""')}"`
}

/** A header row, escaped by the same rule as the data. */
export function csvHeader(columns: readonly string[]): string {
	return columns.map(csvCell).join(",")
}

/** One escaped row. */
export function csvRow(values: readonly unknown[]): string {
	return values.map(csvCell).join(",")
}

/** Header plus rows, newline-joined. */
export function csvDocument(
	columns: readonly string[],
	rows: readonly (readonly unknown[])[],
): string {
	return [csvHeader(columns), ...rows.map(csvRow)].join("\n")
}
