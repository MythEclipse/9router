/**
 * The dashboard's client for the oRPC router.
 *
 * In-process on purpose. `apps/web` already holds the use-cases graph and the
 * session cookie, so a `createRouterClient` call reaches the same procedures the
 * HTTP server exposes without a second network hop, a second session resolution,
 * or an API process that has to be running for the dashboard to work. The HTTP
 * server stays available for anything outside this process; this is the path the
 * dashboard itself uses.
 */

import * as apiKeysRepo from "@9router/db/repos/apiKeysRepo"
import * as notificationsRepo from "@9router/db/repos/notificationsRepo"
import { createRouterClient } from "@orpc/server"
import type { ScanKey } from "9router-api/application/notifications/scan-notifications"
import type { UseCases } from "9router-api/application/use-cases"
import { translatorDumpFile } from "9router-api/domain/translator"
import type {
	AppContext,
	ClaudeSettingsHosts,
	CliToolHosts,
	CodexProfilesHosts,
	CoworkSettingsHosts,
	DevinHosts,
	HermesHosts,
	McpProbeHost,
	SessionClaims,
} from "9router-api/presentation/orpc/base"
import { appRouter } from "9router-api/presentation/orpc/router"
import { codexResetPort } from "@/lib/codexResetPort"
import { quotaBody, quotaPressure, quotaTitle } from "@/lib/notifications/quotaPressure"
import { translatorDumpStore } from "@/lib/translatorDumpHost"
import {
	buildManagedMcpServers,
	DEFAULT_PLUGINS,
	LOCAL_STDIO_PLUGINS,
} from "@/shared/constants/coworkPlugins"
import { claudeSettingsPort, isClaudeInstalled } from "./claudeToolHost"
import { devinInstallPort, devinVersionPort } from "./cliToolHosts"
import { cliToolHost } from "./cliToolRegistry"
import { codexProfilesPort } from "./codexProfilesHost"
import { cliToken, coworkFilesPort, localBridgePrefix } from "./coworkSettingsHost"
import { hermesFilesPort } from "./hermesSettingsHost"
import { mcpProbeHost } from "./mcpProbeHost"

/**
 * What a procedure sees as `context.session`; `null` means not logged in.
 *
 * The full claim set, not just `userId`/`email`: a procedure that reports usage
 * narrows it with `usageScopeOf(session)`, which reads `apiKeyFilter` and
 * `allowedModels`. Passing only an identity would leave those undefined and hand an
 * API-key session every key's usage.
 */
export type DashboardSession = SessionClaims

export interface RouterContext {
	readonly session: DashboardSession | null
	readonly useCases: UseCases
	/**
	 * The inbound request's headers, so a procedure can read a credential that is not a
	 * session — the database endpoints use `x-9r-password` / `x-9r-cli-token` /
	 * `x-9r-poll-token`. Required rather than optional: a procedure that reads a credential
	 * must not be able to run against a context that has no headers at all, which would
	 * look like "no password presented" and refuse for the wrong reason. Use `new Headers()`
	 * when a caller genuinely has none.
	 */
	readonly headers: Headers
	/**
	 * The CLI-tool host bundles, looked up by tool name.
	 *
	 * Required, like `useCases`: the procedures that configure a CLI tool cannot work without
	 * it, and an optional field here would turn "this client was built wrong" into a 500 at the
	 * moment an operator clicks Save.
	 */
	readonly cliToolHosts?: CliToolHosts
	/** Claude Code's settings port; defaulted in `createApiClient` like `cliToolHosts`. */
	readonly claudeSettingsHosts?: ClaudeSettingsHosts
	/** `~/.codex` as a port; defaulted in `createApiClient` like the two above. */
	readonly codexProfilesHosts?: CodexProfilesHosts
	/** The MCP probe's network; defaulted in `createApiClient` like the three above. */
	readonly mcpProbeHost?: McpProbeHost
	/** Devin's detection probes; defaulted in `createApiClient` like the rest. */
	readonly devinHosts?: DevinHosts
	/** Hermes's profile directories; defaulted in `createApiClient` like the rest. */
	readonly hermesHosts?: HermesHosts
	/** Claude Desktop's config library; defaulted in `createApiClient` like the rest. */
	readonly coworkSettingsHosts?: CoworkSettingsHosts
	/** The notification table. Defaults to the shared repo, which is lazy: it opens on first use. */
	readonly notificationStore?: AppContext["notificationStore"]
	/** The key table and the notification writes the scan makes. */
	readonly notificationScanStore?: AppContext["notificationScanStore"]
	/** The quota notice copy. */
	readonly noticeWording?: AppContext["noticeWording"]
	/** The translator inspector's dump folder. */
	readonly translatorDumpStore?: AppContext["translatorDumpStore"]
	/** The closed filename rule. Defaults to the domain's own. */
	readonly translatorDumpName?: AppContext["translatorDumpName"]
	/** The Codex reset-credit port. */
	readonly codexResetPort?: AppContext["codexResetPort"]
}

/**
 * Build a client bound to one request's context.
 *
 * A fresh client per call rather than a shared one: the context carries the
 * caller's session, and a cached client would serve the first caller's session to
 * every later one — the exact class of bug the cookie-based design avoids.
 */
