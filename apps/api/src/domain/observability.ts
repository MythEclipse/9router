/**
 * Paging and payload redaction for the observability tab.
 *
 * Two rules live here, and both exist because the naive version leaks or lies.
 *
 * **Paging.** `parseInt(searchParams.get("page"), 10)` answers `NaN`, and `NaN < 1`
 * is false, so a caller who mistyped `?page=abc` reached the store with `NaN`
 * and got an offset of `NaN` — an empty page that looks like "no requests".
 * A page size of 0 is worse: it is a valid-looking request for nothing.
 *
 * **Redaction.** The stored detail carries the whole client request body and the
 * provider response, so a listing that returns them turns the observability tab
 * into a conversation reader for every request through the gateway. Withholding
 * them is the default, but a bare `{redacted: true}` reads as "there was no
 * payload" and sends the operator hunting for a storage bug. So a withheld field
 * carries a marker that says it was withheld and how to see it.
 */

/** Rows per page when the caller names nothing. */
export const DEFAULT_PAGE_SIZE = 20

/** The ceiling, so one poll cannot pull the whole history. */
export const MAX_PAGE_SIZE = 100

/** The fields a detail row carries that contain conversation content. */
export const REQUEST_PAYLOAD_FIELDS = [
	"request",
	"providerRequest",
	"providerResponse",
	"response",
] as const

export type RequestPayloadField = (typeof REQUEST_PAYLOAD_FIELDS)[number]

export interface RequestDetailsPage {
	readonly page: number
	readonly pageSize: number
}

export type PageFailure = { readonly ok: false; readonly status: number; readonly error: string }
export type PageSuccess = { readonly ok: true; readonly page: RequestDetailsPage }
export type PageAnswer = PageSuccess | PageFailure

/**
 * Narrows a page answer to its failure branch.
 *
 * A predicate rather than `if (!answer.ok)` because `apps/web` compiles with
 * `strict: false`, where a discriminated union does not narrow through a boolean
 * discriminant — the same reason `isMitmFailure` exists.
 */
export function isPageFailure(answer: PageAnswer): answer is PageFailure {
	return !answer.ok
}

/**
 * Reads `?page=` and `?pageSize=` together.
 *
 * Out of range is refused rather than clamped, unlike `?limit=`, and the reason is
 * who the caller is: this endpoint is driven by the table's own pager, so a page of
 * `0` or a size of `101` means the pager sent something wrong. Silently moving it
 * to a legal page hides that and shows the operator the wrong rows. A non-numeric
 * value still falls back to the default instead of failing — that is a mistyped URL,
 * not a broken pager, and `NaN` must never reach the store as an offset.
 */
export function readRequestDetailsPage(input: {
	readonly page?: string | null
	readonly pageSize?: string | null
}): PageAnswer {
	const page = Number.parseInt(input.page ?? "", 10)
	const resolvedPage = Number.isNaN(page) ? 1 : page
	if (resolvedPage < 1) {
		return { ok: false, status: 400, error: "Page must be >= 1" }
	}

	const pageSize = Number.parseInt(input.pageSize ?? "", 10)
	const resolvedPageSize = Number.isNaN(pageSize) ? DEFAULT_PAGE_SIZE : pageSize
	if (resolvedPageSize < 1 || resolvedPageSize > MAX_PAGE_SIZE) {
		return { ok: false, status: 400, error: `PageSize must be between 1 and ${MAX_PAGE_SIZE}` }
	}

	const answer: PageSuccess = { ok: true, page: { page: resolvedPage, pageSize: resolvedPageSize } }
	return answer
}

/** The marker that replaces a withheld payload field. */
export interface WithheldPayload {
	readonly withheld: true
	readonly field: string
	/** Size of what was withheld, so the operator can see it exists and how big it is. */
	readonly bytes: number
	readonly hint: string
}

export const WITHHELD_PAYLOAD_HINT =
	"Payload hidden. Enable Settings → Observability → include payloads to view request/response bodies."

export interface RedactionSettings {
	readonly observabilityIncludePayloads?: unknown
	readonly requireLogin?: unknown
}

/**
 * The settings a redaction decision needs, read defensively.
 *
 * Kept separate from the decision so "the settings row was unreadable" is a value
 * rather than an exception caught somewhere in a route.
 */
export function redactionSettingsFrom(row: unknown): {
	readonly settings: RedactionSettings | null
	readonly requireLoginDisabled: boolean
} {
	if (row == null || typeof row !== "object") {
		return { settings: null, requireLoginDisabled: false }
	}
	const settings = row as RedactionSettings
	return { settings, requireLoginDisabled: settings.requireLogin === false }
}

/**
 * Whether this request may read conversation payloads.
 *
 * Two gates, and both must pass:
 *
 * 1. The operator turned `observabilityIncludePayloads` on. Off is the default
 *    because the payloads are other people's conversations.
 * 2. If the gateway runs with login disabled, that flag alone is not enough: every
 *    `/api/usage/*` path is then reachable by anyone who can hit the port, so the
 *    request must itself be authenticated. A flag the operator set while thinking
 *    of a logged-in dashboard must not become world-readable history.
 *
 * An unreadable settings row fails closed: a database error is not consent.
 */
export function shouldIncludePayloads(input: {
	readonly settings: RedactionSettings | null
	readonly requireLoginDisabled: boolean
	readonly requestAuthenticated: boolean
}): { readonly include: boolean; readonly reason: string } {
	if (input.settings?.observabilityIncludePayloads !== true) {
		return { include: false, reason: "disabled-by-setting" }
	}
	if (input.requireLoginDisabled && !input.requestAuthenticated) {
		return { include: false, reason: "unauthenticated-on-open-gateway" }
	}
	return { include: true, reason: "enabled" }
}

function withheldMarker(field: string, revealed: unknown): WithheldPayload {
	let bytes = 0
	if (revealed != null) {
		try {
			bytes = JSON.stringify(revealed).length
		} catch {
			// A circular payload cannot be sized; reporting 0 still beats letting the
			// marker itself throw and turning a listing into a 500.
			bytes = 0
		}
	}
	return { withheld: true, field, bytes, hint: WITHHELD_PAYLOAD_HINT }
}

/**
 * Replaces every payload field with its marker, leaving the row otherwise intact.
 *
 * The markers are per field and named, so a row where only `response` was stored
 * says so instead of implying four payloads are hidden. A field that was absent
 * stays absent: inventing a marker for something never recorded would report
 * storage that does not exist.
 */
export function redactRequestDetail(
	detail: Record<string, unknown>,
	includePayloads: boolean,
): Record<string, unknown> {
	if (includePayloads) return detail
	const redacted: Record<string, unknown> = { ...detail }
	for (const field of REQUEST_PAYLOAD_FIELDS) {
		if (redacted[field] !== undefined) {
			redacted[field] = withheldMarker(field, redacted[field])
		}
	}
	return redacted
}

/**
 * Whether a session may read one full request body.
 *
 * The listing redacts for everyone; this is the escape hatch for a single record,
 * and it is narrower on purpose. A password (admin) session may read it — that is
 * the administrator asking "what did this request actually send". A key session is
 * refused rather than shown a redacted body, because a redacted body is
 * indistinguishable from an empty one and only invites retries.
 */
export function canReadFullRequestPayload(role: string | null | undefined): boolean {
	return role === "admin"
}
