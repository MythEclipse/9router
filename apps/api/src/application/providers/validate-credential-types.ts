/** Validate credential: shared types. */
import {
	anthropicCompatibleVerdict,
	blackboxVerdict,
	cloudflareVerdict,
	mediaProbeVerdict,
	notRefused,
	readerFor,
	readServiceAccount,
	refusalMessage,
	toCookieHeader,
	unwrapCredential,
	webProbeVerdict,
} from "../../domain/credential-verdict.ts"

export {
	anthropicCompatibleVerdict,
	blackboxVerdict,
	cloudflareVerdict,
	mediaProbeVerdict,
	notRefused,
	readerFor,
	readServiceAccount,
	refusalMessage,
	toCookieHeader,
	unwrapCredential,
	webProbeVerdict,
}
/** What a probe request needs: where to go and what to send. */
export interface ProbeRequest {
	readonly url: string
	readonly method?: "GET" | "POST"
	readonly headers?: Record<string, string>
	readonly body?: string
	readonly timeoutMs?: number
}

/** A probe's outcome, as the transport reports it. */
export interface ProbeResponse {
	readonly status: number
	readonly ok: boolean
	readonly text?: string
}

/** The verdict the panel shows. */
export interface ValidationResult {
	readonly valid: boolean
	readonly error: string | null
}

export interface ValidateCredentialDependencies {
	/** Sends one probe. Throws only on a network failure. */
	readonly send: (request: ProbeRequest) => Promise<ProbeResponse>
	/** A compatible or custom-embedding node, for its base URL and default model. */
	readonly findNode: (
		provider: string,
	) => Promise<{ readonly baseUrl?: string; readonly defaultModel?: string } | null>
	/** The provider's default model, for probes that need one. */
	readonly defaultModel: (provider: string) => string
	/** The provider's registry entry: base URL, format, headers, auth header. */
	readonly providerConfig: (provider: string) => RegistryEntry | undefined
	/** The provider's AI entry: noAuth, service kinds, apiKeyOptionalWith, credentialForm, probe configs. */
	readonly aiProvider: (provider: string) => AiProviderEntry | undefined
	readonly isOpenAICompatible: (provider: string) => boolean
	readonly isAnthropicCompatible: (provider: string) => boolean
	readonly isCustomEmbedding: (provider: string) => boolean
	/** Probes AWS credentials, which have no bearer key to test. */
	readonly probeAws: (input: {
		readonly apiKey: string
		readonly providerSpecificData?: Record<string, unknown>
	}) => Promise<ValidationResult>
	/** Probes a Qoder PAT, which needs a token exchange first. */
	readonly probeQoder: (input: {
		readonly provider: string
		readonly apiKey: string
		readonly providerSpecificData?: Record<string, unknown>
	}) => Promise<ValidationResult>
	/** Probes Nous, whose /models is public and proves nothing. */
	readonly probeNous: (apiKey: string) => Promise<ValidationResult>
	/** The dynamic base URLs two providers compute from the operator's own data. */
	readonly ollamaLocalHost: (input: { providerSpecificData?: Record<string, unknown> }) => string
	readonly tokenplanBaseUrl: (input: { providerSpecificData?: Record<string, unknown> }) => string
	/** Builds a CommandCode request body, which is not OpenAI-shaped. */
	readonly commandCodeBody: (model: string) => unknown
	/** The header set a CommandCode probe must send to pass for the CLI. */
	readonly commandCodeHeaders: (input: {
		readonly apiKey: string
		readonly sessionId?: string
	}) => Record<string, string>
	readonly randomId: () => string
}

/** A provider's registry entry, as the validator reads it. */
export interface RegistryEntry {
	readonly baseUrl?: string
	readonly format?: string
	readonly headers?: Record<string, string>
	readonly authHeader?: string
	readonly noAuth?: boolean
	readonly validateUrl?: string
}

/** A provider's AI entry, as the validator reads it. */
export interface AiProviderEntry {
	readonly noAuth?: boolean
	readonly name?: string
	readonly apiKeyOptionalWith?: string
	readonly credentialForm?: string
	readonly serviceKinds?: readonly string[]
	readonly searchConfig?: ProbeConfig
	readonly fetchConfig?: ProbeConfig
	readonly ttsConfig?: ProbeConfig
	readonly sttConfig?: ProbeConfig
	readonly embeddingConfig?: ProbeConfig
	readonly imageConfig?: ProbeConfig
	readonly videoConfig?: ProbeConfig
	readonly musicConfig?: ProbeConfig
}

/** The config block a media or search provider is probed through. */
export interface ProbeConfig {
	readonly authType?: string
	readonly authHeader?: string
	readonly baseUrl?: string
	readonly validateUrl?: string
	readonly method?: "GET" | "POST"
	readonly extraHeaders?: Record<string, string>
}

/** One provider's probe, as a value rather than a branch. */
export interface ProbePlan {
	readonly request: ProbeRequest
	readonly verdict: (response: ProbeResponse) => boolean
	readonly errorMessage?: string
}

/**
 * A domain status reader as a plan verdict.
 *
 * The domain reads a bare status; a plan is handed the whole response because a
 * few providers decide on the body (gemini-web's chat shell markers) — so the
 * status readers are widened once here rather than each plan unwrapping by hand.
 */
export const byStatus =
	(reader: (status: number) => boolean) =>
	(response: ProbeResponse): boolean =>
		reader(response.status)

export const PROBE_TIMEOUT_MS = 8000

/** The auth header a bearer-style provider wants. */
export const bearer = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` })
export const json = { "Content-Type": "application/json" }
