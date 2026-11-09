import * as api from "../../api/client.js"
import { copyToClipboard } from "../../utils/clipboard.js"
import { clearScreen, showHeader, showStatus } from "../../utils/display.js"
import { confirm, pause, prompt } from "../../utils/input.js"
import { showListMenu, showMenuWithBack } from "../../utils/menuHelper.js"

import { ALL_PROVIDERS, COLORS } from "./catalog.js"

/**
 * Handle adding new connection
 * @param {string} providerId - Provider ID
 * @param {string} authType - "oauth" or "apikey"
 */
// Providers that use Device Code Flow (terminal-based polling)
const DEVICE_CODE_PROVIDERS = ["github", "qwen", "kiro", "glm"]

/**
 * Handle adding new connection - auto-detect flow type
 * @param {string} providerId - Provider ID
 * @param {string} authType - "oauth" or "apikey"
 */
async function handleAddConnection(providerId, authType) {
	if (authType === "apikey") {
		await handleAddApiKeyConnection(providerId)
	} else {
		// OAuth: auto-detect flow type based on provider
		if (DEVICE_CODE_PROVIDERS.includes(providerId)) {
			// Device Code Flow for GitHub, Qwen, Kiro
			await handleAddDeviceCodeConnection(providerId)
		} else {
			// Authorization Code Flow for Claude, Codex, Gemini, etc.
			await handleAddOAuthConnection(providerId)
		}
	}
}

/**
 * Handle adding API Key connection
 * @param {string} providerId - Provider ID
 */
async function handleAddApiKeyConnection(providerId) {
	clearScreen()
	const provider = ALL_PROVIDERS[providerId]
	console.log(`\n➕ Add ${provider.name} API Key Connection\n`)

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

	const result = await api.createApiKeyProvider({
		provider: providerId,
		name,
		apiKey,
	})

	if (result.success) {
		showStatus("✓ Connection created successfully!", "success")
	} else {
		showStatus(`✗ Failed: ${result.error}`, "error")
	}

	await pause()
}

/**
 * Handle adding OAuth Authorization Code connection
 * User opens URL manually and pastes callback URL
 * @param {string} providerId - Provider ID
 */
async function handleAddOAuthConnection(providerId) {
	clearScreen()
	const provider = ALL_PROVIDERS[providerId]

	// Step 1: Get auth URL
	showStatus("Requesting authorization URL...", "info")
	const authResult = await api.getOAuthAuthUrl(providerId)

	if (!authResult.success) {
		showStatus(`Failed: ${authResult.error}`, "error")
		await pause()
		return
	}

	const authData = authResult.data || authResult
	const authUrl = authData.authUrl
	const codeVerifier = authData.codeVerifier
	const state = authData.state
	const redirectUri = authData.redirectUri

	if (!authUrl) {
		showStatus("Failed: No auth URL received", "error")
		await pause()
		return
	}

	// Step 2: Show URL and instructions
	clearScreen()
	showHeader("🔐 OAuth Login", `Providers > ${provider.name} > Add Connection`)

	console.log(`  ${COLORS.bold}${COLORS.cyan}1.${COLORS.reset} Open this URL in your browser:`)
	console.log(`     ${COLORS.dim}${authUrl}${COLORS.reset}`)
	if (copyToClipboard(authUrl)) {
		console.log(`     \x1b[32m✓ Link copied to clipboard!\x1b[0m`)
	}
	console.log()
	console.log(`  ${COLORS.bold}${COLORS.cyan}2.${COLORS.reset} Complete authorization in browser`)
	console.log()
	console.log(
		`  ${COLORS.bold}${COLORS.cyan}3.${COLORS.reset} Copy the callback URL from address bar`,
	)
	console.log(
		`     ${COLORS.dim}(looks like: http://localhost:20128/callback?code=...)${COLORS.reset}`,
	)
	console.log()

	const callbackUrl = await prompt("  Paste callback URL: ")
	if (!callbackUrl) {
		showStatus("Cancelled", "warning")
		await pause()
		return
	}

	// Step 3: Parse callback URL and extract code
	let code, urlState, error
	try {
		const url = new URL(callbackUrl.trim())
		code = url.searchParams.get("code")
		urlState = url.searchParams.get("state")
		error = url.searchParams.get("error")

		if (error) {
			const errorDesc = url.searchParams.get("error_description") || error
			showStatus(`Authorization failed: ${errorDesc}`, "error")
			await pause()
			return
		}

		if (!code) {
			showStatus("No authorization code found in URL", "error")
			await pause()
			return
		}
	} catch (_err) {
		showStatus("Invalid URL format", "error")
		await pause()
		return
	}

	// Step 4: Exchange code for tokens
	console.log()
	showStatus("Exchanging code for tokens...", "info")
	const exchangeResult = await api.exchangeOAuthCode(providerId, {
		code,
		redirectUri,
		codeVerifier,
		state: urlState || state,
	})

	if (exchangeResult.success) {
		showStatus("Connection created successfully!", "success")
	} else {
		showStatus(`Failed: ${exchangeResult.error}`, "error")
	}

	await pause()
}

