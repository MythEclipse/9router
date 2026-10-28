/**
 * Group console-log lines by the provider (and model) that produced them.
 *
 * Every request-scoped line this app prints carries the same head:
 *   [HH:MM:SS] <icon> [TAG] PROVIDER | model | rest…
 * (see src/sse/utils/logger.ts and the PROXY/REQUEST/CHAT call sites). Parsing
 * that head lets the console show one tab per provider instead of one
 * undifferentiated wall of text.
 *
 * Lines that do not match — startup banners, stack traces, framework noise —
 * are kept, never dropped, under the "system" group. A log viewer that hides
 * lines is worse than one that shows them in the wrong bucket.
 */

/** Separator between provider and model in a request line. */
const FIELD_SEPARATOR = "|"

/** `[12:34:56]` prefix printed by every logger helper. */
const TIMESTAMP_RE = /^\[(\d{2}:\d{2}:\d{2})\]\s*/

/** Trailing `[TAG]` marker such as `[PROXY]`, `[AUTH]`, `[CHAT]`. */
const TAG_RE = /^\[([A-Z][A-Z0-9_]*)\]\s*/

/** Leading status glyph the logger prepends (`ℹ️`, `⚠️`, `❌`, `🟣`, …). */
const ICON_RE = /^[\p{Extended_Pictographic}\uFE0F\u200D]+\s*/u

export const SYSTEM_GROUP_ID = "system"
export const SYSTEM_GROUP_LABEL = "System"

/**
 * Stable bucket key for a parsed line. Shared by the grouper and by the UI's
 * filter, so a chip can never point at a key the filter does not produce.
 */
export function groupIdFor(parsed: Pick<ParsedLogLine, "provider" | "model">): string {
	if (!parsed.provider) return SYSTEM_GROUP_ID
	return parsed.model ? `${parsed.provider}::${parsed.model}` : parsed.provider
}

export interface ParsedLogLine {
	/** Raw text, unmodified. */
	text: string
	/** `HH:MM:SS` when present. */
	time: string | null
	/** Logger tag (`PROXY`, `AUTH`, …) when present. */
	tag: string | null
	/** Normalized provider id, or null for non-request lines. */
	provider: string | null
	/** Model name as printed, or null. */
	model: string | null
	/** Severity inferred from the line. */
	level: LogLevel
}

export type LogLevel = "error" | "warn" | "info" | "success" | "debug" | "plain"

export interface LogGroup {
	id: string
	/** Human label: provider display name, or "System". */
	label: string
	provider: string | null
	model: string | null
	lines: ParsedLogLine[]
	/** Highest severity present, so a tab can flag itself. */
	level: LogLevel
	/** Count per severity, for the tab summary. */
	counts: Record<LogLevel, number>
}

const LEVEL_RANK: Record<LogLevel, number> = {
	error: 5,
	warn: 4,
	success: 3,
	info: 2,
	debug: 1,
	plain: 0,
}

const EMPTY_COUNTS = (): Record<LogLevel, number> => ({
	error: 0,
	warn: 0,
	success: 0,
	info: 0,
	debug: 0,
	plain: 0,
})

/**
 * Severity is decided by the glyph and tag the logger already chose, plus the
 * bare-text markers older call sites print.
 */
export function detectLevel(line: string): LogLevel {
	if (line.includes("❌") || line.includes("[ERROR]") || line.includes("✗")) return "error"
	if (line.includes("⚠️") || line.includes("[WARN]")) return "warn"
	if (line.includes("✓") || line.includes("[SUCCESS]")) return "success"
	if (line.includes("🔍") || line.includes("[DEBUG]")) return "debug"
	if (
		line.includes("ℹ️") ||
		line.includes("📥") ||
		line.includes("📤") ||
		line.includes("🌊") ||
		line.includes("[INFO]")
	)
		return "info"
	return "plain"
}

/** Normalize a provider token so `OPENCODE`, `OpenCode` and `opencode` agree. */
export function normalizeProviderId(raw: string): string {
	return raw.trim().toLowerCase()
}

/**
 * The logger uses two head shapes, and both must resolve to the same group:
 *
 *   [PROXY] OPENCODE | model | conn=…        (upper-case, pipe separated)
 *   ✗ ERROR 429 · opencode/model · 2133ms    (lower-case, slash separated)
 *
 * The slash form also appears mid-sentence ("fallback for provider/model"), so
 * it is matched as a standalone token rather than assumed to start the line.
 *
 * A model id never ends in a file extension and never starts with a slash, which
 * is what keeps stack frames like `(/app/x.js:1:1)` out of the provider buckets.
 */
