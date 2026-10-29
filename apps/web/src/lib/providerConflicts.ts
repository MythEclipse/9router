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
 */

export interface NameConflictDetails {
	readonly code: "PROVIDER_NAME_CONFLICT"
	readonly message: string
	readonly existingId?: string
	readonly existingName?: string
}

export function isNameConflict(error: unknown): error is NameConflictDetails {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "PROVIDER_NAME_CONFLICT"
	)
}

/** The 409 body the dashboard reads to offer "open the existing connection". */
export function nameConflictBody(error: NameConflictDetails): Record<string, unknown> {
	return {
		error: error.message,
		code: error.code,
		existingId: error.existingId,
		existingName: error.existingName,
	}
}
