/**
 * Ports for the provider-connection use-cases.
 *
 * The connection store, the node store and the pool store are separate tables
 * with separate lifetimes; naming them separately keeps a use-case from being
 * handed a god-object it can reach anything through.
 */

/** A stored connection, as the store returns it. */
export interface StoredConnection {
	readonly id: string
	readonly provider: string
	readonly authType?: string | null
	readonly name?: string | null
	readonly email?: string | null
	readonly apiKey?: string | null
	readonly accessToken?: string | null
	readonly priority?: number | null
	readonly globalPriority?: number | null
	readonly defaultModel?: string | null
	readonly isActive?: boolean | null
	readonly testStatus?: string | null
	readonly lastError?: string | null
	readonly lastErrorAt?: string | null
	readonly providerSpecificData?: Record<string, unknown> | null
	readonly updatedAt?: string | null
	readonly [key: string]: unknown
}

/** What a create or update may write. */
export interface ConnectionFields {
	readonly provider?: string
	readonly authType?: string
	readonly name?: string
	readonly email?: string | null
	readonly apiKey?: string
	readonly priority?: number
	readonly globalPriority?: number | null
	readonly defaultModel?: string | null
	readonly providerSpecificData?: Record<string, unknown>
	readonly isActive?: boolean
	readonly testStatus?: string
	readonly lastError?: string | null
	readonly lastErrorAt?: string | null
	readonly allowOverwrite?: boolean
	readonly [key: string]: unknown
}

export interface ConnectionStore {
	list(filter?: {
		readonly provider?: string
		readonly isActive?: boolean
	}): Promise<StoredConnection[]>
	find(id: string): Promise<StoredConnection | null>
	create(fields: ConnectionFields): Promise<StoredConnection>
	update(id: string, fields: Partial<ConnectionFields>): Promise<StoredConnection | null>
	remove(id: string): Promise<boolean>
}

/**
 * A node gives a compatible connection its base URL and display name.
 *
 * `id` is optional because the node row's key may be absent on a hand-edited
 * store — the listing already tolerates that, so the port does too.
 */
export interface ConnectionNode {
	readonly id?: string
	readonly prefix?: string
	readonly apiType?: string
	readonly baseUrl?: string
	readonly name?: string
	readonly quotaEnabled?: boolean
	readonly quotaPath?: string
}

export interface ConnectionNodeStore {
	find(id: string): Promise<ConnectionNode | null>
	list(): Promise<ConnectionNode[]>
}

/** Only the fact that a pool exists is needed to accept its id. */
export interface ProxyPoolStore {
	exists(id: string): Promise<boolean>
}

/**
 * What kind of provider an id names.
 *
 * The create route decides which `providerSpecificData` to write from this, so it
 * has to ask: a compatible node's connection gets its base URL copied in, a
 * built-in provider's does not.
 */
export interface ProviderCatalogue {
	/** The display name, or the raw id when the provider is unknown. */
	label(provider: string): string
	/** True when this id names a compatible node rather than a built-in provider. */
	isOpenAICompatible(provider: string): boolean
	isAnthropicCompatible(provider: string): boolean
	isCustomEmbedding(provider: string): boolean
	/** True when the provider stores a cookie instead of an API key. */
	isWebCookie(provider: string): boolean
	/**
	 * The `providerSpecificData` field that stands in for the API key, when the
	 * provider declares one — Bedrock's `profile`, where the credential lives in
	 * the local AWS config and there is no key to paste.
	 */
	apiKeySubstituteField(provider: string): string | null
	/** True when this id may be written at all. */
	isCreatable(provider: string): boolean
	/**
	 * True when the provider's credential is an AWS triple (key, secret, session
	 * token) rather than one opaque string. Only that form has the empty-vs-null
	 * ambiguity on an edit: the form cannot read the stored token back.
	 */
	usesAwsCredentialForm(provider: string): boolean
	/**
	 * How this provider answers "which models do you have".
	 *
	 * Three shapes, and the shape decides who builds the request: a compatible
	 * node states its own base URL, a fixed endpoint is a constant in the
	 * catalogue, and everything else belongs to a resolver of its own.
	 */
	modelListAdapter(provider: string): ModelListAdapter
}

export type ModelListAdapter =
	| { readonly kind: "openai-compatible" }
	| { readonly kind: "anthropic-compatible" }
	| {
			readonly kind: "fixed-endpoint"
			readonly url: string
			readonly method: "GET" | "POST"
			readonly headers: Record<string, string>
			/** Send the token as this query parameter instead of a header. */
			readonly authQuery?: string
			readonly authHeader?: string
			readonly authPrefix?: string
			readonly body?: unknown
			/** Read the list out of this provider's own answer shape. */
			readonly parse: (payload: unknown) => unknown[]
	  }
	/** The provider has its own resolver. */
	| { readonly kind: "custom" }
	/** The provider has no model list to give. */
	| { readonly kind: "unsupported" }
