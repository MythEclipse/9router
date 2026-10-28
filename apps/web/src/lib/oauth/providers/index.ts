// Ensure outbound fetch respects HTTP(S)_PROXY/ALL_PROXY in Node runtime
import "open-sse/index"

import { extractCodexAccountInfo, fetchKiroProfileArn } from "../providerHelpers.ts"
import { generatePKCE } from "../utils/pkce.ts"
import antigravity from "./antigravity.ts"
import claude from "./claude.ts"
import cline from "./cline.ts"
import clinepass from "./clinepass.ts"
import codebuddyCn from "./codebuddy-cn.ts"
import codebuddyIntl from "./codebuddy-intl.ts"
import codex from "./codex.ts"
import cursor from "./cursor.ts"
import geminiCli from "./gemini-cli.ts"
import github from "./github.ts"
import gitlab from "./gitlab.ts"
import glm from "./glm.ts"
import grokCli from "./grok-cli.ts"
import iflow from "./iflow.ts"
import kilocode from "./kilocode.ts"
import kimchi from "./kimchi.ts"
import kimi from "./kimi.ts"
import kiro from "./kiro.ts"
import minimaxCode from "./minimax-code.ts"
import minimaxCodeGlobal from "./minimax-code-global.ts"
import muse from "./muse.ts"
import nous from "./nous.ts"
import perchai from "./perchai.ts"
import qoder from "./qoder.ts"
import qoderCn from "./qoder-cn.ts"
import trae from "./trae.ts"
import windsurf from "./windsurf.ts"
import xai from "./xai.ts"
import zed from "./zed.ts"

// Provider configurations
const PROVIDERS = {
	claude,
	codex,
	xai,
	"grok-cli": grokCli,
	muse,
	"gemini-cli": geminiCli,
	antigravity,
	iflow,
	qoder,
	"qoder-cn": qoderCn,
	github,
	kiro,
	cursor,
	kimi,
	kilocode,
	cline,
	clinepass,
	gitlab,
	"codebuddy-cn": codebuddyCn,
	"codebuddy-intl": codebuddyIntl,
	perchai,
	kimchi,
	trae,
	windsurf,
	zed,
	glm,
	"minimax-code": minimaxCode,
	"minimax-code-global": minimaxCodeGlobal,
	nous,
}

// Re-export helpers that other files import from this path
export { extractCodexAccountInfo, fetchKiroProfileArn, PROVIDERS }

/**
 * Get provider handler
 */
export function getProvider(name) {
	// Legacy kimi-coding → kimi (dual-auth merge)
	const key = name === "kimi-coding" ? "kimi" : name
	const provider = PROVIDERS[key]
	if (!provider) {
		throw new Error(`Unknown provider: ${name}`)
	}
	return provider
}

/**
 * Get all provider names
 */
export function getProviderNames() {
	return Object.keys(PROVIDERS)
}

/**
 * Generate auth data for a provider
 * @param {object} [meta] - Provider-specific metadata (e.g. gitlab clientId/baseUrl)
 */
export async function generateAuthData(providerName, redirectUri, meta) {
	const provider = getProvider(providerName)
	const config = provider.prepareConfig
		? await provider.prepareConfig(provider.config, meta || {})
		: provider.config
	const {
		codeVerifier: pkceVerifier,
		codeChallenge,
		state: pkceState,
	} = generatePKCE(provider.pkceVerifierBytes)
	// Trae uses loginTraceID (set by prepareConfig) as the callback matcher, not PKCE state.
	const state = config.loginTraceID || pkceState
	// Zed: codeVerifier carries the encoded RSA private key (from prepareConfig), not a PKCE verifier.
	const codeVerifier = config.privateKeyVerifier || pkceVerifier

	let authUrl
	if (provider.flowType === "device_code") {
		// Device code flow doesn't have auth URL upfront
		authUrl = null
	} else if (provider.flowType === "authorization_code_pkce") {
		authUrl = provider.buildAuthUrl(config, redirectUri, state, codeChallenge, meta || {})
	} else {
		authUrl = provider.buildAuthUrl(config, redirectUri, state, undefined, meta || {})
	}

	return {
		authUrl,
		state,
		codeVerifier,
		codeChallenge,
		redirectUri,
		flowType: provider.flowType,
		fixedPort: provider.fixedPort,
		callbackPath: provider.callbackPath || "/callback",
		// Zed: surface the system_id embedded in the sign-in URL so the frontend
		// can thread it through register-session → exchange → stored connection
		// (exchangeTokens re-runs prepareConfig, which would otherwise mint a
		// different one). Absent for every other provider - purely additive.
		...(config.systemId ? { systemId: config.systemId } : {}),
	}
}

/**
 * Exchange code for tokens
 * @param {object} [meta] - Provider-specific metadata (e.g. gitlab clientId/baseUrl)
 */
/**
 * Exchange an authorization code (or a provider-specific raw callback) for
 * tokens. `redirectUri`, `codeVerifier`, `state` and `meta` are optional
 * because the device-code/social flows only pass the raw callback.
 */
