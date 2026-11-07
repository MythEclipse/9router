/**
 * The shape `handleChatCore` hands back: a ready `Response` on the success arm,
 * or the status/error details the account-fallback loop rotates on.
 *
 * Kept as a local type rather than imported from open-sse because the route
 * layer only relies on this two-arm contract.
 */
export interface ChatCoreSuccess {
	success: true
	response: Response
}

/** The failure arm of a chatCore result: status/error/resetsAtMs plus the Response. */
export interface ChatCoreFailure {
	success: false
	status: number
	error: string
	resetsAtMs?: number | null
	response: Response
}

export type ChatCoreResult = ChatCoreSuccess | ChatCoreFailure