const MODEL_TOKEN = String.raw`([A-Za-z0-9][A-Za-z0-9._:-]*[A-Za-z0-9])`
const SLASH_HEAD_RE = new RegExp(
	String.raw`(?:^|[^/\w])([a-z][a-z0-9_-]*)/${MODEL_TOKEN}(?=$|[^\w/.:-])`,
)
const STACK_FRAME_RE = /^\s*at\s|\/[\w.-]+\.(?:js|ts|mjs|cjs|jsx|tsx)(?::\d+)+/

function splitHead(body: string): { provider: string; model: string | null; rest: string } | null {
	const parts = body.split(FIELD_SEPARATOR)
	if (parts.length >= 2) {
		const provider = parts[0].trim()
		const model = parts[1].trim()
		// A provider token never contains spaces ("OpenCode Free" is a display name,
		// not the id this column carries), so a space here means this is prose.
		if (provider && !provider.includes(" ") && model) {
			return { provider, model, rest: parts.slice(2).join(FIELD_SEPARATOR).trim() }
		}
	}

	const slash = STACK_FRAME_RE.test(body) ? null : body.match(SLASH_HEAD_RE)
	if (slash) {
		return { provider: slash[1], model: slash[2], rest: body }
	}

	return null
}

export function parseLogLine(text: string): ParsedLogLine {
	const level = detectLevel(text)
	let rest = text

	const timeMatch = rest.match(TIMESTAMP_RE)
	const time = timeMatch ? timeMatch[1] : null
	if (timeMatch) rest = rest.slice(timeMatch[0].length)

	rest = rest.replace(ICON_RE, "")

	const tagMatch = rest.match(TAG_RE)
	const tag = tagMatch ? tagMatch[1] : null
	if (tagMatch) rest = rest.slice(tagMatch[0].length)

	const head = splitHead(rest)
	if (!head) return { text, time, tag, provider: null, model: null, level }

	return {
		text,
		time,
		tag,
		provider: normalizeProviderId(head.provider),
		model: head.model,
		level,
	}
}

/** Prefer the provider's display name when the caller supplies one. */
function labelFor(provider: string, displayNames?: Record<string, string>): string {
	return displayNames?.[provider] || provider
}

/**
 * Bucket parsed lines by provider+model.
 *
 * Grouping per model (not just per provider) is deliberate: one provider can
 * serve several models whose failures look nothing alike, and the question
 * being asked of this page is usually "what did *this model* do".
 */
export function groupLogs(
	lines: readonly string[],
	displayNames?: Record<string, string>,
): LogGroup[] {
	const byId = new Map<string, LogGroup>()

	for (const text of lines) {
		const parsed = parseLogLine(text)
		const id = groupIdFor(parsed)

		let group = byId.get(id)
		if (!group) {
			group = {
				id,
				label: parsed.provider
					? `${labelFor(parsed.provider, displayNames)}${parsed.model ? ` · ${parsed.model}` : ""}`
					: SYSTEM_GROUP_LABEL,
				provider: parsed.provider,
				model: parsed.model,
				lines: [],
				level: "plain",
				counts: EMPTY_COUNTS(),
			}
			byId.set(id, group)
		}

		group.lines.push(parsed)
		group.counts[parsed.level] += 1
		if (LEVEL_RANK[parsed.level] > LEVEL_RANK[group.level]) group.level = parsed.level
	}

	return [...byId.values()].sort(compareGroups)
}

/**
 * Request groups first (they are what the page is for), then System. Within a
 * provider, the noisiest group first so a failing model is never buried.
 */
function compareGroups(a: LogGroup, b: LogGroup): number {
	if (a.id === SYSTEM_GROUP_ID) return 1
	if (b.id === SYSTEM_GROUP_ID) return -1
	if (b.lines.length !== a.lines.length) return b.lines.length - a.lines.length
	return a.label.localeCompare(b.label)
}

/** Total lines across every group, for the header count. */
export function countLines(groups: readonly LogGroup[]): number {
	return groups.reduce((sum, group) => sum + group.lines.length, 0)
}
