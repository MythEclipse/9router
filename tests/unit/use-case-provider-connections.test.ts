import { describe, expect, it } from "vitest"
import { makeConnections } from "../../apps/api/src/application/providers/manage-connections.ts"
import type {
	ConnectionFields,
	ConnectionNode,
	StoredConnection,
} from "../../apps/api/src/application/providers/ports.ts"

const NODES: ConnectionNode[] = [
	{
		id: "ocg",
		prefix: "ocg",
		apiType: "openai",
		baseUrl: "https://ocg.example/v1",
		name: "OCG Node",
		quotaEnabled: true,
		quotaPath: "/quota",
	},
	{
		id: "acg",
		prefix: "acg",
		baseUrl: "https://acg.example",
		name: "ACG Node",
		quotaEnabled: false,
	},
	{
		id: "emb",
		prefix: "emb",
		baseUrl: "https://emb.example/v1",
		name: "Embedding Node",
		quotaEnabled: true,
		quotaPath: "/credits",
	},
]

interface Harness {
	readonly connections: ReturnType<typeof makeConnections>
	readonly stored: StoredConnection[]
	readonly created: ConnectionFields[]
	calls: { readonly proxyPoolChecks: string[] }
}

function harness(
	options: {
		readonly seed?: StoredConnection[]
		readonly existingPools?: string[]
		readonly nodes?: ConnectionNode[]
	} = {},
): Harness {
	const stored: StoredConnection[] = [...(options.seed ?? [])]
	const created: ConnectionFields[] = []
	const calls = { proxyPoolChecks: [] as string[] }
	const nodeList = options.nodes ?? NODES
	let nextId = stored.length + 1

	const connections = makeConnections({
		connections: {
			async list(filter) {
				if (filter?.provider) return stored.filter((c) => c.provider === filter.provider)
				return stored
			},
			async find(id) {
				return stored.find((c) => c.id === id) ?? null
			},
			async create(fields) {
				created.push(fields)
				const row: StoredConnection = {
					...fields,
					id: `new-${nextId++}`,
					provider: fields.provider ?? "",
					authType: fields.authType ?? null,
					name: fields.name ?? null,
				}
				stored.push(row)
				return row
			},
			async update(id, fields) {
				const index = stored.findIndex((c) => c.id === id)
				if (index === -1) return null
				stored[index] = { ...stored[index], ...fields }
				return stored[index]
			},
			async remove(id) {
				const index = stored.findIndex((c) => c.id === id)
				if (index === -1) return false
				stored.splice(index, 1)
				return true
			},
		},
		nodes: {
			async find(id) {
				return nodeList.find((n) => n.id === id) ?? null
			},
			async list() {
				return nodeList
			},
		},
		pools: {
			async exists(id) {
				calls.proxyPoolChecks.push(id)
				return (options.existingPools ?? []).includes(id)
			},
		},
		catalogue: {
			label: (provider) => ({ gemini: "Gemini", ocg: "OCG Node" })[provider] ?? provider,
			isOpenAICompatible: (p) => p === "ocg",
			isAnthropicCompatible: (p) => p === "acg",
			isCustomEmbedding: (p) => p === "emb",
			isWebCookie: (p) => p === "gemini-web",
			apiKeySubstituteField: (p) => (p === "bedrock" ? "profile" : null),
			isCreatable: (p) =>
				["gemini", "ocg", "acg", "emb", "bedrock", "gemini-web", "ollama-local"].includes(p),
			usesAwsCredentialForm: (p) => p === "bedrock",
		},
		normalizeProviderId: (provider) =>
			String(provider ?? "")
				.trim()
				.toLowerCase(),
		normalizeProviderSpecificData: (_provider, _body, psd) => ({
			...((psd as Record<string, unknown> | undefined) ?? {}),
		}),
		toResponse: (connection) => {
			const { apiKey: _key, ...safe } = connection
			return safe
		},
	})

	return { connections, stored, created, calls }
}

