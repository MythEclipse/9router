import "server-only"

import { execFile } from "node:child_process"
import { access, constants, readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type {
	CursorImportDeps,
	LocalCredentialDeps,
} from "9router-api/application/oauth/auto-import"
import { isKiroRefreshToken, normalizeKiroArn } from "9router-api/domain/oauth-local-credential"
import { fetchZedAuthenticatedUser, resolveZedOrganizationId } from "open-sse/shared/zedAuth"
import { KiroService } from "@/lib/oauth/services/kiro"
import { readZedIdeCredentials } from "@/lib/oauth/utils/zedCredentials"

/**
 * Where each provider's own tool leaves its credential, and how to read it.
 *
 * The search order and the "not found is not an error" rule live in the use-case. What is
 * here is knowledge of this machine: the vendor's directory names, the file shapes, and
 * the fact that one of them is a directory of files rather than a file.
 */

async function readJson(path: string): Promise<Record<string, unknown> | null> {
	const text = await readFile(path, "utf-8")
	const parsed = JSON.parse(text) as unknown
	return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
}

/** Kiro's IDC metadata, as the dashboard's import form wants it. */
export interface KiroCredential {
	readonly refreshToken: string
	readonly clientId: string | null
	readonly clientSecret: string | null
	readonly region: string | null
	readonly authMethod: string | null
	readonly profileArn: string | null
}

async function kiroProfileArn(): Promise<string | null> {
	const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming")
	const paths = [
		join(appData, "Kiro", "User", "globalStorage", "kiro.kiroagent", "profile.json"),
		join(homedir(), ".config", "Kiro", "User", "globalStorage", "kiro.kiroagent", "profile.json"),
	]

	for (const path of paths) {
		const data = await readJson(path).catch(() => null)
		if (typeof data?.arn === "string") return normalizeKiroArn(data.arn)
	}
	return null
}

/**
 * Kiro keeps its token in a cache of many JSON files, not in one known path.
 *
 * The vendor's own file is tried first, then every other JSON in the cache: the IDE writes a
 * differently-named file per auth method, and a search that only knew the documented name
 * would report "log in first" to a user who is already logged in.
 */
function kiroCandidates(): LocalCredentialDeps<KiroCredential> {
	const cachePath = join(homedir(), ".aws", "sso", "cache")

	return {
		where: "the AWS SSO cache",
		paths: [cachePath],
		read: async () => {
			let files: string[]
			try {
				files = await readdir(cachePath)
			} catch {
				return null
			}

			const ordered = [
				...(files.includes("kiro-auth-token.json") ? ["kiro-auth-token.json"] : []),
				...files.filter((f) => f.endsWith(".json") && f !== "kiro-auth-token.json"),
			]

			for (const file of ordered) {
				const data = await readJson(join(cachePath, file)).catch(() => null)
				if (!data || !isKiroRefreshToken(data.refreshToken)) continue

				// An IDC token names a client registration file; without it the refresh fails
				// later, at the provider, with a message nobody can act on.
				let clientId: string | null = null
				let clientSecret: string | null = null
				if (typeof data.clientIdHash === "string") {
					const client = await readJson(join(cachePath, `${data.clientIdHash}.json`)).catch(() => null)
					if (client && typeof client.clientId === "string" && typeof client.clientSecret === "string") {
						clientId = client.clientId
						clientSecret = client.clientSecret
					}
				}

				return {
					refreshToken: data.refreshToken,
					clientId,
					clientSecret,
					region: typeof data.region === "string" ? data.region : null,
					authMethod: typeof data.authMethod === "string" ? data.authMethod : null,
					profileArn: await kiroProfileArn(),
				}
			}
			return null
		},
	}
}

/** MiMoCode's `auth.json`, in the platform's own directory. */
function mimoCandidates(): LocalCredentialDeps<Record<string, unknown>> {
	const home = homedir()
	const paths = [join(home, ".local", "share", "mimocode", "auth.json")]

	if (process.platform === "win32") {
		const appData = process.env.APPDATA || join(home, "AppData", "Roaming")
		paths.push(join(appData, "Xiaomi MiMo", "auth.json"))
	}
	if (process.platform === "darwin") {
		paths.push(join(home, "Library", "Application Support", "mimocode", "auth.json"))
	}

	return {
		where: "MiMoCode's auth.json",
		paths,
		read: async (path) => {
			const data = await readJson(path).catch(() => null)
			const xiaomi = data?.xiaomi as Record<string, unknown> | undefined
			// An `auth.json` that exists but carries no xiaomi block is not a credential; the
			// search has to keep looking rather than stop on the file's name.
			return typeof xiaomi?.key === "string" ? xiaomi : null
		},
	}
}

/**
 * Zed's session lives in the OS keyring, not in a file — `secret-tool` on Linux, Keychain on
 * macOS, Credential Manager on Windows. `readZedIdeCredentials` already knows the three; the
 * search only needs to know that there is exactly one place, and that a locked keyring is a
 * miss rather than a server error.
 */
function zedCandidates(): LocalCredentialDeps<Record<string, unknown>> {
	return {
		where: "Zed's keyring entry",
		paths: ["keyring:https://zed.dev"],
		read: async () => {
			const read = await readZedIdeCredentials()
			if (!read.found || !read.accessToken) return null
			return {
				userId: read.userId,
				accessToken: read.accessToken,
				systemId: read.systemId,
				credentialsUrl: read.credentialsUrl,
			}
		},
	}
}

/**
 * Cursor keeps its auth in VS Code's `state.vscdb` — a SQLite file, not JSON.
 *
 * The IDE's storage is a plain `itemTable`, read key by key. Values are sometimes JSON
 * encoded strings, so a token can arrive wrapped in quotes; unwrapping is what makes an
 * alias key and an exact key answer the same shape.
 */
const CURSOR_TOKEN_KEYS = ["cursorAuth/accessToken", "cursorAuth/token"] as const
const CURSOR_MACHINE_KEYS = [
	"storage.serviceMachineId",
	"storage.machineId",
	"telemetry.machineId",
] as const

function cursorDbPaths(): string[] {
	const home = homedir()
	if (process.platform === "darwin") {
		return [
			join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
			join(home, "Library/Application Support/Cursor - Insiders/User/globalStorage/state.vscdb"),
		]
	}
	if (process.platform === "win32") {
		const appData = process.env.APPDATA || join(home, "AppData", "Roaming")
		const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local")
		return [
			join(appData, "Cursor", "User", "globalStorage", "state.vscdb"),
			join(appData, "Cursor - Insiders", "User", "globalStorage", "state.vscdb"),
			join(localAppData, "Cursor", "User", "globalStorage", "state.vscdb"),
			join(localAppData, "Programs", "Cursor", "User", "globalStorage", "state.vscdb"),
		]
	}
	// Unknown platforms fall through to POSIX paths rather than erroring: a BSD or WSL
	// install keeps its config in the same place, and refusing outright would help nobody.
	return [
		join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
		join(home, ".config/cursor/User/globalStorage/state.vscdb"),
	]
}

/** VS Code stores some strings JSON-encoded; a token needs the inner string. */
function unwrapValue(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null
	try {
		const parsed = JSON.parse(value)
		return typeof parsed === "string" ? parsed : value
	} catch {
		return value
	}
}

/**
 * Read both values out of the database through the bundled binding.
 *
 * `better-sqlite3` is loaded dynamically: it is a native binding, and an install without it
 * should lose this strategy, not fail to start the process. Read-only — this is another
 * application's file.
 */
async function cursorViaBinding(path: string): Promise<Record<string, unknown>> {
	const { default: Database } = await import("better-sqlite3")
	const db = new Database(path, { readonly: true, fileMustExist: true })
	try {
		const statement = db.prepare("SELECT value FROM itemTable WHERE key=? LIMIT 1")
		const read = (keys: readonly string[]): string | null => {
			for (const key of keys) {
				const row = statement.get(key) as { value?: unknown } | undefined
				const value = unwrapValue(row?.value)
				if (value) return value
			}
			return null
		}
		return {
			accessToken: read(CURSOR_TOKEN_KEYS),
			machineId: read(CURSOR_MACHINE_KEYS),
		}
	} finally {
		db.close()
	}
}

/** The same two values through the `sqlite3` binary, for installs without the binding. */
async function cursorViaCli(path: string): Promise<Record<string, unknown>> {
	const execFileAsync = promisify(execFile)
	const read = async (keys: readonly string[]): Promise<string | null> => {
		for (const key of keys) {
			const { stdout } = await execFileAsync(
				"sqlite3",
				[path, `SELECT value FROM itemTable WHERE key='${key}' LIMIT 1`],
				{ timeout: 10_000 },
			)
			const value = unwrapValue(stdout.trim())
			if (value) return value
		}
		return null
	}
	return {
		accessToken: await read(CURSOR_TOKEN_KEYS),
		machineId: await read(CURSOR_MACHINE_KEYS),
	}
}

/** Linux only: a readable config with no IDE behind it is a leftover, not a login. */
async function cursorInstalled(): Promise<boolean> {
	const execFileAsync = promisify(execFile)
	try {
		await execFileAsync("which", ["cursor"], { timeout: 5_000 })
		return true
	} catch {
		return access(join(homedir(), ".local/share/applications/cursor.desktop"), constants.R_OK).then(
			() => true,
			() => false,
		)
	}
}

function cursorCandidates(): LocalCredentialDeps<Record<string, unknown>> {
	return {
		where: "Cursor's state database",
		paths: cursorDbPaths(),
		// Reachable through the ladder in the use-case; the plain search is not used here.
		read: async () => null,
	}
}

export const AUTO_IMPORT_HOSTS = {
	kiro: kiroCandidates,
	"xiaomi-mimo": mimoCandidates,
	zed: zedCandidates,
	cursor: cursorCandidates,
} as const

export type AutoImportProvider = keyof typeof AUTO_IMPORT_HOSTS

/**
 * Cursor's three-strategy read, assembled from this machine.
 *
 * Cursor is the one provider whose search is a ladder rather than a single read, so it gets
 * its own builder instead of the `AUTO_IMPORT_HOSTS` table.
 */
export function cursorImportDeps(): CursorImportDeps {
	return {
		candidates: cursorDbPaths(),
		readable: (path) =>
			access(path, constants.R_OK).then(
				() => true,
				() => false,
			),
		installed: process.platform === "linux" ? cursorInstalled : undefined,
		readViaBinding: cursorViaBinding,
		readViaCli: cursorViaCli,
	}
}

/**
 * Proving a pasted token works, per provider.
 *
 * Each of these calls the provider's own API — the same call the OAuth flow makes at the end
 * of a login — so an imported connection is exactly as valid as one obtained by signing in.
 * A failure throws: the use-case decides whether that is the operator's token (401) or the
 * provider being down (502).
 */
export const TOKEN_VERIFIERS: Record<
	string,
	import("9router-api/application/oauth/import-token").ImportTokenDeps["verify"]
> = {
	kiro: async ({ accessToken, providerSpecificData }) => {
		const service = new KiroService()
		const refreshed = await service.refreshToken(accessToken, providerSpecificData)
		return {
			accessToken: refreshed.accessToken,
			refreshToken: refreshed.refreshToken || accessToken,
			expiresIn: refreshed.expiresIn,
			email: service.extractEmailFromJWT(refreshed.accessToken),
			providerSpecificData: { profileArn: refreshed.profileArn ?? null },
		}
	},
	zed: async ({ accessToken, providerSpecificData }) => {
		const credentials = { accessToken, providerSpecificData }
		const user = await fetchZedAuthenticatedUser(credentials)
		const userId = String(providerSpecificData.userId ?? "")
		return {
			accessToken,
			email: user?.email ?? null,
			providerSpecificData: {
				userId,
				systemId: providerSpecificData.systemId,
				organizationId: resolveZedOrganizationId(credentials, user),
				name: user?.name || user?.display_name || user?.username || `Zed ${userId}`,
			},
		}
	},
	cursor: async ({ accessToken }) => {
		const user = await fetchCursorAuthenticatedUser(accessToken)
		return { accessToken, email: user?.email ?? null }
	},
}

/** Zed's current user, used to name the connection after a real person. */
async function fetchCursorAuthenticatedUser(
	accessToken: string,
): Promise<{ email?: string | null } | null> {
	const response = await fetch("https://api2.cursor.sh/auth/full_stripe_profile", {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (!response.ok) {
		throw Object.assign(new Error("Cursor rejected the token"), {
			status: response.status === 403 ? 401 : response.status,
		})
	}
	return (await response.json()) as { email?: string | null }
}

/**
 * Checking a long-lived key against the provider, best-effort.
 *
 * A check that cannot run is not a rejection: the operator may be behind a network that
 * blocks the provider, and the row records `untested` so the dashboard can offer a retest
 * later. Only a key the provider actively refused is worth refusing to store.
 */
export const API_KEY_CHECKS: Record<
	string,
	import("9router-api/application/oauth/import-api-key").ApiKeyImportDeps["check"]
> = {
	kiro: async ({ apiKey, region }) => {
		const service = new KiroService()
		const credential = await service.validateApiKey(apiKey, region)
		return {
			validated: true,
			modelCount: 0,
			accessToken: credential.accessToken,
			email: service.extractEmailFromJWT(credential.accessToken),
			providerSpecificData: {
				...(credential.profileArn ? { profileArn: credential.profileArn } : {}),
				region: credential.region,
			},
		}
	},
	"xiaomi-mimo": async ({ apiKey, region }) => {
		const baseUrl = "https://api.xiaomimimo.com/v1"
		const response = await fetch(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${apiKey}`, "X-Mimo-Source": "mimocode-cli" },
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) return { validated: false, modelCount: 0, accessToken: apiKey }
		const data = (await response.json()) as { data?: unknown[] }
		const models = Array.isArray(data?.data) ? data.data : []
		return {
			validated: true,
			modelCount: models.length,
			accessToken: apiKey,
			providerSpecificData: { region },
		}
	},
}
