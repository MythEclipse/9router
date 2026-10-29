/**
 * Name-collision reporting, shared by the connection routes.
 *
 * The store refuses a duplicate name with `PROVIDER_NAME_CONFLICT` and carries the
 * id and name of the row that holds it. The dashboard needs both: it offers to
 * "edit the existing one instead", which it cannot do without the id.
 *
 * An API error, by contrast, is a typed `AppError` — a plain Error with a code
 * and a message. `isNameConflict` has to tell them apart, because only the store's
 * shape carries `existingId`.
 *
 * Two shapes reach this function, and both must work:
 *
 *   - the store's raw error, when a use-case calls the repository in-process;
 *   - an `ORPCError` with `code: "CONFLICT"` and `data: { existingId, existingName }`,
 *     when the same use-case runs behind the oRPC transport. The use-case translates the
 *     store's error into `conflict(...)` precisely so the transport does not flatten it
 *     into a generic INTERNAL, and this is the reading half of that agreement.
 */
export interface NameConflictDetails {
	readonly code: "PROVIDER_NAME_CONFLICT"
	readonly message: string
	readonly existingId?: string
	readonly existingName?: string
}

function detailsOf(error: unknown): Record<string, unknown> | undefined {
	if (typeof error !== "object" || error === null) return undefined
	const data = (error as { data?: unknown }).data
	return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined
}

export function isNameConflict(error: unknown): error is NameConflictDetails {
	if (typeof error !== "object" || error === null) return false
	const code = (error as { code?: unknown }).code
	if (code === "PROVIDER_NAME_CONFLICT") return true
	// The transport's form: CONFLICT carrying the two facts the dashboard needs.
	return code === "CONFLICT" && typeof detailsOf(error)?.existingId === "string"
}

/** The 409 body the dashboard reads to offer "open the existing connection". */
export function nameConflictBody(error: NameConflictDetails): Record<string, unknown> {
	const data = detailsOf(error)
	const existingId = error.existingId ?? (data?.existingId as string | undefined)
	const existingName = error.existingName ?? (data?.existingName as string | undefined)
	return {
		error: error.message,
		code: "PROVIDER_NAME_CONFLICT",
		existingId,
		existingName,
	}
}