describe("list", () => {
	it("names a compatible connection after its node when it has no name", async () => {
		const h = harness({
			seed: [{ id: "1", provider: "ocg", providerSpecificData: {} }],
		})
		const [row] = await h.connections.list()
		expect(row.name).toBe("OCG Node")
	})

	it("falls back to the node name stored on the connection", async () => {
		const h = harness({
			seed: [
				{
					id: "1",
					provider: "ocg",
					providerSpecificData: { nodeName: "Stored Node Name" },
				},
			],
			nodes: [],
		})
		const [row] = await h.connections.list()
		expect(row.name).toBe("Stored Node Name")
	})

	it("keeps an explicit name over the node name", async () => {
		const h = harness({ seed: [{ id: "1", provider: "ocg", name: "My Key" }] })
		const [row] = await h.connections.list()
		expect(row.name).toBe("My Key")
	})

	it("leaves a built-in provider's name alone", async () => {
		const h = harness({ seed: [{ id: "1", provider: "gemini" }] })
		const [row] = await h.connections.list()
		expect(row.name).toBeUndefined()
	})

	it("strips the api key from every row", async () => {
		const h = harness({ seed: [{ id: "1", provider: "gemini", apiKey: "secret" }] })
		const [row] = await h.connections.list()
		expect(row.apiKey).toBeUndefined()
	})
})

describe("create", () => {
	it("rejects an unknown provider", async () => {
		const h = harness()
		await expect(h.connections.create({ provider: "nope", apiKey: "k" })).rejects.toThrow(
			"Invalid provider",
		)
	})

	it("rejects a missing api key", async () => {
		const h = harness()
		await expect(h.connections.create({ provider: "gemini" })).rejects.toThrow("API Key is required")
	})

	it("asks for a cookie value when the provider stores a cookie", async () => {
		const h = harness()
		await expect(h.connections.create({ provider: "gemini-web" })).rejects.toThrow(
			"Cookie value is required",
		)
	})

	it("allows ollama-local with no key", async () => {
		const h = harness()
		const row = await h.connections.create({ provider: "ollama-local" })
		expect(row.provider).toBe("ollama-local")
	})

	it("allows a key substitute field to stand in for the key", async () => {
		const h = harness()
		const row = await h.connections.create({
			provider: "bedrock",
			providerSpecificData: { profile: "work" },
		})
		expect(row.provider).toBe("bedrock")
	})

	it("writes authType cookie for a web-cookie provider", async () => {
		const h = harness()
		await h.connections.create({ provider: "gemini-web", apiKey: "cookie" })
		expect(h.created[0].authType).toBe("cookie")
	})

	it("writes authType apikey for everyone else", async () => {
		const h = harness()
		await h.connections.create({ provider: "gemini", apiKey: "k" })
		expect(h.created[0].authType).toBe("apikey")
	})

	it("copies the node's base url for an openai-compatible provider", async () => {
		const h = harness()
		await h.connections.create({ provider: "ocg", apiKey: "k" })
		expect(h.created[0].providerSpecificData).toMatchObject({
			prefix: "ocg",
			apiType: "openai",
			baseUrl: "https://ocg.example/v1",
			nodeName: "OCG Node",
			quotaEnabled: true,
			quotaPath: "/quota",
		})
	})

	it("defaults an anthropic node's quota path to /credits", async () => {
		const h = harness()
		await h.connections.create({ provider: "acg", apiKey: "k" })
		expect(h.created[0].providerSpecificData).toMatchObject({
			baseUrl: "https://acg.example",
			quotaEnabled: false,
			quotaPath: "/credits",
		})
	})

	it("does not copy quota settings onto a custom embedding connection", async () => {
		const h = harness()
		await h.connections.create({ provider: "emb", apiKey: "k" })
		// Deliberate: quota lives on the node, and an embedding node has none.
		// Pinned so a future refactor of `nodeFields` cannot quietly start copying it.
		expect(h.created[0].providerSpecificData).toMatchObject({
			prefix: "emb",
			baseUrl: "https://emb.example/v1",
			nodeName: "Embedding Node",
		})
		expect(h.created[0].providerSpecificData).not.toHaveProperty("quotaEnabled")
		expect(h.created[0].providerSpecificData).not.toHaveProperty("quotaPath")
	})

	it("404s when the compatible node is missing", async () => {
		const h = harness({ nodes: [] })
		await expect(h.connections.create({ provider: "ocg", apiKey: "k" })).rejects.toThrow(
			"OpenAI Compatible node not found",
		)
	})

	it("names the first key with ordinal 1", async () => {
		const h = harness()
		await h.connections.create({ provider: "gemini", apiKey: "k1" })
		expect(h.created[0].name).toBe("Gemini #1")
	})

	it("names the next key with the next free ordinal", async () => {
		const h = harness({
			seed: [{ id: "1", provider: "gemini", name: "Gemini #1", apiKey: "old" }],
		})
		await h.connections.create({ provider: "gemini", apiKey: "k2" })
		expect(h.created[0].name).toBe("Gemini #2")
	})

	it("reuses the ordinal when the same key is added again", async () => {
		const h = harness({
			seed: [{ id: "1", provider: "gemini", name: "Gemini #3", apiKey: "same" }],
		})
		await h.connections.create({ provider: "gemini", apiKey: "same" })
		expect(h.created[0].name).toBe("Gemini #3")
	})

	it("prefers an explicit name", async () => {
		const h = harness()
		await h.connections.create({ provider: "gemini", apiKey: "k", name: " Work key " })
		expect(h.created[0].name).toBe("Work key")
	})

	it("refuses a proxy with no url", async () => {
		const h = harness()
		await expect(
			h.connections.create({ provider: "gemini", apiKey: "k", connectionProxyEnabled: true }),
		).rejects.toThrow("Connection proxy URL is required when connection proxy is enabled")
	})

	it("does not disable a proxy the body never mentioned", async () => {
		const h = harness()
		await h.connections.create({ provider: "gemini", apiKey: "k" })
		// The old create copy wrote `enabled: false` here, wiping a stored proxy.
		expect(h.created[0].providerSpecificData).not.toHaveProperty("connectionProxyEnabled")
	})

	it("writes the proxy when the body states it", async () => {
		const h = harness()
		await h.connections.create({
			provider: "gemini",
			apiKey: "k",
			connectionProxyEnabled: true,
			connectionProxyUrl: "http://p:8080",
		})
		expect(h.created[0].providerSpecificData).toMatchObject({
			connectionProxyEnabled: true,
			connectionProxyUrl: "http://p:8080",
			connectionNoProxy: "",
		})
	})

	it("refuses a proxy pool that does not exist", async () => {
		const h = harness({ existingPools: [] })
		await expect(
			h.connections.create({ provider: "gemini", apiKey: "k", proxyPoolId: "ghost" }),
		).rejects.toThrow("Proxy pool not found")
	})

	it("writes a proxy pool that exists", async () => {
		const h = harness({ existingPools: ["pool-1"] })
		await h.connections.create({ provider: "gemini", apiKey: "k", proxyPoolId: "pool-1" })
		expect(h.created[0].providerSpecificData).toMatchObject({ proxyPoolId: "pool-1" })
	})

	it("does not check a pool the body never mentioned", async () => {
		const h = harness()
		await h.connections.create({ provider: "gemini", apiKey: "k" })
		expect(h.calls.proxyPoolChecks).toEqual([])
	})
})

