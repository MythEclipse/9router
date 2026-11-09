import * as api from "../../api/client.js"
import { showStatus } from "../../utils/display.js"
import { getEndpoint } from "../../utils/endpoint.js"
import { confirm, pause, select } from "../../utils/input.js"
import { showMenuWithBack } from "../../utils/menuHelper.js"
import { selectModelFromList } from "../../utils/modelSelector.js"

import { CLAUDE_MODEL_TYPES, COLORS, getFirstApiKey } from "./shared.js"

// ─── OpenCode CLI ─────────────────────────────────────────────────────────────

async function buildOpenCodeHeader() {
	const result = await api.getCliToolSettings("opencode")
	if (!result.success) return `  ${COLORS.red}Failed to load settings${COLORS.reset}`

	const { installed, has9Router, opencode } = result.data
	if (!installed) return `Status:   ${COLORS.red}✗ OpenCode CLI not installed${COLORS.reset}`

	if (!has9Router) {
		return [
			`Status:   ${COLORS.red}✗ Not configured${COLORS.reset}`,
			`${COLORS.dim}Run "Quick Setup" to configure${COLORS.reset}`,
		].join("\n")
	}

	const lines = [`Status:   ${COLORS.green}✓ Configured${COLORS.reset}`]
	if (opencode?.baseURL) lines.push(`Endpoint: ${COLORS.cyan}${opencode.baseURL}${COLORS.reset}`)
	if (opencode?.activeModel)
		lines.push(`Active:   ${COLORS.dim}${opencode.activeModel}${COLORS.reset}`)
	if (Array.isArray(opencode?.models) && opencode.models.length > 0) {
		lines.push(`Models:   ${COLORS.dim}${opencode.models.join(", ")}${COLORS.reset}`)
	}
	return lines.join("\n")
}

async function openCodeQuickSetup(port) {
	const { endpoint } = await getEndpoint(port)
	const apiKey = await getFirstApiKey()

	if (!apiKey) {
		showStatus("No API keys found. Create one in API Keys menu first.", "error")
		await pause()
		return
	}

	// Pick first model (also becomes active model by default)
	const firstModel = await selectModelFromList("Select Active Model (OpenCode)", "", {
		excludeCombos: true,
	})
	if (!firstModel) return

	const models = [firstModel]

	// Optionally add more models
	while (true) {
		const more = await confirm(`Add another model? (current: ${models.length})`)
		if (!more) break
		const next = await selectModelFromList(`Add Model #${models.length + 1}`, models.join(", "), {
			excludeCombos: true,
		})
		if (!next) break
		if (!models.includes(next)) models.push(next)
	}

	// Optional subagent model
	let subagentModel = firstModel
	const wantSubagent = await confirm(`Set a different subagent model? (default: ${firstModel})`)
	if (wantSubagent) {
		const picked = await selectModelFromList("Select Subagent Model", firstModel, {
			excludeCombos: true,
		})
		if (picked) subagentModel = picked
	}

	const result = await api.applyCliToolSettings("opencode", {
		baseUrl: endpoint,
		apiKey,
		models,
		activeModel: firstModel,
		subagentModel,
	})
	showStatus(
		result.success ? "OpenCode setup completed!" : `Failed: ${result.error}`,
		result.success ? "success" : "error",
	)
	await pause()
}

async function openCodeReset() {
	const result = await api.resetCliToolSettings("opencode")
	showStatus(
		result.success ? "OpenCode settings reset!" : `Failed: ${result.error}`,
		result.success ? "success" : "error",
	)
	await pause()
}

async function showOpenCodeMenu(port, breadcrumb = []) {
	await showMenuWithBack({
		title: "💻 OpenCode CLI Settings",
		breadcrumb,
		headerContent: buildOpenCodeHeader,
		refresh: async () => ({}),
		items: [
			{
				label: "⚡ Quick Setup",
				action: async () => {
					await openCodeQuickSetup(port)
					return true
				},
			},
			{
				label: "Reset to Default",
				action: async () => {
					await openCodeReset()
					return true
				},
			},
		],
	})
}

export { showOpenCodeMenu }
