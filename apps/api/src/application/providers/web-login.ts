/**
 * The interactive web-login flow: start, poll, cancel, and save on success.
 *
 * Called from:
 *   - `apps/api/src/application/use-cases.ts` (`makeWebLogin`, registered as
 *     `webLogin`)
 *   - `apps/web/src/app/api/providers/web-login/route.ts` via
 *     `getUseCases().webLogin.*` (GET status, GET list, POST begin, DELETE cancel)
 *   - `tests/unit/use-case-web-login.test.ts`
 *
 * No existing file serves this purpose: `manage-connections.ts` writes a
 * connection the operator typed; this writes one a browser harvested, and the
 * save-on-success step lived in the middle of the GET handler.
 *
 * Reads: the web-login connection rows for a provider (`id`, `email`,
 * `updatedAt`, `providerSpecificData`) and the identity probe's verdict. Writes:
 * creates or updates one connection, deletes duplicate rows, and clears the
 * harvested credential from the session once it is persisted.
 *
 * User instruction, verbatim: "lanjut kenapa malah berhenti".
 */

import { invalid, notFound } from "../../domain/errors.ts"
import {
	conflictMessage,
	connectionNameFor,
	credentialPreview,
	duplicatesOf,
	findRefreshTarget,
	readIdentityVerdict,
	type WebLoginCandidate,
	webLoginProviderData,
	webLoginRowsOf,
} from "../../domain/web-login.ts"
import type { ConnectionFields, ConnectionStore } from "./ports.ts"

/** One provider's login session, as the browser driver reports it. */
export interface WebLoginSession {
	status: string
	profile?: string | null
	error?: string | null
	/** The harvested cookie or token. Never leaves this module except as a preview. */
	credential?: string | null
	savedConnectionId?: string | null
	accountEmail?: string | null
}

export interface WebLoginDependencies {
	readonly connections: ConnectionStore
	/** The providers whose login page can be driven, and their saved profiles. */
	readonly listProviders: () => readonly string[]
	readonly listProfiles: () => unknown
	/** The login configuration for a provider, or null when it is unsupported. */
	readonly configOf: (provider: string) => { readonly credentialFrom?: string } | null
	readonly statusOf: (provider: string) => WebLoginSession | null
	readonly start: (provider: string, profile: string) => Promise<WebLoginSession>
	readonly cancel: (provider: string) => boolean
	/** Reads the account's identity from the harvested credential. */
	readonly fetchIdentity: (
		provider: string,
		credential: string,
	) => Promise<{
		readonly status: string
		readonly email?: string | null
		readonly error?: string | null
	}>
	/** The provider's display name, for a connection the identity probe left unnamed. */
	readonly providerLabel: (provider: string) => string
}

/** What the panel sees after polling a session. */
export interface WebLoginStatus {
	readonly provider: string
	readonly status: string
	readonly profile: string | null
	readonly error: string | null
	readonly connectionId: string | null
	readonly email: string | null
	readonly credentialPreview: string | null
}

export function makeWebLogin(dependencies: WebLoginDependencies) {
	const {
		connections,
		listProviders,
		listProfiles,
		configOf,
		statusOf,
		start,
		cancel,
		fetchIdentity,
		providerLabel,
	} = dependencies

	/** The mutable session object, so a save can record what it wrote. */
	function sessionFor(provider: string): WebLoginSession {
		const session = statusOf(provider)
		if (!session) throw notFound("Login session")
		return session
	}

	/**
	 * Turn a finished login into a stored connection.
	 *
	 * The matching rule is in `domain/web-login.ts`; this reads the rows, decides
	 * which one to refresh, and writes. Every failure marks the session failed
	 * rather than throwing, because a throw here would surface as a 500 on a poll
	 * the panel retries — the operator needs the message, not a retry loop.
	 */
	async function saveHarvested(provider: string, session: WebLoginSession): Promise<void> {
		const credential = session.credential
		if (!credential) {
			session.status = "error"
			session.error = "No credential was captured"
			return
		}
		try {
			const identity = await fetchIdentity(provider, credential)
			const verdict = readIdentityVerdict(identity)
			if (verdict.rejected) {
				session.status = "error"
				session.error = verdict.error
				return
			}

			const email = identity.email || ""
			const name = connectionNameFor(email, providerLabel(provider))
			const providerSpecificData = webLoginProviderData(
				configOf(provider)?.credentialFrom === "localStorageValue",
			)

			const rows = webLoginRowsOf(
				(await connections.list({ provider })) as readonly WebLoginCandidate[],
			)
			const existing = findRefreshTarget(rows, email)

			if (existing) {
				await connections.update(existing.id, {
					apiKey: credential,
					name,
					email: email || existing.email || null,
					providerSpecificData: {
						...(existing.providerSpecificData ?? {}),
						...providerSpecificData,
					},
					testStatus: "active",
					lastError: null,
					lastErrorAt: null,
					isActive: true,
				} as Partial<ConnectionFields>)
				session.savedConnectionId = existing.id
				for (const duplicate of duplicatesOf(rows, existing, email)) {
					await connections.remove(duplicate.id)
				}
			} else {
				const created = await connections.create({
					provider,
					authType: "cookie",
					name,
					email: email || null,
					apiKey: credential,
					priority: 1,
					providerSpecificData,
					isActive: true,
					// Harvested from a live logged-in session, so the credential is known good.
					testStatus: "active",
					allowOverwrite: false,
				} as ConnectionFields)
				session.savedConnectionId = created.id
			}
			session.credential = undefined
		} catch (error) {
			const { code, existingName, message } = error as {
				code?: string
				existingName?: string
				message?: string
			}
			session.status = "error"
			session.error =
				code === "PROVIDER_NAME_CONFLICT" && existingName
					? conflictMessage(existingName)
					: message || "Failed to save connection"
		}
	}

	return {
		/** The providers whose login page can be driven, and the saved profiles. */
		available(): { readonly providers: readonly string[]; readonly profiles: unknown } {
			return { providers: listProviders(), profiles: listProfiles() }
		},

		/**
		 * Poll a session, saving the connection once the login succeeded.
		 *
		 * Saving happens on the poll rather than on the browser callback because the
		 * browser runs in another process: this is the first moment the credential is
		 * in hand and the operator is still waiting.
		 */
		async status(provider: string): Promise<WebLoginStatus> {
			const session = sessionFor(provider)
			if (session.status === "success" && !session.savedConnectionId) {
				await saveHarvested(provider, session)
			}
			return {
				provider,
				status: session.status,
				profile: session.profile ?? null,
				error: session.error ?? null,
				connectionId: session.savedConnectionId ?? null,
				email: session.accountEmail ?? null,
				credentialPreview: credentialPreview(session.credential),
			}
		},

		/** Open the login window. The caller answers 202: the login is not done yet. */
		async begin(request: { readonly provider?: unknown; readonly profile?: unknown }): Promise<{
			readonly provider: string
			readonly profile: string | null
			readonly status: string
		}> {
			const provider = String(request.provider ?? "").trim()
			const profile = String(request.profile ?? "").trim() || "default"
			if (!configOf(provider)) throw invalid(`Web login not supported for "${provider}"`)
			const session = await start(provider, profile)
			return { provider, profile: session.profile ?? null, status: session.status }
		},

		/** Cancel a running session. A session that never existed is not an error. */
		abandon(provider: string | null): { readonly cancelled: boolean } {
			if (!provider) throw invalid("provider is required")
			return { cancelled: cancel(provider) }
		},
	}
}