describe("get", () => {
	it("404s an unknown id", async () => {
		const h = harness()
		await expect(h.connections.get("ghost")).rejects.toThrow("Connection not found")
	})

	it("returns the row without its key", async () => {
		const h = harness({ seed: [{ id: "1", provider: "gemini", apiKey: "secret" }] })
		const row = await h.connections.get("1")
		expect(row.apiKey).toBeUndefined()
	})
})

describe("update", () => {
	const seed = (): StoredConnection[] => [
		{
			id: "1",
			provider: "gemini",
			authType: "apikey",
			name: "Old",
			apiKey: "old-key",
			providerSpecificData: {
				connectionProxyEnabled: true,
				connectionProxyUrl: "http://old:8080",
				proxyPoolId: "pool-old",
				keep: "me",
			},
		},
	]

	it("404s an unknown id", async () => {
		const h = harness()
		await expect(h.connections.update("ghost", {})).rejects.toThrow("Connection not found")
	})

	it("writes only the fields the body carried", async () => {
		const h = harness({ seed: seed() })
		const row = await h.connections.update("1", { name: "New" })
		expect(row.name).toBe("New")
		expect(h.stored[0].priority).toBeUndefined()
	})

	it("leaves a stored proxy alone when the body mentions no proxy field", async () => {
		const h = harness({ seed: seed() })
		const row = await h.connections.update("1", { name: "New" })
		const psd = row.providerSpecificData as Record<string, unknown>
		expect(psd.connectionProxyEnabled).toBe(true)
		expect(psd.connectionProxyUrl).toBe("http://old:8080")
	})

	it("leaves a stored pool alone when the body sends no pool", async () => {
		const h = harness({ seed: seed() })
		const row = await h.connections.update("1", { name: "New" })
		expect((row.providerSpecificData as Record<string, unknown>).proxyPoolId).toBe("pool-old")
	})

	it("clears the pool on the __none__ sentinel, removing the key", async () => {
		const h = harness({ seed: seed() })
		const row = await h.connections.update("1", { proxyPoolId: "__none__" })
		const psd = row.providerSpecificData as Record<string, unknown>
		expect("proxyPoolId" in psd).toBe(false)
		expect(psd.keep).toBe("me")
	})

	it("refuses enabling a proxy with no url", async () => {
		const h = harness({ seed: seed() })
		await expect(
			h.connections.update("1", { connectionProxyEnabled: true, connectionProxyUrl: "" }),
		).rejects.toThrow("Connection proxy URL is required when connection proxy is enabled")
	})

	it("replaces the key only on an apikey connection", async () => {
		const h = harness({ seed: seed() })
		await h.connections.update("1", { apiKey: "new-key" })
		expect(h.stored[0].apiKey).toBe("new-key")
	})

	it("ignores a key sent for an oauth connection", async () => {
		const h = harness({
			seed: [{ id: "1", provider: "gemini", authType: "oauth", apiKey: "token" }],
		})
		await h.connections.update("1", { apiKey: "attempt" })
		expect(h.stored[0].apiKey).toBe("token")
	})

	it("keeps unrelated provider data while writing new provider data", async () => {
		const h = harness({ seed: seed() })
		const row = await h.connections.update("1", { providerSpecificData: { added: 1 } })
		const psd = row.providerSpecificData as Record<string, unknown>
		expect(psd).toMatchObject({ keep: "me", added: 1 })
	})
})

