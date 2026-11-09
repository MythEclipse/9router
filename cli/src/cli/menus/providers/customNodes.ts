import * as api from "../../api/client.js"
import { copyToClipboard } from "../../utils/clipboard.js"
import { clearScreen, showHeader, showStatus } from "../../utils/display.js"
import { confirm, pause, prompt } from "../../utils/input.js"
import { showListMenu, showMenuWithBack } from "../../utils/menuHelper.js"

import { COLORS } from "./catalog.js"
import { showConnectionActions } from "./detail.js"

// ============================================================================
// CUSTOM PROVIDERS (provider nodes)
// ============================================================================

const CUSTOM_NODE_TYPES = ["openai-compatible", "anthropic-compatible"]
const OPENAI_API_TYPES = ["chat", "responses"]

/**
 * Show custom providers section in main providers menu
 * @param {Array} nodes - List of provider nodes
 * @param {Array} connections - All connections
 * @param {Array<string>} breadcrumb
 */
async function showCustomProvidersMenu(breadcrumb = []) {
	await showListMenu({
		title: "🔧 Custom Providers",
		breadcrumb,
		backLabel: "← Back to Providers",
		fetchItems: async () => {
			const res = await api.getProviderNodes()
			if (!res.success) return { items: [] }
			return { items: res.data.nodes || res.data || [] }
		},
		formatItem: (node) => `[${node.prefix}] ${node.name} (${node.type})`,
		onSelect: async (node) => {
			await showCustomNodeDetail(node, [...breadcrumb, node.name])
		},
		createAction: {
			label: "➕ Add Custom Provider",
			action: async () => {
				await handleAddCustomNode()
			},
		},
	})
}

/**
 * Show detail menu for a custom provider node
 */
async function showCustomNodeDetail(node, breadcrumb = []) {
	await showMenuWithBack({
		title: `🔧 ${node.name}`,
		breadcrumb,
		headerContent: [
			`Type: ${node.type}`,
			`Prefix: ${COLORS.cyan}${node.prefix}${COLORS.reset}`,
			`Base URL: ${COLORS.dim}${node.baseUrl}${COLORS.reset}`,
		].join("\n"),
		items: [
			{
				label: "Connections",
				action: async () => {
					await showCustomNodeConnections(node, breadcrumb)
					return true
				},
			},
			{
				label: "Edit Node",
				action: async () => {
					await handleEditCustomNode(node)
					return true
				},
			},
			{
				label: "Delete Node",
				action: async () => {
					const confirmed = await confirm(`Delete "${node.name}" and all its connections?`)
					if (confirmed) {
						const res = await api.deleteProviderNode(node.id)
						if (res.success) {
							showStatus("Node deleted!", "success")
						} else {
							showStatus(`Delete failed: ${res.error}`, "error")
						}
						await pause()
						return false
					}
					return true
				},
			},
		],
	})
}

/**
 * Show connections for a custom provider node
 */
async function showCustomNodeConnections(node, breadcrumb = []) {
	await showListMenu({
		title: `🔌 ${node.name} – Connections`,
		breadcrumb,
		backLabel: "← Back",
		fetchItems: async () => {
			const res = await api.getProviders()
			if (!res.success) return { items: [] }
			const all = res.data.connections || []
			const items = all.filter((c) => c.provider === node.id)
			return { items }
		},
		formatItem: (conn) => {
			const status = conn.testStatus === "active" ? "✓" : conn.testStatus === "error" ? "✗" : "?"
			return `${conn.name || "Unnamed"} (${status})`
		},
		onSelect: async (conn) => {
			await showConnectionActions(conn, node.id, breadcrumb)
		},
		createAction: {
			label: "Add API Key Connection",
			action: async () => {
				await handleAddCustomNodeConnection(node)
			},
		},
	})
}

/**
 * Add API key connection to a custom provider node
 */