export async function exchangeTokens(
	providerName: string,
	code: string,
	redirectUri?: string,
	codeVerifier?: string,
	state?: string,
	meta?: Record<string, unknown>,
) {
	const provider = getProvider(providerName)
	const config = provider.prepareConfig
		? await provider.prepareConfig(provider.config, meta || {})
		: provider.config

	const tokens = await provider.exchangeToken(
		config,
		code,
		redirectUri,
		codeVerifier,
		state,
		meta || {},
	)

	let extra = null
	if (provider.postExchange) {
		extra = await provider.postExchange(tokens)
	}

	return provider.mapTokens(tokens, extra)
}

/**
 * Request device code (for device_code flow)
 */
export async function requestDeviceCode(providerName, codeChallenge, options) {
	const provider = getProvider(providerName)
	if (provider.flowType !== "device_code") {
		throw new Error(`Provider ${providerName} does not support device code flow`)
	}
	return await provider.requestDeviceCode(provider.config, codeChallenge, options || {})
}

/**
 * Poll for token (for device_code flow)
 * @param {string} providerName - Provider name
 * @param {string} deviceCode - Device code from requestDeviceCode
 * @param {string} codeVerifier - PKCE code verifier (optional for some providers)
 * @param {object} extraData - Extra data from device code response (e.g. clientId/clientSecret for Kiro)
 */
export async function pollForToken(providerName, deviceCode, codeVerifier, extraData) {
	const provider = getProvider(providerName)
	if (provider.flowType !== "device_code") {
		throw new Error(`Provider ${providerName} does not support device code flow`)
	}

	const result = await provider.pollToken(provider.config, deviceCode, codeVerifier, extraData)

	if (result.ok) {
		// For device code flows, success is only when we have an access token
		if (result.data.access_token) {
			// Call postExchange to get additional data (copilotToken, userInfo, etc.)
			let extra = null
			if (provider.postExchange) {
				try {
					extra = await provider.postExchange(result.data)
				} catch (err) {
					// The grant succeeded but post-login exchange failed (e.g. Muse key
					// mint). The device code is one-shot, so re-polling can never
					// recover - surface as fatal so the client stops and shows the error.
					console.warn(`[oauth] ${providerName} postExchange failed:`, err?.message || err)
					return { success: false, error: "exchange_failed", errorDescription: err.message, fatal: true }
				}
			}
			const tokens = provider.mapTokens(result.data, extra)
			// Kiro IDC/Builder-ID tokens lack profileArn; resolve it to avoid 403
			if (providerName === "kiro" && !tokens.providerSpecificData?.profileArn) {
				const profileArn = await fetchKiroProfileArn(tokens.accessToken)
				if (profileArn) tokens.providerSpecificData.profileArn = profileArn
			}
			return { success: true, tokens }
		} else {
			// Check if it's still pending authorization
			if (result.data.error === "authorization_pending" || result.data.error === "slow_down") {
				// This is not a failure, just still waiting
				return {
					success: false,
					error: result.data.error,
					errorDescription: result.data.error_description || result.data.message,
					pending: result.data.error === "authorization_pending",
				}
			} else {
				// Actual error
				return {
					success: false,
					error: result.data.error || "no_access_token",
					errorDescription:
						result.data.error_description || result.data.message || "No access token received",
				}
			}
		}
	}

	return {
		success: false,
		error: result.data.error,
		errorDescription: result.data.error_description,
	}
}

// Run-once guard across the process lifetime
let codexBackfillDone = false

// Backfill email + chatgpt account info for existing codex OAuth connections missing them
export async function backfillCodexEmails() {
	if (codexBackfillDone) return
	codexBackfillDone = true
	try {
		const { getProviderConnections, updateProviderConnection } = await import("@/lib/localDb")
		const connections = await getProviderConnections()
		const targets = connections.filter((c) => {
			if (c.provider !== "codex" || c.authType !== "oauth" || !c.idToken) return false
			const hasEmail = !!c.email
			const hasAccountInfo = !!c.providerSpecificData?.chatgptAccountId
			return !hasEmail || !hasAccountInfo
		})
		for (const conn of targets) {
			const info = extractCodexAccountInfo(conn.idToken)
			if (!info.email && !info.chatgptAccountId) continue
			const patch: {
				email?: string
				providerSpecificData?: Record<string, unknown>
			} = {}
			if (!conn.email && info.email) patch.email = info.email as string
			if (info.chatgptAccountId || info.chatgptPlanType) {
				patch.providerSpecificData = {
					...(conn.providerSpecificData || {}),
					chatgptAccountId: info.chatgptAccountId,
					chatgptPlanType: info.chatgptPlanType,
				}
			}
			if (Object.keys(patch).length) {
				await updateProviderConnection(conn.id, patch)
			}
		}
	} catch (err) {
		codexBackfillDone = false
		console.log("backfillCodexEmails failed:", err?.message || err)
	}
}