describe("remove", () => {
	it("removes an existing connection", async () => {
		const h = harness({ seed: [{ id: "1", provider: "gemini" }] })
		await expect(h.connections.remove("1")).resolves.toEqual({ removed: true })
		expect(h.stored).toHaveLength(0)
	})

	it("404s an unknown id", async () => {
		const h = harness()
		await expect(h.connections.remove("ghost")).rejects.toThrow("Connection not found")
	})
})

describe("update: the write-only AWS session token", () => {
	const bedrockSeed = (): StoredConnection[] => [
		{
			id: "1",
			provider: "bedrock",
			authType: "apikey",
			name: "AWS",
			providerSpecificData: { sessionToken: "saved", profile: "work" },
		},
	]

	it("keeps the saved token when the form sends it blank", async () => {
		const h = harness({ seed: bedrockSeed() })
		const row = await h.connections.update("1", {
			providerSpecificData: { sessionToken: "" },
		})
		// The form cannot read the token back, so every edit sends it empty.
		expect((row.providerSpecificData as Record<string, unknown>).sessionToken).toBe("saved")
	})

	it("removes the saved token when the edit clears it explicitly", async () => {
		const h = harness({ seed: bedrockSeed() })
		const row = await h.connections.update("1", {
			providerSpecificData: { sessionToken: null },
		})
		expect(row.providerSpecificData).not.toHaveProperty("sessionToken")
	})

	it("keeps the token when the field is not mentioned at all", async () => {
		const h = harness({ seed: bedrockSeed() })
		const row = await h.connections.update("1", { name: "renamed" })
		expect((row.providerSpecificData as Record<string, unknown>).sessionToken).toBe("saved")
	})

	it("leaves a non-AWS provider's same-named field alone", async () => {
		const h = harness({
			seed: [
				{
					id: "1",
					provider: "gemini",
					authType: "apikey",
					providerSpecificData: { sessionToken: "saved" },
				},
			],
		})
		const row = await h.connections.update("1", {
			providerSpecificData: { sessionToken: "" },
		})
		expect((row.providerSpecificData as Record<string, unknown>).sessionToken).toBe("")
	})
})