/**
 * The Cowork host bundle. The presets are the dashboard's own catalogue: which bridges this
 * install can serve is a web concern, so it is passed in rather than imported by `apps/api`.
 */
const defaultCoworkHosts = (): CoworkSettingsHosts => {
	return {
		files: coworkFilesPort,
		pluginPresets: DEFAULT_PLUGINS,
		localPlugins: LOCAL_STDIO_PLUGINS,
		buildPresetEntries: buildManagedMcpServers,
		localBridgePrefix,
		cliTokenHeader: "x-9r-cli-token",
		cliToken,
	}
}

/**
 * The notification table, behind the port the use-case declares.
 *
 * Written as a lazy object rather than bound methods because importing the repo opens the
 * database; a client built at module load must not do that.
 */
const defaultNotificationStore: NonNullable<AppContext["notificationStore"]> = {
	list: (input) => notificationsRepo.listNotifications(input),
	unreadCount: () => notificationsRepo.getUnreadCount(),
	markRead: (id) => notificationsRepo.markRead(id),
	clearById: (id) => notificationsRepo.clearNotificationById(id),
	clearByKind: (kind, dedupeKey) => notificationsRepo.clearNotificationByKind(kind, dedupeKey),
}

/** The scan's two tables, behind the port the use-case declares. */
const defaultNotificationScanStore: NonNullable<AppContext["notificationScanStore"]> = {
	// The record type is closed; the scan only reads `id`, and the domain takes an open shape
	// because a stored key is a row, not a domain entity.
	keys: async () => (await apiKeysRepo.getApiKeys()) as unknown as readonly ScanKey[],
	notify: (input) => notificationsRepo.notify(input),
	clearByKind: (kind, dedupeKey) => notificationsRepo.clearNotificationByKind(kind, dedupeKey),
	clearAllOfKind: (kind) => notificationsRepo.clearNotificationsByKind(kind),
}

/** The notice copy. It lives in the dashboard because it is dashboard wording. */
const quotaNoticeWording: NonNullable<AppContext["noticeWording"]> = {
	pressure: (key) => quotaPressure(key),
	title: (key, pressure) => quotaTitle(key, pressure),
	body: (pressure) => quotaBody(pressure),
}

export function createApiClient(context: RouterContext) {
	// Defaulted here rather than required from every caller: 131 routes build this context and
	// none of them has an opinion about CLI tools. The registry is a module-level table, so one
	// import covers all of them, and a route that needs a different resolver can still pass one.
	return createRouterClient(appRouter, {
		context: {
			...context,
			cliToolHosts: context.cliToolHosts ?? cliToolHost,
			codexProfilesHosts: context.codexProfilesHosts ?? codexProfilesPort,
			mcpProbeHost: context.mcpProbeHost ?? mcpProbeHost,
			devinHosts: context.devinHosts ?? { install: devinInstallPort, version: devinVersionPort },
			hermesHosts: context.hermesHosts ?? hermesFilesPort,
			coworkSettingsHosts: context.coworkSettingsHosts ?? defaultCoworkHosts(),
			notificationStore: context.notificationStore ?? defaultNotificationStore,
			notificationScanStore: context.notificationScanStore ?? defaultNotificationScanStore,
			noticeWording: context.noticeWording ?? quotaNoticeWording,
			translatorDumpStore: context.translatorDumpStore ?? translatorDumpStore,
			translatorDumpName: context.translatorDumpName ?? translatorDumpFile,
			codexResetPort: context.codexResetPort ?? codexResetPort,
			claudeSettingsHosts: context.claudeSettingsHosts ?? {
				port: claudeSettingsPort,
				isInstalled: isClaudeInstalled,
			},
		},
	})
}

export type ApiClient = ReturnType<typeof createApiClient>

/**
 * Turn the dashboard's session context into router claims.
 *
 * One function rather than a mapping in each route: the first version of the combos
 * route picked `userId`, `email` and `role` by hand, which dropped `apiKeyFilter`
 * and `allowedModels`. Those are exactly the claims that narrow usage to the caller,
 * so a hand-written mapping is how a scoped route silently becomes an unscoped one.
 *
 * `permissions` is merged in from the *context*, not read off the session: the
 * dashboard computes the effective set (a password session gets `FULL_PERMISSIONS`,
 * a key session gets its own normalised list) and puts it beside the session rather
 * than inside it. Reading `session.permissions` would hand every password session
 * `undefined` where it currently has full rights.
 *
 * Returns `null` when there is no `userId`: a session that names nobody is not a
 * session, and passing an object with a blank id would pass the auth gate.
 */
export function sessionClaimsOf(ctx: unknown): DashboardSession | null {
	const context = ctx as { session?: Record<string, unknown> | null; permissions?: unknown } | null
	const session = context?.session
	if (!session) return null
	const userId = typeof session.userId === "string" ? session.userId.trim() : ""
	if (!userId) return null
	return {
		...session,
		userId,
		email: typeof session.email === "string" ? session.email : userId,
		permissions: ctx === null ? null : (context?.permissions ?? session.permissions ?? null),
	} as DashboardSession
}
