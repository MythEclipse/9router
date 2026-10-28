/**
 * Shared engine types for `open-sse/`.
 *
 * The engine was plain JavaScript; after the TypeScript migration every value
 * that crosses a module boundary (credentials, requests, loggers, executor
 * results) needs one canonical shape. Declaring them here keeps executors,
 * handlers and translators agreeing instead of each re-inventing an inline
 * `{ ... }` type, and it keeps the provider-agnostic boundary honest: nothing
 * in this file may import a specific provider.
 */

/** Structured logger threaded through the whole request lifecycle. */
export type EngineLogger = {
	debug?: (scope: string, message: string, ...rest: unknown[]) => void
	info?: (scope: string, message: string, ...rest: unknown[]) => void
	warn?: (scope: string, message: string, ...rest: unknown[]) => void
	error?: (scope: string, message: string, ...rest: unknown[]) => void
	log?: (...args: unknown[]) => void
}

/** Per-connection credentials as stored by the app's repo layer. */
export interface Credentials {
	id?: string
	connectionId?: string
	provider?: string
	accessToken?: string
	refreshToken?: string
	apiKey?: string
	/** Some providers store the bearer token under `token` instead of `accessToken`. */
	token?: string
	idToken?: string
	expiresAt?: number | string | null
	tokenExpiresAt?: number | string | null
	expiresIn?: number
	lastRefreshAt?: number | string | null
	lastRefresh?: number | string | null
	projectId?: string
	email?: string
	name?: string
	/** Opaque per-request session id the translator layer stashes on the credentials. */
	_clientSessionId?: string | number | null
	providerSpecificData?: ProviderSpecificData
	[key: string]: unknown
}

/** Free-form per-provider credential extras (cookies, base URLs, regions…). */
export interface ProviderSpecificData {
	baseUrl?: string
	region?: string
	apiType?: string
	userId?: string
	systemId?: string
	organizationId?: string
	defaultOrganizationId?: string
	lastRefreshAt?: number | string | null
	[key: string]: unknown
}

/**
 * A refresh result: the token fields a provider's refresh handler returns.
 * Handlers sometimes signal an unrecoverable failure with an `error` code
 * instead of tokens, so the error fields live on the same shape.
 */
export interface RefreshedCredentials extends Credentials {
	copilotToken?: string
	copilotTokenExpiresAt?: number | string | null
	error?: string
	errorDescription?: string
}

/** Proxy / relay options that change how an upstream call is dispatched. */
export interface ProxyOptions {
	enabled?: boolean
	connectionProxyEnabled?: boolean
	vercelRelayUrl?: string
	/** Explicit proxy URL (`url` is the accepted alias). */
	proxyUrl?: string
	url?: string
	connectionProxyUrl?: string
	noProxy?: string
	connectionNoProxy?: string
	/** Never fall back to direct egress when the configured proxy fails. */
	strictProxy?: boolean
	/** Identifier of a pooled proxy to route through. */
	proxyPoolId?: string
	[key: string]: unknown
}

/** A single OpenAI-style chat message. Content may be a string or blocks. */
export interface ChatMessage {
	role: string
	content?: unknown
	name?: string
	tool_calls?: unknown[]
	tool_call_id?: string
	[key: string]: unknown
}

/**
 * An assistant message in a non-streaming Chat Completions reply.
 *
 * Executors build these by hand and then conditionally attach the optional
 * fields (`reasoning_content` when the model thought, `tool_calls` when it
 * called something), so every optional key is declared up front rather than
 * added by inference at the literal.
 */
export interface AssistantCompletionMessage {
	role: string
	content: string | null
	reasoning_content?: string
	tool_calls?: OpenAIToolCall[]
}

/** One function/tool invocation inside an assistant message. */
export interface OpenAIToolCall {
	id: string
	type: string
	function: { name: string; arguments: string }
}