async function handleAddCustomNodeConnection(node) {
	clearScreen()
	console.log(`\n➕ Add Connection to ${node.name}\n`)

	const name = await prompt("Connection Name: ")
	if (!name) {
		showStatus("Cancelled", "warning")
		await pause()
		return
	}

	const apiKey = await prompt("API Key: ")
	if (!apiKey) {
		showStatus("Cancelled", "warning")
		await pause()
		return
	}

	showStatus("Creating connection...", "info")
	const res = await api.createApiKeyProvider({ provider: node.id, name, apiKey })

	showStatus(
		res.success ? "✓ Connection created!" : `✗ Failed: ${res.error}`,
		res.success ? "success" : "error",
	)
	await pause()
}

/**
 * Handle adding a new custom provider node
 */
async function handleAddCustomNode() {
	clearScreen()
	console.log("\n➕ Add Custom Provider\n")

	// Step 1: Select type
	const typeChoices = CUSTOM_NODE_TYPES.map((t, i) => `  ${i + 1}. ${t}`).join("\n")
	console.log(`Select type:\n${typeChoices}\n`)
	const typeInput = await prompt("Type (1/2): ")
	const typeIdx = parseInt(typeInput, 10) - 1
	if (Number.isNaN(typeIdx) || !CUSTOM_NODE_TYPES[typeIdx]) {
		showStatus("Cancelled", "warning")
		await pause()
		return
	}
	const type = CUSTOM_NODE_TYPES[typeIdx]

	// Step 2: Inputs
	const name = await prompt("Name: ")
	if (!name) {
		showStatus("Cancelled", "warning")
		await pause()
		return
	}

	const prefix = await prompt("Prefix (used in model IDs, e.g. myapi): ")
	if (!prefix) {
		showStatus("Cancelled", "warning")
		await pause()
		return
	}

	const baseUrl = await prompt("Base URL (e.g. https://api.example.com/v1): ")
	if (!baseUrl) {
		showStatus("Cancelled", "warning")
		await pause()
		return
	}

	// Step 3: API type (OpenAI only)
	let apiType
	if (type === "openai-compatible") {
		const apiTypeChoices = OPENAI_API_TYPES.map((t, i) => `  ${i + 1}. ${t}`).join("\n")
		console.log(`\nAPI Type:\n${apiTypeChoices}\n`)
		const apiTypeInput = await prompt("API Type (1/2, default 1): ")
		const apiTypeIdx = parseInt(apiTypeInput, 10) - 1
		apiType = OPENAI_API_TYPES[apiTypeIdx] || "chat"
	}

	showStatus("Creating provider node...", "info")
	const body = { name, prefix, baseUrl, type, ...(apiType && { apiType }) }
	const res = await api.createProviderNode(body)

	showStatus(
		res.success ? "✓ Provider created!" : `✗ Failed: ${res.error}`,
		res.success ? "success" : "error",
	)
	await pause()
}

/**
 * Handle editing a custom provider node
 */
async function handleEditCustomNode(node) {
	clearScreen()
	console.log(`\n✏️  Edit ${node.name}\n`)
	console.log(`${COLORS.dim}Leave blank to keep current value${COLORS.reset}\n`)

	const name = await prompt(`Name (${node.name}): `)
	const baseUrl = await prompt(`Base URL (${node.baseUrl}): `)
	const prefix = await prompt(`Prefix (${node.prefix}): `)

	const updates = {}
	if (name && name.trim()) updates.name = name.trim()
	if (baseUrl && baseUrl.trim()) updates.baseUrl = baseUrl.trim()
	if (prefix && prefix.trim()) updates.prefix = prefix.trim()

	if (!Object.keys(updates).length) {
		showStatus("No changes", "warning")
		await pause()
		return
	}

	showStatus("Updating...", "info")
	const res = await api.updateProviderNode(node.id, updates)
	if (res.success) {
		Object.assign(node, updates)
		showStatus("✓ Updated!", "success")
	} else {
		showStatus(`✗ Failed: ${res.error}`, "error")
	}
	await pause()
}

export {
	handleAddCustomNode,
	handleAddCustomNodeConnection,
	handleEditCustomNode,
	showCustomNodeConnections,
	showCustomNodeDetail,
	showCustomProvidersMenu,
}
