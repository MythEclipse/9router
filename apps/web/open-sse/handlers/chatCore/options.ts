import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.ts"

/**
 * Structured logger threaded through the handler. Callers pass console-like
 * objects whose optional helpers vary, hence the open index signature.
 */
export interface LogSink {
	info?: (tag: string, message: string) => void
	debug?: (tag: string, message: string) => void
	warn?: (tag: string, message: string) => void
	error?: (tag: string, message: string) => void
	line?: (tag: string, icon: string, message: string) => void
	errorLine?: (tag: string, icon: string, message: string) => void
	fmtThink?: (thinking: unknown) => string | null
	tagForSession?: (seed: string) => string
	nextTag?: () => string
	[key: string]: unknown
}

/**
 * Everything `handleChatCore` needs to know about the caller, the account and
 * the model so it can log, alias and route the way the app expects. These are
 * identity / display knobs - none of them turn a feature on or off, except
 * `toolCallFallbackEnabled`.
 */
export interface ClientIdentity {
	connectionId?: string
	userAgent?: string
	apiKey?: string
	clientRawRequest?: {
		headers?: Record<string, string>
		endpoint?: string
		body?: Record<string, unknown>
		[key: string]: unknown
	}
	ccFilterNaming?: boolean
	requestedModel?: string
	providerThinking?: { mode?: string; [key: string]: unknown }
	providerOverrides?: unknown
	modelMultipliers?: unknown
	isAntiProbe?: boolean
	hideError?: boolean
	sourceFormatOverride?: string
	toolCallFallbackEnabled?: boolean
}

/**
 * Every token-saving pipeline applied to the outbound body just before
 * dispatch (RTK, Context Pruning, Headroom, Caveman, Ponytail, Custom Prompt,
 * Pxpipe). Grouped because they are one feature: the "Token Saver" settings
 * panel owns all of them.
 */
export interface TokenSaverConfig {
	rtkEnabled?: unknown
	contextPruningEnabled?: unknown
	contextPruningLevel?: unknown
	maxMessagesLimit?: number
	headroomEnabled?: boolean
	headroomUrl?: string
	headroomCompressUserMessages?: boolean
	headroomTimeoutMs?: number
	cavemanEnabled?: unknown
	cavemanLevel?: unknown
	ponytailEnabled?: unknown
	ponytailLevel?: unknown
	customPromptEnabled?: boolean
	customPrompt?: string
	pxpipeEnabled?: unknown
	pxpipeMinChars?: unknown
	pxpipeTimeoutMs?: number
	pxpipeTransform?: unknown
	onPxpipeEvent?: (event: Record<string, unknown>) => void
}

/**
 * Semantic / duplicate prompt cache settings. TTL and cap are re-read on every
 * enabled request so the Token Saver sliders apply without a proxy restart.
 */
export interface SemanticCacheConfig {
	enabled?: boolean
	ttlHours?: number
	maxEntries?: number
}

/**
 * Transport knobs for the inbound HTTP request.
 *
 * Only `clientSignal` is wired today: it aborts the upstream call when the
 * client goes away. `timeoutMs`, `maxBytes` and `stallCheckInterval` are
 * declared for callers that want to pass them; their defaults come from
 * `config/runtimeConfig` (`STREAM_STALL_TIMEOUT_MS`) and the stream layer, so
 * leaving them undefined keeps today's behavior exactly.
 */
export interface StreamConfig {
	clientSignal?: AbortSignal | null
	/** Default: config/runtimeConfig STREAM_STALL_TIMEOUT_MS. */
	timeoutMs?: number
	maxBytes?: number
	stallCheckInterval?: number
}

/**
 * Callbacks the caller subscribes to. Never invoked by the handler itself
 * other than at the documented points (refresh, success, disconnect).
 */
export interface ChatCoreHooks {
	onCredentialsRefreshed?: (credentials: Record<string, unknown>) => void | Promise<void>
	onRequestSuccess?: () => void | Promise<void>
	onDisconnect?: (reason?: string | { reason: string; duration: number }) => void | Promise<void>
}

type ChatCoreBody = Record<string, unknown> & { stream?: boolean }
type ChatCoreModelInfo = { provider: string; model: string }
type ChatCoreCredentials = Record<string, unknown> & {
	connectionName?: string
	connectionId?: string
	runtimeTransport?: { format?: string; [key: string]: unknown }
	rawHeaders?: Record<string, string>
	providerSpecificData?: Record<string, unknown> & {
		connectionProxyEnabled?: boolean
		connectionProxyUrl?: string
		connectionNoProxy?: string
		proxyType?: string
		relayUrl?: string
		vercelRelayUrl?: string
		connectionProxyPoolId?: string | null
		strictProxy?: boolean
	}
}

/**
 * Every knob `handleChatCore` accepts. All fields stay optional so the many
 * call sites (routes, other handlers, tests) keep compiling as before; the
 * ones the function relies on unconditionally are marked required.
 *
 * The groups are the shape new callers should use. The flat legacy fields
 * (rtkEnabled, semanticCacheEnabled, connectionId, ...) stay declared because
 * the route layer, tests and external users of open-sse still pass them - see
 * `normalizeChatCoreOptions`, which folds both shapes together.
 */
