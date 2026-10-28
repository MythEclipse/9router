/**
 * JSON column helpers.
 *
 * Generic on purpose: a JSON column has no shape until the caller says what it
 * expects. `parseJson<T>(str, fallback)` keeps that decision at the call site
 * instead of widening every parsed blob to `unknown` and forcing a cast at each
 * property access.
 */

/** Parse a JSON column; return `fallback` when the value is missing or invalid. */
export function parseJson<T>(str: unknown, fallback: T): T
/** Parse a JSON column whose expected shape the caller declares. */
export function parseJson<T>(str: unknown): T | null
/** Parse a JSON column with no declared shape - the caller narrows the result. */
export function parseJson(str: unknown): unknown
export function parseJson<T>(str: unknown, fallback?: T): T | undefined {
	if (str == null) return fallback
	if (typeof str !== "string") return str as T
	try {
		return JSON.parse(str) as T
	} catch {
		return fallback
	}
}

/** Serialize a value for a JSON column (`null` instead of `undefined`). */
export function stringifyJson(value: unknown): string {
	return JSON.stringify(value ?? null)
}
