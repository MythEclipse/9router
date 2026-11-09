import * as api from "../../api/client.js"
import { copyToClipboard } from "../../utils/clipboard.js"
import { clearScreen, showHeader, showStatus } from "../../utils/display.js"
import { confirm, pause, prompt } from "../../utils/input.js"
import { showListMenu, showMenuWithBack } from "../../utils/menuHelper.js"
import { handleAddConnection } from "./addConnection.js"
import { ALL_PROVIDERS, COLORS, PROVIDER_MODELS } from "./catalog.js"

/**
 * Build provider header with alias and models
 * @param {string} providerId - Provider ID
 * @returns {string}
 */
function buildProviderHeader(providerId) {
	const provider = ALL_PROVIDERS[providerId]
	const alias = provider.alias || providerId

	const lines = []
	lines.push(`Alias: ${COLORS.cyan}${alias}${COLORS.reset}`)

	// Get models from static config
	const models = PROVIDER_MODELS[alias] || []
	if (models.length > 0) {
		const modelList = models
			.slice(0, 5)
			.map((m) => `${alias}/${m.id}`)
			.join(", ")
		const more = models.length > 5 ? ` (+${models.length - 5} more)` : ""
		lines.push(`Models: ${COLORS.dim}${modelList}${more}${COLORS.reset}`)
	} else {
		lines.push(`Models: ${COLORS.dim}No models configured${COLORS.reset}`)
	}

	return lines.join("\n")
}

/**
 * Show provider detail with connections and actions
 * @param {string} providerId - Provider ID
 * @param {string} authType - "oauth" or "apikey"
 * @param {Array} allConnections - All connections
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showProviderDetail(providerId, authType, allConnections, breadcrumb = []) {
	const provider = ALL_PROVIDERS[providerId]

	await showListMenu({
		title: `🔌 ${provider.name} (${authType.toUpperCase()})`,
		breadcrumb,
		backLabel: "← Back to Providers",
		headerContent: buildProviderHeader(providerId),
		fetchItems: async () => {
			const response = await api.getProviders()
			if (response.success) {
				allConnections.length = 0
				allConnections.push(...(response.data.connections || []))
			}
			const providerConns = allConnections.filter(
				(conn) => (conn.provider || conn.providerId) === providerId,
			)
			return { items: providerConns }
		},
		formatItem: (conn) => {
			const status = conn.testStatus === "active" ? "✓" : conn.testStatus === "error" ? "✗" : "?"
			const name = conn.name || conn.email || conn.displayName || "Unnamed"
			return `${name} (${status})`
		},
		onSelect: async (conn) => {
			await showConnectionActions(conn, providerId, breadcrumb)
		},
		createAction: {
			label: "Add New Connection",
			action: async () => {
				await handleAddConnection(providerId, authType)
			},
		},
	})
}

/**
 * Show actions for a specific connection
 * @param {Object} connection - Connection object
 * @param {string} providerId - Provider ID
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showConnectionActions(connection, _providerId, breadcrumb = []) {
	const name = connection.name || connection.email || connection.displayName || "Unnamed"
	const status =
		connection.testStatus === "active"
			? "✓ Active"
			: connection.testStatus === "error"
				? "✗ Error"
				: "? Unknown"

	await showMenuWithBack({
		title: `🔌 ${name}`,
		breadcrumb: [...breadcrumb, name],
		headerContent: `Connection: ${name}\nStatus: ${status}`,
		items: [
			{
				label: "Rename Connection",
				action: async () => {
					const newName = await prompt(`New name (current: ${name}): `)
					if (newName && newName.trim()) {
						showStatus("Renaming connection...", "info")
						const result = await api.updateConnection(connection.id, { name: newName.trim() })
						if (result.success) {
							showStatus("Connection renamed!", "success")
							connection.name = newName.trim()
						} else {
							showStatus(`Rename failed: ${result.error}`, "error")
						}
						await pause()
					}
					return true
				},
			},
			{
				label: "Test Connection",
				action: async () => {
					showStatus("Testing connection...", "info")
					const result = await api.testConnection(connection.id)
					if (result.success) {
						showStatus("Connection is working!", "success")
					} else {
						showStatus(`Test failed: ${result.error}`, "error")
					}
					await pause()
					return true
				},
			},
			{
				label: "Delete Connection",
				action: async () => {
					const confirmed = await confirm(`Delete connection "${name}"?`)
					if (confirmed) {
						const result = await api.deleteConnection(connection.id)
						if (result.success) {
							showStatus("Connection deleted!", "success")
						} else {
							showStatus(`Delete failed: ${result.error}`, "error")
						}
						await pause()
						return false // Exit menu after delete
					}
					return true
				},
			},
		],
	})
}

export { buildProviderHeader, showConnectionActions, showProviderDetail }