export interface ChatCoreOptions
	extends Partial<TokenSaverConfig>,
		Partial<SemanticCacheConfig>,
		Partial<ClientIdentity>,
		Partial<StreamConfig>,
		Partial<ChatCoreHooks> {
	body: ChatCoreBody
	modelInfo: ChatCoreModelInfo
	credentials: ChatCoreCredentials
	log?: LogSink

	// Grouped shape (preferred). When present, a group's field wins over the
	// same-named flat field; a field the group omits still falls back to flat.
	tokenSavers?: TokenSaverConfig
	semanticCache?: SemanticCacheConfig
	stream?: StreamConfig
	client?: ClientIdentity
	hooks?: ChatCoreHooks
}

/** Options as `handleChatCore` consumes them: core fields + resolved groups. */
export interface NormalizedChatCoreOptions
	extends Required<Pick<ChatCoreOptions, "body" | "modelInfo" | "credentials">> {
	log?: LogSink
	tokenSavers: TokenSaverConfig
	semanticCache: SemanticCacheConfig
	stream: StreamConfig
	client: ClientIdentity
	hooks: ChatCoreHooks
}

const TOKEN_SAVER_FIELDS = [
	"rtkEnabled",
	"contextPruningEnabled",
	"contextPruningLevel",
	"maxMessagesLimit",
	"headroomEnabled",
	"headroomUrl",
	"headroomCompressUserMessages",
	"headroomTimeoutMs",
	"cavemanEnabled",
	"cavemanLevel",
	"ponytailEnabled",
	"ponytailLevel",
	"customPromptEnabled",
	"customPrompt",
	"pxpipeEnabled",
	"pxpipeMinChars",
	"pxpipeTimeoutMs",
	"pxpipeTransform",
	"onPxpipeEvent",
] as const

const SEMANTIC_CACHE_FIELDS = ["enabled", "ttlHours", "maxEntries"] as const

const STREAM_FIELDS = ["clientSignal", "timeoutMs", "maxBytes", "stallCheckInterval"] as const

const CLIENT_FIELDS = [
	"connectionId",
	"userAgent",
	"apiKey",
	"clientRawRequest",
	"ccFilterNaming",
	"requestedModel",
	"providerThinking",
	"providerOverrides",
	"modelMultipliers",
	"isAntiProbe",
	"hideError",
	"sourceFormatOverride",
	"toolCallFallbackEnabled",
] as const

const HOOK_FIELDS = ["onCredentialsRefreshed", "onRequestSuccess", "onDisconnect"] as const

/**
 * Pull `fields` out of a group, falling back to the flat legacy names.
 * `flatName` maps a group field to the differently-named flat field it
 * replaces (semanticCache.enabled ← semanticCacheEnabled).
 */
function pickGroup<T extends object>(
	group: Record<string, unknown> | undefined,
	flat: Record<string, unknown>,
	fields: readonly (keyof T & string)[],
	flatName: (field: string) => string = (field) => field,
): T {
	const out: Record<string, unknown> = {}
	for (const field of fields) {
		const value = group?.[field] !== undefined ? group[field] : flat[flatName(field)]
		if (value !== undefined) out[field] = value
	}
	return out as T
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function semanticCacheFlatName(field: string): string {
	if (field === "enabled") return "semanticCacheEnabled"
	return `semanticCache${field[0].toUpperCase()}${field.slice(1)}`
}

/**
 * Accept BOTH the grouped and the flat legacy option shape.
 *
 * open-sse is also consumed standalone (as a library and by the CLI), and the
 * route layer plus a lot of tests still hand `handleChatCore` the flat
 * 55-field object it took before the groups existed. Normalizing here keeps
 * those callers working untouched while new code can pass the cohesive groups.
 * When both appear, the group wins field by field.
 */
export function normalizeChatCoreOptions(options: ChatCoreOptions): NormalizedChatCoreOptions {
	const raw = options as unknown as Record<string, unknown>
	return {
		body: options.body,
		modelInfo: options.modelInfo,
		credentials: options.credentials,
		log: options.log,
		tokenSavers: pickGroup<TokenSaverConfig>(asRecord(raw.tokenSavers), raw, TOKEN_SAVER_FIELDS),
		semanticCache: pickGroup<SemanticCacheConfig>(
			asRecord(raw.semanticCache),
			raw,
			SEMANTIC_CACHE_FIELDS,
			// The flat names kept the `semanticCache` prefix instead of nesting it.
			semanticCacheFlatName,
		),
		stream: pickGroup<StreamConfig>(asRecord(raw.stream), raw, STREAM_FIELDS),
		client: pickGroup<ClientIdentity>(asRecord(raw.client), raw, CLIENT_FIELDS),
		hooks: pickGroup<ChatCoreHooks>(asRecord(raw.hooks), raw, HOOK_FIELDS),
	}
}

/**
 * What `handleChatCore` answers with.
 *
 * The success arm narrows to exactly `response: Response`, so a caller that
 * does `result.success ? result.response : ...` still type-checks as
 * `Response` (routes return it directly). The failure arm is the
 * `createErrorResult` envelope the account-fallback loop rotates on.
 */
export interface ChatCoreSuccessResult {
	success: true
	response: Response
}

export interface ChatCoreFailureResult {
	success: false
	status: number
	error: string
	resetsAtMs?: number | null
	response: Response
}

export type ChatCoreResult = ChatCoreSuccessResult | ChatCoreFailureResult

/** The stall timeout a caller would get if `stream.timeoutMs` is omitted. */
export const DEFAULT_STREAM_TIMEOUT_MS = STREAM_STALL_TIMEOUT_MS
