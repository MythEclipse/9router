/**
 * Turning provider image payloads into something an `<img src>` accepts.
 *
 * A media provider answers with one of three things in the image field: a full URL,
 * an already-formed `data:` URL, or bare base64 bytes. Only the third needs work, and
 * getting it wrong shows a broken image rather than an error — so the decision lives
 * here, stated once, instead of being re-derived at each render site.
 */

const DATA_URL_PREFIX = /^(data:|https?:\/\/|blob:)/i

/**
 * A value that can be handed to `<img src>` directly.
 *
 * Bare base64 gets the PNG prefix. That assumes a PNG, which is what the providers
 * that return bare bytes emit; an `image/jpeg` payload would render blank, which is
 * why a provider that can return another format should send a full data URL instead
 * of bare bytes.
 *
 * A blank or non-string value returns "" — an empty src lets the browser request the
 * current page as an image, so callers can test the result for truthiness.
 */
export function toImagePreviewSrc(value: unknown): string {
	const trimmed = typeof value === "string" ? value.trim() : ""
	if (!trimmed) return ""
	if (DATA_URL_PREFIX.test(trimmed)) return trimmed
	return `data:image/png;base64,${trimmed}`
}

/**
 * The same conversion, for a payload that is already known to be base64.
 *
 * Used where a response field is typed as `b64_json`, so an unexpected URL is not
 * possible and the only question is whether the bytes are there at all.
 */
export function base64PngDataUrl(b64: unknown): string {
	const trimmed = typeof b64 === "string" ? b64.trim() : ""
	if (!trimmed) return ""
	return `data:image/png;base64,${trimmed}`
}
