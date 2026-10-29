import { describe, expect, it } from "vitest"

import { makeProviderNodes } from "../../apps/api/src/application/models/manage-provider-nodes.ts"
import type {
	ProviderConnectionPort,
	ProviderNodePort,
	ProviderNodeRow,
} from "../../apps/api/src/application/models/ports.ts"

function harness(initial: ProviderNodeRow[] = []) {
	const nodes = [...initial]
	const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
	const connectionPatches: Array<{ id: string; patch: Record<string, unknown> }> = []
	const removedConnections: string[] = []

	const nodePort: ProviderNodePort = {
		async list() {
			return nodes
		},
		async find(id) {
			return nodes.find((node) => node.id === id) ?? null
		},
		async create(fields) {
			const row = { ...fields, id: String(fields.id) } as ProviderNodeRow
			nodes.push(row)
			return row
		},
		async update(id, patch) {
			const index = nodes.findIndex((node) => node.id === id)
			if (index < 0) return null
			patches.push({ id, patch })
			nodes[index] = { ...nodes[index], ...patch }
			return nodes[index]
		},
		async remove(id) {
			const index = nodes.findIndex((node) => node.id === id)
			if (index >= 0) nodes.splice(index, 1)
			return index >= 0
		},
		async removeConnections(providerId) {
			removedConnections.push(providerId)
		},
	}

	const connectionPort: ProviderConnectionPort = {
		async list(filter) {
			return [
				{
					id: "conn-1",
					provider: filter?.provider ?? "node-1",
					providerSpecificData: { apiKey: "secret", prefix: "old" },
				},
			]
		},
		async update(id, patch) {
			connectionPatches.push({ id, patch })
			return {}
		},
	}

	let counter = 0
	const useCase = makeProviderNodes({
		nodes: nodePort,
		connections: connectionPort,
		// Mirrors the real helper: `undefined` for an unusable value, `null` for
		// "cleared", a string for a usable one.
		normalizeLogo: (value) => {
			if (value === "") return null
			return typeof value === "string" ? value : undefined
		},
		generateId: () => `id${++counter}`,
		prefixes: {
			openaiCompatible: "openai-compatible-",
			anthropicCompatible: "anthropic-compatible-",
			customEmbedding: "custom-embedding-",
		},
	})
	return { useCase, nodes, patches, connectionPatches, removedConnections }
}

describe("providerNodes.create", () => {
	it("refuses an omitted type instead of defaulting it", async () => {
		// Defaulting to openai-compatible created phantom nodes from callers that
		// never meant to add one.
		const h = harness()
		await expect(h.useCase.create({ name: "x", prefix: "x" })).rejects.toMatchObject({
			code: "VALIDATION",
			message: "Provider node type is required",
		})
	})

	it("builds the id from the type prefix", async () => {
		const h = harness()
		const node = await h.useCase.create({
			type: "anthropic-compatible",
			name: "Claude Gateway",
			prefix: "claude-gw",
		})
		expect(node.id).toBe("anthropic-compatible-id1")
	})

	it("sanitises the base URL for the type", async () => {
		const h = harness()
		const node = await h.useCase.create({
			type: "anthropic-compatible",
			name: "A",
			prefix: "a",
			baseUrl: "https://api.example.com/v1/messages/",
		})
		expect(node.baseUrl).toBe("https://api.example.com/v1")
	})

	it("refuses a duplicate prefix or name with CONFLICT", async () => {
		const h = harness([{ id: "existing", type: "openai-compatible", name: "Work", prefix: "work" }])
		await expect(
			h.useCase.create({ type: "openai-compatible", apiType: "chat", name: "Other", prefix: "work" }),
		).rejects.toMatchObject({ code: "CONFLICT" })
		await expect(
			h.useCase.create({ type: "openai-compatible", apiType: "chat", name: "Work", prefix: "other" }),
		).rejects.toMatchObject({ code: "CONFLICT" })
	})

	it("does not give an embedding node a quota", async () => {
		const h = harness()
		const node = await h.useCase.create({
			type: "custom-embedding",
			name: "Emb",
			prefix: "emb",
			quotaPath: "/ignored",
		})
		expect(node.quotaPath).toBeUndefined()
		expect(node.quotaEnabled).toBeUndefined()
	})

	it("requires an apiType for an openai-compatible node", async () => {
		const h = harness()
		await expect(
			h.useCase.create({ type: "openai-compatible", name: "x", prefix: "x" }),
		).rejects.toMatchObject({ message: "Invalid OpenAI compatible API type" })
	})
})