/**
 * Handle adding OAuth Device Code connection
 * @param {string} providerId - Provider ID
 */
async function handleAddDeviceCodeConnection(providerId) {
	clearScreen()
	const provider = ALL_PROVIDERS[providerId]

	// Step 1: Request device code
	showStatus("Requesting device code...", "info")
	const deviceResult = await api.getOAuthDeviceCode(providerId)

	if (!deviceResult.success) {
		showStatus(`Failed: ${deviceResult.error}`, "error")
		await pause()
		return
	}

	const deviceData = deviceResult.data || deviceResult
	const device_code = deviceData.device_code
	const user_code = deviceData.user_code
	const verification_uri = deviceData.verification_uri
	const verification_uri_complete = deviceData.verification_uri_complete
	const codeVerifier = deviceData.codeVerifier
	const extraData = deviceData.extraData || deviceData

	if (!device_code) {
		showStatus("Failed: No device code received", "error")
		await pause()
		return
	}

	// Step 2: Show instructions
	clearScreen()
	const deviceUrl = verification_uri_complete || verification_uri
	showHeader("📱 Device Login", `Providers > ${provider.name} > Add Connection`)

	console.log(
		`  ${COLORS.bold}${COLORS.cyan}1.${COLORS.reset} Open: ${COLORS.dim}${deviceUrl}${COLORS.reset}`,
	)
	if (copyToClipboard(deviceUrl)) {
		console.log(`     \x1b[32m✓ Link copied to clipboard!\x1b[0m`)
	}
	console.log()
	if (!verification_uri_complete && user_code) {
		console.log(
			`  ${COLORS.bold}${COLORS.cyan}2.${COLORS.reset} Enter code: ${COLORS.bold}${user_code}${COLORS.reset}`,
		)
		console.log()
	}
	console.log(`  ${COLORS.dim}Waiting for authorization...${COLORS.reset}`)
	console.log()

	// Step 3: Poll for token
	const maxAttempts = 60 // 5 minutes (5s interval)
	for (let i = 0; i < maxAttempts; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5000))

		const pollResult = await api.pollOAuthToken(providerId, {
			deviceCode: device_code,
			codeVerifier,
			extraData,
		})

		if (pollResult.success) {
			showStatus("\nConnection created successfully!", "success")
			await pause()
			return
		}

		// Check if still pending (pending flag is at root level, not in data)
		const isPending =
			pollResult.pending ||
			pollResult.error === "authorization_pending" ||
			pollResult.error === "slow_down"
		if (!isPending) {
			showStatus(`\nFailed: ${pollResult.error || "Unknown error"}`, "error")
			await pause()
			return
		}

		process.stdout.write(".")
	}

	showStatus("\nTimeout waiting for authorization", "error")
	await pause()
}

export {
	DEVICE_CODE_PROVIDERS,
	handleAddApiKeyConnection,
	handleAddConnection,
	handleAddDeviceCodeConnection,
	handleAddOAuthConnection,
}
