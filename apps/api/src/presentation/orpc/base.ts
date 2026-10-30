/**
 * Base builder and middleware every procedure shares.
 *
 * oRPC 1.x has no router-level `.use()`, so cross-cutting concerns are applied
 * per procedure here and every router starts from this builder. Auth is
 * attached BEFORE the input schema: an unauthenticated caller must get 401, not
 * a 400 that hands them the shape of a schema they have no right to probe.
 *
 * Ordering bites twice in here, both times because oRPC middleware does not
 * rethrow a downstream error into the *calling* middleware's `try/catch`:
 *
 *  - `authed` therefore starts from `base`, so the error boundary is already
 *    inside the chain and sees the failure.
 *  - The guard THROWS an ORPCError rather than an AppError, because the
 *    boundary maps AppError and would otherwise have nothing to map.
 */
import { ORPCError, os } from "@orpc/server"
import type { ClaudeResetPort } from "../../application/claude-reset/reset-grant.ts"
import type { CodexResetPort } from "../../application/codex-reset-credits/reset-credits.ts"
import type {
	CoworkDependencies,
	CoworkFilesPort,
} from "../../application/cowork-settings/manage-cowork-settings.ts"
import type { NotificationStore } from "../../application/notifications/read-notifications.ts"
import type {
	NoticeWording,
	NotificationScanStore,
} from "../../application/notifications/scan-notifications.ts"
import type {
	DumpNameRule,
	TranslatorDumpStore,
} from "../../application/translator/read-translator-dumps.ts"
import type { UseCases } from "../../application/use-cases.ts"
import { toORPCError } from "./error-mapping.ts"

/**
 * What a procedure may read from the caller's session.
 *
 * A field missing from this type is a field every procedure invents a default for,
 * and the convenient default is never the safe one. Both routers that carried a
 * constant instead of a session prove it:
 *
 *  - `usage` hardcoded `{ apiKeyFilter: null, allowedModels: "*" }`, which widens an
 *    API-key session's view from its own usage to every key's.
 *  - `dashboard-keys` hardcoded the caller as `{ role: "admin", permissions: null }`,
 *    which clears the sub-key escalation gate and lets a key session grant itself
 *    permissions that `domain/sub-key-scope.ts` exists to refuse.
 *
 * So the whole identity lives here, not just enough of it to render a page. The
 * fields are optional because a password session genuinely carries none of them —
 * a real absence, which the domain rules already read as "unrestricted".
 */
export interface SessionClaims {
	readonly userId: string
	readonly email: string
	/**
	 * `apikey` marks a caller authenticated by a key rather than the password. Every
	 * rule that distinguishes the two branches on this exact string, so a procedure
	 * that substitutes `"admin"` silences all of them at once.
	 */
	readonly role?: string | null
	/** The caller's own key, present only when `role` is `apikey`. */
	readonly apiKey?: string | null
	readonly keyName?: string | null
	readonly keyId?: string | null
	/** Set when the caller signed in with an API key; narrows usage to that key. */
	readonly apiKeyFilter?: unknown
	/** The models this caller may use; `"*"` or absent means all. */
	readonly allowedModels?: unknown
	/** Caps inherited by keys this caller creates. */
	readonly tokenLimit?: unknown
	readonly dailyCostLimit?: unknown
	/** The endpoints this caller may reach; `null` means no restriction. */
	readonly allowedEndpoints?: unknown
	/** What the caller itself may do; `null` for a password session. */
	readonly permissions?: unknown
}

export interface RequestContext {
	/** Resolved by the auth middleware; `null` on routes that allow anonymous. */
	readonly session: SessionClaims | null
	/**
	 * The request's own headers, for the few credentials that are not a session.
	 *
	 * The database export/import endpoints prove identity with `x-9r-password`,
	 * `x-9r-cli-token` and `x-9r-poll-token` rather than the cookie — the CLI has no cookie,
	 * and a mid-import poll has to keep working while the password row is being replaced.
	 * They are read here rather than accepted as procedure input: a remote caller could put
	 * `{ cli: true }` in a body, and the rules in `domain/database-access.ts` would then be
	 * satisfied by a claim instead of a proof.
	 */
	readonly headers: Headers
}

/**
 * The CLI-tool host bundles, keyed by tool name.
 *
 * Injected rather than imported: each bundle holds `isInstalled`, a config port and the
 * side-write functions, and those live in `apps/web/src/lib/cliToolHosts.ts` — filesystem code
 * that `apps/api` must not depend on. The dependency runs web -> api, so the resolver arrives
 * on the context the same way `useCases` does.
 */
export type CliToolHosts = (
	name: string,
) => import("../../application/cli-tools/manage-tool-settings.ts").ToolSettingsDeps | undefined

/**
 * Claude Code's settings port, injected for the same reason as `CliToolHosts`.
 *
 * `claudeSettingsPort` reads and writes `~/.claude/settings.json`, so it lives in `apps/web`
 * with the rest of the host code. Keeping it off this package is what lets the use-case stay
 * testable without a filesystem.
 */
export interface ClaudeSettingsHosts {
	readonly port: import("../../application/claude-tools/manage-claude-settings.ts").ClaudeSettingsPort
	readonly isInstalled: () => Promise<boolean>
}

