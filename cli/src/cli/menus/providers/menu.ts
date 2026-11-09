import * as api from "../../api/client.js"
import { copyToClipboard } from "../../utils/clipboard.js"
import { clearScreen, showHeader, showStatus } from "../../utils/display.js"
import { confirm, pause, prompt } from "../../utils/input.js"
import { showListMenu, showMenuWithBack } from "../../utils/menuHelper.js"

import {
	ALL_PROVIDERS,
	APIKEY_PROVIDERS,
	COLORS,
	countConnectionsByProvider,
	OAUTH_PROVIDERS,
	PROVIDER_MODELS,
} from "./catalog.js"
import { showCustomProvidersMenu } from "./customNodes.js"
import { showProviderDetail } from "./detail.js"

/**
 * Show main providers menu
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showProvidersMenu(breadcrumb = []) {
	// Build provider items list
	const providerItems = []

	Object.values(OAUTH_PROVIDERS).forEach((provider) => {
		providerItems.push({
			provider,
			authType: "oauth",
			label: (data) => {
				const count = data.counts[provider.id] || 0
				return `${provider.name} (OAuth) - ${count} Connected`
			},
			action: async (data) => {
				await showProviderDetail(provider.id, "oauth", data.connections, [...breadcrumb, provider.name])
				return true
			},
		})
	})

	Object.values(APIKEY_PROVIDERS).forEach((provider) => {
		providerItems.push({
			provider,
			authType: "apikey",
			label: (data) => {
				const count = data.counts[provider.id] || 0
				return `${provider.name} (API) - ${count} Connected`
			},
			action: async (data) => {
				await showProviderDetail(provider.id, "apikey", data.connections, [
					...breadcrumb,
					provider.name,
				])
				return true
			},
		})
	})

	// Custom provider nodes section
	providerItems.push({
		label: () => `${COLORS.dim}── Custom Providers ──${COLORS.reset}`,
		action: async () => true, // separator, no-op
		isSeparator: true,
	})
	providerItems.push({
		label: (data) => {
			const count = data.nodeCount || 0
			return `Custom Providers - ${count} Configured`
		},
		action: async () => {
			await showCustomProvidersMenu([...breadcrumb, "Custom Providers"])
			return true
		},
	})

	await showMenuWithBack({
		title: "🔌 Providers Management",
		breadcrumb,
		refresh: async () => {
			const [provRes, nodeRes] = await Promise.all([api.getProviders(), api.getProviderNodes()])
			if (!provRes.success) {
				showStatus(`Failed to fetch providers: ${provRes.error}`, "error")
				await pause()
				return null
			}
			const connections = provRes.data.connections || []
			const nodes = nodeRes.success ? nodeRes.data.nodes || nodeRes.data || [] : []
			return {
				connections,
				counts: countConnectionsByProvider(connections),
				nodeCount: nodes.length,
			}
		},
		items: providerItems,
	})
}

export { showProvidersMenu }
