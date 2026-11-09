import * as api from "../../api/client.js"
import { showStatus } from "../../utils/display.js"
import { getEndpoint } from "../../utils/endpoint.js"
import { confirm, pause, select } from "../../utils/input.js"
import { showMenuWithBack } from "../../utils/menuHelper.js"
import { selectModelFromList } from "../../utils/modelSelector.js"
import { showClaudeCodeMenu } from "./claude.js"
import { showOpenClawMenu } from "./openclaw.js"
import { showOpenCodeMenu } from "./opencode.js"
import { showCodexMenu, showDroidMenu } from "./otherTools.js"
import { COLORS, getFirstApiKey } from "./shared.js"

// ─── Hermes Agent ─────────────────────────────────────────────────────────────

// Profile targeted by Quick Setup / Reset. The menu rebuilds through `refresh()` on every
// loop, so the pick has to live outside the render — module state, like the menu itself.
let hermesActiveProfile = "default"

async function fetchHermesProfiles() {
	const result = await api.listHermesProfiles()
	if (!result.success) return []
	return result.data.profiles || []
}

const hermesProfileLine = (p) => {
	const name = p.displayName && !p.isDefault ? `${p.name} (${p.displayName})` : p.name
	const state = p.has9Router
		? `${COLORS.green}✓ 9router${COLORS.reset}`
		: p.baseUrl
			? `${COLORS.red}other: ${p.baseUrl}${COLORS.reset}`
			: `${COLORS.red}✗ not configured${COLORS.reset}`
	const model = p.model ? ` ${COLORS.dim}· ${p.model}${COLORS.reset}` : ""
	return `${name} — ${state}${model}`
}

async function buildHermesHeader(profiles) {
	const list = profiles || (await fetchHermesProfiles())
	const result = await api.getCliToolSettings("hermes", hermesActiveProfile)
	if (!result.success) return `  ${COLORS.red}Failed to load settings${COLORS.reset}`

	const { installed, has9Router, settings, profile } = result.data
	if (!installed) return `Status:   ${COLORS.red}✗ Hermes Agent not installed${COLORS.reset}`

	const name = profile?.name || hermesActiveProfile
	const lines = []
	if (has9Router) {
		lines.push(`Status:   ${COLORS.green}✓ Configured${COLORS.reset} (${name})`)
	} else {
		lines.push(`Status:   ${COLORS.red}✗ Not configured${COLORS.reset} (${name})`)
		lines.push(`${COLORS.dim}Run "Quick Setup" to configure${COLORS.reset}`)
	}

	const model = settings?.model || {}
	if (model.base_url) lines.push(`Endpoint: ${COLORS.cyan}${model.base_url}${COLORS.reset}`)
	if (model.default) lines.push(`Model:    ${COLORS.dim}${model.default}${COLORS.reset}`)

	if (list.length > 1) {
		const summary = list
			.map((p) => `${p.name}${p.has9Router ? `${COLORS.green}✓` : `${COLORS.red}✗`}`)
			.join(`${COLORS.reset} `)
		lines.push(`Profiles:  ${summary}${COLORS.reset}`)
	}
	return lines.join("\n")
}

async function selectHermesProfile() {
	const profiles = await fetchHermesProfiles()
	if (profiles.length === 0) {
		showStatus("No Hermes profiles found.", "error")
		await pause()
		return
	}

	const index = await select("Select Hermes profile:", profiles.map(hermesProfileLine))
	hermesActiveProfile = profiles[index].name
	showStatus(`Active profile: "${hermesActiveProfile}"`, "success")
	await pause()
}

async function hermesQuickSetup(port) {
	const { endpoint } = await getEndpoint(port)
	const apiKey = await getFirstApiKey()

	if (!apiKey) {
		showStatus("No API keys found. Create one in API Keys menu first.", "error")
		await pause()
		return
	}

	const model = await selectModelFromList(`Select Hermes Model (${hermesActiveProfile})`, "", {
		excludeCombos: true,
	})
	if (!model) return

	const result = await api.applyCliToolSettings("hermes", {
		profile: hermesActiveProfile,
		baseUrl: endpoint,
		apiKey,
		model,
	})
	showStatus(
		result.success
			? `Hermes setup completed for profile "${hermesActiveProfile}"!`
			: `Failed: ${result.error}`,
		result.success ? "success" : "error",
	)
	await pause()
}