/**
 * The Codex profiles directory, injected for the same reason as the two above.
 *
 * `codexProfilesPort` reads and writes `~/.codex`, so it is host code. The use-case decides
 * what a missing directory means and what a refused write returns; the port only reports.
 */
export type CodexProfilesHosts =
	import("../../application/codex-profiles/manage-codex-profiles.ts").CodexProfilesPort

/**
 * The MCP probe's network, injected because the choice depends on the request.
 *
 * A remote caller must fetch through the SSRF guard; a local one must keep its self-hosted MCP
 * server on loopback. Both `fetchPublic` and `isLocalHeaders` live in `apps/web`, so the bundle
 * arrives on the context and reads `context.headers` — never a claim in the body, which a remote
 * caller could set.
 */
type RegistryCache = import("../../application/cowork-mcp/read-mcp-registry.ts").RegistryCache

export interface McpProbeHost {
	readonly fetchForCaller: (
		headers: Headers,
	) => (url: string, init: RequestInit) => Promise<Response>
	readonly isLocal: (headers: Headers) => boolean
	/** Throws when the URL is not public. */
	readonly assertPublicUrl: (url: string) => void
	/** The registry cache, one per process; a function so a hot reload cannot fork it. */
	readonly registryCache: () => RegistryCache
	/** The registry's fetch; absent means the global one. */
	readonly fetchServers?: typeof fetch
}

/**
 * Devin's two probes, injected like every other host bundle.
 *
 * Devin writes no settings, so there is no config port to carry — only "is it there" and "which
 * version". Both read the machine.
 */
export interface DevinHosts {
	readonly install: import("../../application/cli-tools/read-devin-status.ts").DevinInstallPort
	readonly version: import("../../application/cli-tools/read-devin-status.ts").DevinVersionPort
}

/**
 * Hermes's profile directories, injected for the same reason as the rest: the file access and
 * the `hermes` binary probe are host code, and the rules about which directory a profile name
 * means stay in `domain/hermes-profiles`.
 */
export type HermesHosts =
	import("../../application/hermes/manage-hermes-settings.ts").HermesFilesPort

/**
 * Claude Desktop's config library, injected because the paths are platform questions and the
 * plugin presets describe what this dashboard can bridge.
 */
export interface CoworkSettingsHosts {
	readonly files: CoworkFilesPort
	readonly pluginPresets: CoworkDependencies["pluginPresets"]
	readonly localPlugins: CoworkDependencies["localPlugins"]
	readonly buildPresetEntries: CoworkDependencies["buildPresetEntries"]
	readonly localBridgePrefix: string
	readonly cliTokenHeader: string
	readonly cliToken: () => Promise<string | null>
}

export interface AppContext extends RequestContext {
	readonly useCases: UseCases
	/** Present on the in-process dashboard client; absent on a context with no host access. */
	readonly cliToolHosts?: CliToolHosts
	/** Claude Code's port and install probe; absent on a context with no host access. */
	readonly claudeSettingsHosts?: ClaudeSettingsHosts
	/** `~/.codex` as a port; absent on a context with no host access. */
	readonly codexProfilesHosts?: CodexProfilesHosts
	/** Network for the MCP probe; absent on a context with no host access. */
	readonly mcpProbeHost?: McpProbeHost
	/** Devin's detection probes; absent on a context with no host access. */
	readonly devinHosts?: DevinHosts
	/** Hermes's profile directories; absent on a context with no host access. */
	readonly hermesHosts?: HermesHosts
	/** Claude Desktop's config library; absent on a context with no host access. */
	readonly coworkSettingsHosts?: CoworkSettingsHosts
	/** The notification table; absent on a context with no database. */
	readonly notificationStore?: NotificationStore
	/** The key table plus the notification writes the scan makes. */
	readonly notificationScanStore?: NotificationScanStore
	/** The quota notice copy — dashboard text, so the host supplies it. */
	readonly noticeWording?: NoticeWording
	/** The translator inspector's `logs/translator` folder. */
	readonly translatorDumpStore?: TranslatorDumpStore
	/** The closed filename rule; the domain's `translatorDumpFile`. */
	readonly translatorDumpName?: DumpNameRule
	/** The connection row, the OAuth refresh and the two Codex upstream calls. */
	readonly codexResetPort?: CodexResetPort
	/** The same three, for Claude's limit-reset grant. */
	readonly claudeResetPort?: ClaudeResetPort
}

/** Anything thrown below presentation becomes a typed ORPCError exactly once. */
const errorBoundary = os.middleware(async ({ next }) => {
	try {
		return await next()
	} catch (error) {
		// An ORPCError is already typed; rewrapping it would turn a deliberate
		// 401 into a 500.
		if (error instanceof ORPCError) throw error
		throw toORPCError(error)
	}
})

/** Every procedure starts here. */
export const base = os.$context<AppContext>().use(errorBoundary)

/** Gate for dashboard procedures. Built on `base` so the boundary wraps it. */
export const authed = base.use(async ({ context, next }) => {
	if (!context.session) {
		throw new ORPCError("UNAUTHORIZED", { status: 401, message: "Authentication required" })
	}
	return next({ context: { ...context, session: context.session } })
})
