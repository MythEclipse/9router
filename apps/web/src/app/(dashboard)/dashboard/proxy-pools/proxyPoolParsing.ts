/**
 * Proxy pool parsing and display rules.
 *
 * The batch importer accepts two line formats and had no test, which matters because
 * a mis-parsed credential line silently produces a pool that authenticates nowhere.
 */

export interface ParsedProxyLine {
	proxyUrl: string
	name: string
}

/**
 * Parse one pasted proxy line.
 *
 * Two shapes are accepted:
 *   - a full URL (`http://user:pass@host:8080`), kept as written, and
 *   - a bare `host:port:user:pass`, credentials percent-encoded into a URL.
 *
 * Returns null for a blank line so callers can skip it. Throws with a message meant
 * for the operator when the shape is wrong — the import reports the offending line
 * number, so the text has to make sense on its own.
 */
export function parseProxyLine(line: string): ParsedProxyLine | null {
	const trimmed = (line || "").trim()
	if (!trimmed) return null

	if (trimmed.includes("://")) {
		const parsed = new URL(trimmed)
		const hostLabel = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
		return { proxyUrl: parsed.toString(), name: `Imported ${hostLabel}` }
	}

	const parts = trimmed.split(":")
	if (parts.length === 4) {
		const [host, port, username, password] = parts
		if (!host || !port || !username || !password) {
			throw new Error("Invalid host:port:user:pass format")
		}
		const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`
		const parsed = new URL(proxyUrl)
		return { proxyUrl: parsed.toString(), name: `Imported ${host}:${port}` }
	}

	throw new Error("Unsupported format")
}

/** Split pasted text into non-empty, trimmed lines. */
export function splitImportLines(text: string): string[] {
	return (text || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
}

export interface ParsedImport {
	entries: Array<ParsedProxyLine & { lineNumber: number }>
	errors: string[]
}

/**
 * Parse a whole paste.
 *
 * Every bad line is reported, not just the first: an operator fixing a thousand-line
 * paste should not discover the problems one round trip at a time. Line numbers refer
 * to the pasted text, so a blank line in the middle does not shift them.
 */
export function parseProxyImport(text: string): ParsedImport {
	const entries: ParsedImport["entries"] = []
	const errors: string[] = []

	;(text || "").split(/\r?\n/).forEach((rawLine, index) => {
		const line = rawLine.trim()
		if (!line) return
		try {
			const parsed = parseProxyLine(line)
			if (parsed) entries.push({ ...parsed, lineNumber: index + 1 })
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			errors.push(`Line ${index + 1}: ${message}`)
		}
	})

	return { entries, errors }
}

/** The badge variant for a pool's status. */
export function getStatusVariant(
	status: string | null | undefined,
): "success" | "error" | "default" {
	if (status === "active") return "success"
	if (status === "error") return "error"
	return "default"
}

/**
 * A human timestamp, or "Never".
 *
 * "Never" covers both a missing value and an unparseable one: a pool that has never
 * been exercised reads the same either way, and `Invalid Date` on screen helps nobody.
 */
export function formatDateTime(value: string | number | Date | null | undefined): string {
	if (!value) return "Never"
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return "Never"
	return date.toLocaleString()
}

export interface ProxyPoolFormData {
	name: string
	proxyUrl: string
	noProxy: string
	isActive: boolean
	strictProxy: boolean
}

/**
 * Fill a form from a stored pool.
 *
 * The two booleans default in opposite directions on purpose: a new pool is active
 * but not strict, so it starts serving without exempting anything.
 */
export function normalizeFormData(
	data: {
		name?: string
		proxyUrl?: string
		noProxy?: string
		isActive?: boolean
		strictProxy?: boolean
	} = {},
): ProxyPoolFormData {
	return {
		name: data.name || "",
		proxyUrl: data.proxyUrl || "",
		noProxy: data.noProxy || "",
		isActive: data.isActive !== false,
		strictProxy: data.strictProxy === true,
	}
}