// Endpoint + API key across every profile. Each profile keeps its own model — profiles
// already routed through 9router are refreshed, anything else is reported as skipped.
async function hermesApplyAll(port) {
	const { endpoint } = await getEndpoint(port)
	const apiKey = await getFirstApiKey()

	if (!apiKey) {
		showStatus("No API keys found. Create one in API Keys menu first.", "error")
		await pause()
		return
	}

	const model = await selectModelFromList(
		"Select Model (used only for profiles with no model yet)",
		"",
		{ excludeCombos: true },
	)
	if (!model) return

	const result = await api.applyCliToolSettings("hermes", {
		applyToAll: true,
		baseUrl: endpoint,
		apiKey,
		model,
	})
	if (!result.success) {
		showStatus(`Failed: ${result.error}`, "error")
		await pause()
		return
	}

	const skipped = (result.data.results || []).filter((r) => r.status !== "updated")
	if (skipped.length === 0) {
		showStatus(`Endpoint applied to ${result.data.updated} profile(s).`, "success")
	} else {
		const detail = skipped.map((r) => `  ${r.profile}: ${r.reason || r.status}`).join("\n")
		showStatus(
			`Updated ${result.data.updated} profile(s), skipped ${skipped.length}:\n${detail}`,
			result.data.updated > 0 ? "success" : "error",
		)
	}
	await pause()
}

async function hermesReset() {
	const result = await api.resetCliToolSettings("hermes", hermesActiveProfile)
	showStatus(
		result.success
			? `Hermes settings reset for profile "${hermesActiveProfile}"!`
			: `Failed: ${result.error}`,
		result.success ? "success" : "error",
	)
	await pause()
}

async function showHermesMenu(port, breadcrumb = []) {
	await showMenuWithBack({
		title: "⚡ Hermes Agent Settings",
		breadcrumb,
		refresh: async () => {
			const profiles = await fetchHermesProfiles()
			// Drop a stale selection (profile deleted in another tab) back to default.
			if (profiles.length > 0 && !profiles.some((p) => p.name === hermesActiveProfile)) {
				hermesActiveProfile = "default"
			}
			return profiles
		},
		headerContent: buildHermesHeader,
		items: [
			{
				label: () => `🎯 Profile: ${hermesActiveProfile}`,
				action: async () => {
					await selectHermesProfile()
					return true
				},
			},
			{
				label: "⚡ Quick Setup",
				action: async () => {
					await hermesQuickSetup(port)
					return true
				},
			},
			{
				label: "🔁 Apply to All Profiles",
				action: async () => {
					await hermesApplyAll(port)
					return true
				},
			},
			{
				label: () => `↺ Reset Profile: ${hermesActiveProfile}`,
				action: async () => {
					await hermesReset()
					return true
				},
			},
		],
	})
}

// ─── Main CLI Tools Menu ──────────────────────────────────────────────────────

/**
 * Main CLI Tools menu
 * @param {number} port
 * @param {Array<string>} breadcrumb
 */
async function showCliToolsMenu(port, breadcrumb = []) {
	const { endpoint } = await getEndpoint(port)
	await showMenuWithBack({
		title: "🔧 CLI Tools",
		breadcrumb,
		headerContent: `Configure CLI tools to use 9Router\nEndpoint: ${endpoint}`,
		items: [
			{
				label: "Claude Code",
				action: async () => {
					await showClaudeCodeMenu(port, [...breadcrumb, "Claude Code"])
					return true
				},
			},
			{
				label: "Codex CLI",
				action: async () => {
					await showCodexMenu(port, [...breadcrumb, "Codex CLI"])
					return true
				},
			},
			{
				label: "Factory Droid",
				action: async () => {
					await showDroidMenu(port, [...breadcrumb, "Factory Droid"])
					return true
				},
			},
			{
				label: "Open Claw",
				action: async () => {
					await showOpenClawMenu(port, [...breadcrumb, "Open Claw"])
					return true
				},
			},
			{
				label: "OpenCode",
				action: async () => {
					await showOpenCodeMenu(port, [...breadcrumb, "OpenCode"])
					return true
				},
			},
			{
				label: "Hermes",
				action: async () => {
					await showHermesMenu(port, [...breadcrumb, "Hermes"])
					return true
				},
			},
		],
	})
}

export { showCliToolsMenu, showHermesMenu }
