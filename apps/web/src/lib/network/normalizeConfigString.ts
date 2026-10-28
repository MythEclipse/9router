/**
 * String normalization for request and proxy config fields.
 *
 * Four copies of this exact function lived in the proxy stack (outboundProxy,
 * connectionProxy, proxyTest, proxyFetch). It is not `String(value).trim()` by
 * accident: `null` must become `""` rather than `"null"`, which is the bug that
 * makes an unset proxy host look configured.
 */

/**
 * Trim a config value to a string, mapping null and undefined to "".
 *
 * Numbers and booleans stringify (`0` → `"0"`), which is what a stored port or flag
 * needs. Two similar-looking helpers elsewhere in the codebase are deliberately
 * *not* this: one only accepts real strings, the other lower-cases and returns null
 * for blanks.
 */
export function normalizeConfigString(value: unknown): string {
	if (value === undefined || value === null) return ""
	return String(value).trim()
}