describe("providerNodes.update", () => {
	const existing: ProviderNodeRow = {
		id: "node-1",
		type: "openai-compatible",
		name: "Work",
		prefix: "work",
		baseUrl: "https://api.example.com/v1",
		apiType: "chat",
		quotaEnabled: true,
		quotaPath: "/credits",
	}

	it("lets a node keep its own name and prefix", async () => {
		// Update had no duplicate check at all; the check itself must not fire on
		// the node being updated.
		const h = harness([{ ...existing }])
		const node = await h.useCase.update("node-1", {
			name: "Work",
			prefix: "work",
			apiType: "chat",
		})
		expect(node.name).toBe("Work")
	})

	it("refuses a prefix another node already owns", async () => {
		// Create refused this, so an update that bypassed it could recreate the
		// duplicate create was protecting against.
		const h = harness([{ ...existing }, { id: "node-2", type: "openai-compatible", prefix: "taken" }])
		await expect(
			h.useCase.update("node-1", { name: "Work", prefix: "taken", apiType: "chat" }),
		).rejects.toMatchObject({ code: "CONFLICT" })
	})

	it("preserves quotaEnabled when the client does not send it", async () => {
		// An older client that never sent the field would otherwise switch quota
		// reporting off on every save.
		const h = harness([{ ...existing }])
		await h.useCase.update("node-1", { name: "Work", prefix: "work", apiType: "chat" })
		expect(h.patches[0]?.patch.quotaEnabled).toBe(true)
	})

	it("patches the connections that carry a copy of the node's prefix", async () => {
		// A node's id is its provider id and its connections hold a *copy* of the
		// prefix; updating only the node leaves them routing to the old one.
		const h = harness([{ ...existing }])
		await h.useCase.update("node-1", { name: "Work", prefix: "newwork", apiType: "chat" })
		expect(h.connectionPatches).toHaveLength(1)
		expect(h.connectionPatches[0]?.patch).toMatchObject({
			providerSpecificData: { prefix: "newwork", baseUrl: "https://api.example.com/v1" },
		})
	})

	it("keeps credentials when merging providerSpecificData", async () => {
		const h = harness([{ ...existing }])
		await h.useCase.update("node-1", { name: "Work", prefix: "newwork", apiType: "chat" })
		const specific = (h.connectionPatches[0]?.patch.providerSpecificData ?? {}) as Record<
			string,
			unknown
		>
		expect(specific.apiKey).toBe("secret")
	})

	it("leaves the stored logo alone when the field is omitted", async () => {
		const h = harness([{ ...existing, logo: "stored.png" }])
		await h.useCase.update("node-1", { name: "Work", prefix: "work", apiType: "chat" })
		expect(h.patches[0]?.patch).not.toHaveProperty("logo")
	})

	it("clears the logo when sent as an empty string", async () => {
		const h = harness([{ ...existing, logo: "stored.png" }])
		await h.useCase.update("node-1", { name: "Work", prefix: "work", apiType: "chat", logo: "" })
		expect(h.patches[0]?.patch.logo).toBeNull()
	})

	it("404s for an unknown node", async () => {
		const h = harness([])
		await expect(h.useCase.update("nope", { name: "x", prefix: "x" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		})
	})
})

describe("providerNodes.remove", () => {
	it("drops the node's connections before the node", async () => {
		// A node's connections are its children; leaving them behind strands rows
		// pointing at a provider id nothing owns.
		const h = harness([{ id: "node-1", type: "openai-compatible", name: "W", prefix: "w" }])
		await h.useCase.remove("node-1")
		expect(h.removedConnections).toEqual(["node-1"])
		expect(h.nodes).toEqual([])
	})

	it("404s for an unknown node", async () => {
		const h = harness([])
		await expect(h.useCase.remove("nope")).rejects.toMatchObject({ code: "NOT_FOUND" })
	})
})
