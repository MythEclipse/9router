import { describe, expect, it } from "vitest"
import { autoImportLocalCredential } from "../../apps/api/src/application/oauth/auto-import.ts"
import {
	candidatePaths,
	firstUsable,
	isKiroRefreshToken,
	normalizeKiroArn,
	notFoundMessage,
	providerNameOf,
} from "../../apps/api/src/domain/oauth-local-credential.ts"

describe("candidatePaths", () => {
	it("keeps the order it was given, because priority is the whole point", () => {
		expect(candidatePaths(["a", "b"])).toEqual(["a", "b"])
	})

	it("drops the empty slots a platform switch leaves behind", () => {
		expect(candidatePaths([null, "a", undefined, "", "b"])).toEqual(["a", "b"])
	})
})

describe("firstUsable", () => {
	it("answers the first path that has something", async () => {
		const hit = await firstUsable(["a", "b"], async (path) => (path === "b" ? { token: "t" } : null))
		expect(hit).toEqual({ source: "b", credential: { token: "t" } })
	})

	it("stops at the first hit rather than reading the rest", async () => {
		const read: string[] = []
		await firstUsable(["a", "b", "c"], async (path) => {
			read.push(path)
			return path === "a" ? { token: "t" } : null
		})
		expect(read).toEqual(["a"])
	})

	it("keeps looking when a file exists but holds no credential", async () => {
		const hit = await firstUsable(["a", "b"], async (path) => (path === "b" ? { token: "t" } : null))
		expect(hit?.source).toBe("b")
	})

	it("treats an unreadable file as a miss, not a failure", async () => {
		const hit = await firstUsable(["a", "b"], async (path) => {
			if (path === "a") throw new Error("EACCES")
			return { token: "t" }
		})
		expect(hit?.source).toBe("b")
	})

	it("answers nothing when every candidate misses", async () => {
		expect(await firstUsable(["a", "b"], async () => null)).toBeNull()
		expect(await firstUsable([], async () => ({ token: "t" }))).toBeNull()
	})
})

describe("autoImportLocalCredential", () => {
	it("answers where it found the credential, so the screen can say so", async () => {
		const result = await autoImportLocalCredential(
			{ provider: "Zed" },
			{
				where: "Zed's keyring entry",
				paths: ["keyring:https://zed.dev"],
				read: async () => ({ token: "t" }),
			},
		)
		expect(result).toEqual({
			found: true,
			source: "keyring:https://zed.dev",
			credential: { token: "t" },
		})
	})

	it("answers a miss as advice, not as an error status", async () => {
		const result = await autoImportLocalCredential(
			{ provider: "Kiro" },
			{ where: "the AWS SSO cache", paths: ["/nowhere"], read: async () => null },
		)
		expect(result.found).toBe(false)
		expect(result).toEqual({
			found: false,
			error: "Kiro token not found in the AWS SSO cache. Please log in to Kiro first.",
		})
	})

	it("still names somewhere when the host did not say where it looked", async () => {
		const result = await autoImportLocalCredential(
			{ provider: "Cursor" },
			{ paths: ["/nowhere"], read: async () => null },
		)
		expect(result).toEqual({
			found: false,
			error: "Cursor token not found in this machine. Please log in to Cursor first.",
		})
	})
})

describe("notFoundMessage", () => {
	it("names the provider and where it looked", () => {
		expect(notFoundMessage("Cursor", "Cursor's storage")).toBe(
			"Cursor token not found in Cursor's storage. Please log in to Cursor first.",
		)
	})
})

describe("normalizeKiroArn", () => {
	it("moves the ARN to the region the runtime accepts", () => {
		expect(normalizeKiroArn("arn:aws:codewhisperer:eu-west-1:123:profile/ABC")).toBe(
			"arn:aws:codewhisperer:us-east-1:123:profile/ABC",
		)
	})

	it("leaves an ARN that is not a CodeWhisperer profile untouched", () => {
		const other = "arn:aws:iam::123:role/R"
		expect(normalizeKiroArn(other)).toBe(other)
	})
})

describe("isKiroRefreshToken", () => {
	it("accepts only the IDC token prefix", () => {
		expect(isKiroRefreshToken("aorAAAAAGxyz")).toBe(true)
	})

	it("refuses the other token shapes the IDE writes into the same cache", () => {
		expect(isKiroRefreshToken("eyJhbGciOi")).toBe(false)
		expect(isKiroRefreshToken("")).toBe(false)
		expect(isKiroRefreshToken(null)).toBe(false)
		expect(isKiroRefreshToken(42)).toBe(false)
	})
})

describe("providerNameOf", () => {
	it("gives the name a person would write, not the route's slug", () => {
		expect(providerNameOf("xiaomi-mimo")).toBe("MiMoCode")
		expect(providerNameOf("kiro")).toBe("Kiro")
	})

	it("capitalises a slug that has no listed name rather than leaving it lowercase", () => {
		expect(providerNameOf("cline")).toBe("Cline")
	})
})
