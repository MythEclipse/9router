/**
 * GET /api/oauth/commandcode/auto-import, exercised through the real layering.
 *
 * The route is a thin oRPC call; everything that can be wrong lives in the host reader
 * (`oauthImportHost`'s commandcode entry) and in the shared search (`autoImportLocalCredential`).
 * So the cases drive the host reader against a real temp HOME instead of mocking fs — an
 * auto-import that "works" against a mocked fs has proven nothing about what the CLI
 * actually writes.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { autoImportLocalCredential } from "../../apps/api/src/application/oauth/auto-import.ts"
import { providerNameOf } from "../../apps/api/src/domain/oauth-local-credential.ts"
import { AUTO_IMPORT_HOSTS } from "../../apps/web/src/lib/oauthImportHost.ts"

interface Host {
	readonly where: string
	readonly paths: readonly string[]
	readonly read: (path: string) => Promise<Record<string, unknown> | null>
}

// Each entry is a factory, so paths are resolved against the HOME in force when it is
// called — which is why these cases can move HOME per test without re-importing.
const hosts = AUTO_IMPORT_HOSTS as unknown as Record<string, () => Host>

/** The commandcode host, built against the HOME this test set. */
function host(): Host {
	return hosts.commandcode()
}

let home: string
let savedHome: string | undefined
let savedAppData: string | undefined

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "9r-commandcode-"))
	savedHome = process.env.HOME
	savedAppData = process.env.APPDATA
	process.env.HOME = home
})

afterEach(async () => {
	if (savedHome === undefined) delete process.env.HOME
	else process.env.HOME = savedHome
	if (savedAppData === undefined) delete process.env.APPDATA
	else process.env.APPDATA = savedAppData
	await rm(home, { recursive: true, force: true })
})

async function writeAuth(contents: unknown) {
	const dir = join(home, ".commandcode")
	await mkdir(dir, { recursive: true })
	await writeFile(
		join(dir, "auth.json"),
		typeof contents === "string" ? contents : JSON.stringify(contents),
	)
}

describe("commandcode auto-import host", () => {
	it("registers under the provider id the route asks for", () => {
		expect(Object.keys(hosts)).toContain("commandcode")
	})

	it("names the CLI and its file in the miss message", () => {
		expect(host().where).toBe("Command Code's auth.json")
		expect(providerNameOf("commandcode")).toBe("Command Code")
	})

	it("looks in ~/.commandcode/auth.json", () => {
		expect(host().paths).toContain(join(home, ".commandcode", "auth.json"))
	})

	it("answers the key and the account that minted it", async () => {
		await writeAuth({
			apiKey: "user_abc123xyz",
			userId: "usr_456",
			userName: "Alwa Dev",
			keyName: "default",
			authenticatedAt: "2026-11-08T15:30:00.000Z",
		})
		const read = await host().read(join(home, ".commandcode", "auth.json"))
		expect(read).toEqual({
			apiKey: "user_abc123xyz",
			userId: "usr_456",
			userName: "Alwa Dev",
			keyName: "default",
			authenticatedAt: "2026-11-08T15:30:00.000Z",
		})
	})

	it("treats a file without a key as a miss, not as a credential", async () => {
		await writeAuth({ userId: "usr_456" })
		expect(await host().read(join(home, ".commandcode", "auth.json"))).toBeNull()
	})

	it("treats a blank key as a miss", async () => {
		await writeAuth({ apiKey: "   " })
		expect(await host().read(join(home, ".commandcode", "auth.json"))).toBeNull()
	})

	it("trims the key the CLI wrote", async () => {
		await writeAuth({ apiKey: "  user_trimmed\n" })
		const read = await host().read(join(home, ".commandcode", "auth.json"))
		expect(read?.apiKey).toBe("user_trimmed")
	})

	it("answers null for malformed JSON rather than throwing", async () => {
		await writeAuth("{not json")
		expect(await host().read(join(home, ".commandcode", "auth.json"))).toBeNull()
	})
})

describe("autoImportLocalCredential for commandcode", () => {
	it("reports found:false with the action to take when the CLI never ran", async () => {
		const result = await autoImportLocalCredential({ provider: "commandcode" }, host())
		expect(result.found).toBe(false)
		if (!result.found) {
			expect(result.error).toBe(
				"Command Code token not found in Command Code's auth.json. Please log in to Command Code first.",
			)
		}
	})

	it("finds the key and names the file it came from", async () => {
		await writeAuth({ apiKey: "user_abc123xyz", userName: "Alwa Dev" })
		const result = await autoImportLocalCredential({ provider: "commandcode" }, await host())
		expect(result.found).toBe(true)
		if (result.found) {
			expect(result.source).toBe(join(home, ".commandcode", "auth.json"))
			expect((result.credential as { apiKey: string }).apiKey).toBe("user_abc123xyz")
		}
	})
})
