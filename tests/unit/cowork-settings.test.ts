import { describe, expect, it } from "vitest"
import {
	bareToolNames,
	COWORK_PROVIDER,
	coworkHasThisInstall,
	normaliseCoworkModels,
	normaliseCustomPlugins,
	readCoworkModels,
	skipApprovalsFor,
	withInjectedAuth,
} from "../../apps/api/src/domain/cowork-settings.ts"

/**
 * These rules were previously inline in the route and had no tests at all, so each case below
 * stands for a bug that could only be noticed by opening Claude Desktop and looking.
 */

describe("readCoworkModels", () => {
	it("reads both the object form the writer emits and the string form older writes left", () => {
		const config = { inferenceModels: [{ name: "a" }, "b", { name: "" }, {}] } as never
		// A reader that only understood one shape would report an applied config as model-less.
		expect(readCoworkModels(config)).toEqual(["a", "b"])
	})

	it("answers an empty list rather than throwing for a missing config", () => {
		expect(readCoworkModels(null)).toEqual([])
		expect(readCoworkModels({} as never)).toEqual([])
	})
})

describe("coworkHasThisInstall", () => {
	it("needs both the gateway provider and a base url", () => {
		expect(coworkHasThisInstall(null)).toBe(false)
		expect(coworkHasThisInstall({ inferenceProvider: COWORK_PROVIDER } as never)).toBe(false)
		expect(coworkHasThisInstall({ inferenceGatewayBaseUrl: "http://x" } as never)).toBe(false)
		expect(
			coworkHasThisInstall({
				inferenceProvider: COWORK_PROVIDER,
				inferenceGatewayBaseUrl: "http://x",
			} as never),
		).toBe(true)
	})
})

describe("normaliseCoworkModels", () => {
	it("drops the blank entries a form sends when the last model is removed", () => {
		// Refusing these one by one would blame the model field for an empty form.
		expect(normaliseCoworkModels(["a", "  ", "", "b"])).toEqual(["a", "b"])
		expect(normaliseCoworkModels(undefined)).toEqual([])
		expect(normaliseCoworkModels("a")).toEqual([])
	})
})

describe("normaliseCustomPlugins", () => {
	it("keeps url-backed plugins and drops stdio commands", () => {
		const plugins = [
			{ name: "remote", url: "https://mcp.example.com/sse", transport: "sse" },
			{ name: "local", command: "npx", args: ["-y", "thing"] },
			{ name: "no-url", url: "" },
			null,
		]
		// A stdio entry must never reach the writer: it would spawn a process from a text field.
		expect(normaliseCustomPlugins(plugins)).toEqual([
			{ name: "remote", url: "https://mcp.example.com/sse", transport: "sse" },
		])
	})
})

describe("skipApprovalsFor", () => {
	it("maps one true per managed server name", () => {
		expect(skipApprovalsFor([{ name: "exa" }, { name: "browsermcp" }] as never)).toEqual({
			exa: true,
			browsermcp: true,
		})
	})
})

describe("bareToolNames", () => {
	it("strips the prefix the writer adds, so a re-apply does not multiply the list", () => {
		const keys = ["web_search_exa", "exa-web_search_exa", "exa-exa-web_search_exa", "fetch"]
		expect(bareToolNames("exa", keys)).toEqual(["web_search_exa", "fetch"])
	})
})

describe("withInjectedAuth", () => {
	const options = {
		localBridgePrefix: "http://localhost:20128/api/mcp/",
		cliTokenHeader: "x-9r-cli-token",
		token: "secret",
	}

	it("adds the token only to entries pointing at this install's own bridge", () => {
		const servers = [
			{ name: "local", url: "http://localhost:20128/api/mcp/browsermcp/sse", transport: "sse" },
			{ name: "remote", url: "https://mcp.exa.ai/mcp", transport: "http" },
		]
		const written = withInjectedAuth(servers as never, options)
		// Handing our token to a third-party server would leak a credential it never asked for.
		expect(written[0]?.headers).toEqual({ "x-9r-cli-token": "secret" })
		expect(written[1]?.headers).toBeUndefined()
	})

	it("keeps headers the entry already had", () => {
		const servers = [
			{
				name: "local",
				url: "http://localhost:20128/api/mcp/x/sse",
				transport: "sse",
				headers: { existing: "1" },
			},
		]
		expect(withInjectedAuth(servers as never, options)[0]?.headers).toEqual({
			existing: "1",
			"x-9r-cli-token": "secret",
		})
	})

	it("does not mutate the entries it was given", () => {
		const servers = [{ name: "local", url: "http://localhost:20128/api/mcp/x/sse", transport: "sse" }]
		withInjectedAuth(servers as never, options)
		expect(servers[0]).not.toHaveProperty("headers")
	})
})