/** A non-streaming Chat Completions response body an executor assembles. */
export interface ChatCompletionBody {
	id: string
	object: string
	created: number
	model: string
	choices: Array<{
		index: number
		message: AssistantCompletionMessage
		finish_reason: string
	}>
	usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

/**
 * One node of a ChatGPT Web conversation document (`/backend-api/conversation`).
 *
 * The document is a `{ mapping: { <nodeId>: { message } } }` tree the client
 * polls until the turn is complete; every field the executors read off it is
 * optional because partial documents arrive mid-turn.
 */
export interface ChatGptConversationNode {
	message?: {
		author?: { role?: string }
		content?: { content_type?: string; parts?: unknown[] } & Record<string, unknown>
		metadata?: Record<string, unknown>
	}
}

/** A ChatGPT Web conversation document keyed by node id. */
export interface ChatGptConversationDocument {
	mapping?: Record<string, ChatGptConversationNode | null | undefined>
}

/** Request body shape shared by every modality handler. */
export interface ChatRequestBody {
	model?: string
	messages?: ChatMessage[]
	stream?: boolean
	max_tokens?: number
	max_completion_tokens?: number
	temperature?: number
	top_p?: number
	tools?: unknown[]
	tool_choice?: unknown
	system?: unknown
	input?: unknown
	[key: string]: unknown
}

/** What an executor returns: the raw upstream response plus the call context. */
export type HandlerSuccess<TExtra extends Record<string, unknown> = Record<never, never>> = {
	success: true
	response: Response
} & TExtra

export type HandlerFailure = {
	success: false
	status: number
	error: string
	response: Response
	resetsAtMs?: number
}

export type HandlerResult<TExtra extends Record<string, unknown> = Record<never, never>> =
	| HandlerSuccess<TExtra>
	| HandlerFailure

export interface ExecutorResult {
	response: Response
	url?: string
	headers?: Record<string, string>
	transformedBody?: unknown
}

/** Optional error detail an executor may attach to a failed result. */
export interface ExecutorErrorResult {
	response?: Response
	status?: number
	error?: string
	url?: string
	headers?: Record<string, string>
	transformedBody?: unknown
}

export type ExecutorOutcome = ExecutorResult | ExecutorErrorResult

/** Arguments every `execute()` implementation receives. */
export interface ExecuteOptions {
	model: string
	body: ChatRequestBody
	stream?: boolean
	credentials?: Credentials | null
	signal?: AbortSignal
	log?: EngineLogger
	proxyOptions?: ProxyOptions | null
	providerOverrides?: ProviderOverrides | null
	timeoutMs?: number
	directFetch?: (url: string | URL, options?: RequestInit) => Promise<Response>
	onCredentialsRefreshed?: (credentials: Credentials) => void | Promise<void>
}

/** Per-provider user overrides (headers, model maps…). */
export interface ProviderOverrides {
	headers?: Record<string, string>
	[key: string]: unknown
}

/** Normalized usage block (OpenAI naming; translators rename as needed). */
export interface TokenUsage {
	prompt_tokens?: number
	completion_tokens?: number
	total_tokens?: number
	prompt_tokens_details?: Record<string, number>
	completion_tokens_details?: Record<string, number>
	[key: string]: unknown
}

/** Anything that can carry a usage report. */
export interface UsageCarrier {
	usage?: TokenUsage
}

/** Callback a handler invokes after it refreshed a connection's credentials. */
export type CredentialsRefreshedCallback = (credentials: Credentials) => void | Promise<void>

/**
 * Request an image/video adapter builds for its upstream.
 *
 * `error` is a validation failure the adapter reports instead of a plan; it is
 * surfaced to the client as a 400 before anything is dispatched.
 */
export interface MediaRequestPlan {
	method?: string
	url?: string
	headers?: Record<string, string>
	body?: unknown
	error?: string
}

/** Arguments every image/video adapter `buildRequest()` receives. */
export interface MediaAdapterRequestOptions {
	config?: ProviderMediaConfig | null
	action?: string | null
	requestId?: string | null
	rawBody?: unknown
	contentType?: string | null
	idempotencyKey?: string | null
	credentials?: Credentials | null
	log?: EngineLogger | null
	token?: string | null
}

/** Registry `imageConfig` / `videoConfig` entry, plus the adapter knobs. */
export interface ProviderMediaConfig {
	baseUrl?: string
	headers?: Record<string, string>
	bodyFields?: string[]
	executorDriven?: boolean
	[key: string]: unknown
}

/** An adapter that maps the OpenAI-ish media request onto a provider wire format. */
export interface MediaRequestAdapter {
	buildRequest: (options: MediaAdapterRequestOptions) => MediaRequestPlan | Promise<MediaRequestPlan>
	transformResponse?: (body: unknown) => unknown
}

/** Request body of a media (image/video/tts/stt) endpoint. */
export interface MediaRequestBody {
	model?: string
	prompt?: string
	n?: number
	size?: string
	[key: string]: unknown
}

/**
 * The request-logger surface `createSSEStream` writes to. The app's
 * RequestLogger implements all three; absent hooks are simply skipped.
 */
export interface StreamRequestLogger {
	appendProviderChunk?: (text: string) => void
	appendConvertedChunk?: (text: string) => void
	appendOpenAIChunk?: (text: string) => void
	[key: string]: unknown
}

/** A translated response chunk - shape varies per format. */
export interface StreamChunk {
	type?: string
	id?: string
	model?: string
	created?: number
	done?: boolean
	choices?: Array<{
		delta?: Record<string, unknown>
		finish_reason?: string | null
		[key: string]: unknown
	}>
	delta?: { text?: string; thinking?: string; [key: string]: unknown }
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string; thought?: boolean; [key: string]: unknown }> }
		[key: string]: unknown
	}>
	usage?: TokenUsage | null
	_openaiIntermediate?: Array<Record<string, unknown>>
	[key: string]: unknown
}

/**
 * Renderer state threaded through `translateResponse`. Built by
 * `initState()`; the format-specific fields are added only for the
 * formats that use them, so anything beyond the base keys is optional
 * (and belongs to the translators under `translator/`).
 */
export interface StreamState {
	messageId: string | null
	model: string | null
	textBlockStarted: boolean
	thinkingBlockStarted: boolean
	inThinkingBlock: boolean
	currentBlockIndex: number | null
	toolCalls: Map<unknown, unknown>
	streamToolCallIds: Map<unknown, unknown>
	finishReason: string | null
	finishReasonSent: boolean
	usage: TokenUsage | null
	contentBlockIndex: number
	/** Which upstream format produced this stream. */
	targetFormat?: string
	provider?: string | null
	toolNameMap?: Map<string, string> | null
	customToolNames?: Set<string>
	sessionId?: string | number | null
	completionPending?: boolean
	completedSent?: boolean
	[key: string]: unknown
}

/** Summary the stream hands to `onStreamComplete` once the upstream ends. */
export interface StreamCompletion {
	content: string
	thinking: string
}

export type OnStreamComplete = (
	completion: StreamCompletion,
	usage: TokenUsage | null,
	ttftAt: number | null,
) => void

/** Named options accepted by `createSSEStream`. */
export interface SSEStreamOptions {
	mode?: string
	targetFormat?: string
	sourceFormat?: string
	provider?: string | null
	reqLogger?: StreamRequestLogger | null
	toolNameMap?: Map<string, string> | null
	customToolNames?: Iterable<string> | null
	model?: string | null
	connectionId?: string | null
	body?: ChatRequestBody | null
	onStreamComplete?: OnStreamComplete | null
	apiKey?: string | null
	credentials?: Credentials | null
	aliasModel?: string | null
}
