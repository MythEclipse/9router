/**
 * Turning a use-case's own refusal into an `AppError`.
 *
 * Several OAuth use-cases answer `{ ok: false, status, error }` rather than throwing: the
 * status is the provider's, not ours (a 409 when a Kiro key is already stored, a 404 when
 * no Perch session exists, a 502 when the upstream is unreachable). Those numbers cannot be
 * expressed as an `AppErrorCode`, so they travel on `AppError.status` and `toORPCError`
 * lets them win over the code's default.
 *
 * The `error` string is the caller's message and is carried verbatim. Replacing it with a
 * generic one here would undo the reason these use-cases return a status at all — the panel
 * shows the operator what the provider said.
 */
import { AppError, type AppErrorCode } from "../../domain/errors.ts"

/** What every refusal in this area looks like, however it is spelled. */
export interface Refusal {
	readonly ok: boolean
	readonly status?: number
	readonly error?: string
}

/** Which `AppErrorCode` describes a status, for the cases where nothing better is known. */
function codeForStatus(status: number): AppErrorCode {
	if (status === 401) return "UNAUTHORIZED"
	if (status === 403) return "FORBIDDEN"
	if (status === 404) return "NOT_FOUND"
	if (status === 409) return "CONFLICT"
	if (status === 413) return "PAYLOAD_TOO_LARGE"
	if (status >= 400 && status < 500) return "VALIDATION"
	return "UPSTREAM"
}

/**
 * Throw the refusal, or return the answer.
 *
 * Only `ok: false` with a status at or above 400 is a transport-level refusal. Several of
 * these use-cases answer `ok: false` with a 200 on purpose — a backup that failed to send
 * is reported inline by the screen, and turning that into an HTTP error would replace the
 * provider's message with a generic one.
 */
export function orRefuse<T extends Refusal>(answer: T): T {
	if (answer.ok || (answer.status ?? 200) < 400) return answer
	throw new AppError(codeForStatus(answer.status ?? 500), answer.error ?? "Request refused", {
		status: answer.status ?? 500,
	})
}
