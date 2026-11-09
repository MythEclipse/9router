import { makeRequest } from "./core.js"

// ============================================================================
// PROVIDERS API
// ============================================================================

/**
 * Get all providers
 * @returns {Promise<Object>} { success, data: { connections } }
 */
async function getProviders() {
	return makeRequest("GET", "/api/providers")
}

/**
 * Get provider by ID
 * @param {string} id - Provider ID
 * @returns {Promise<Object>} { success, data: { connection } }
 */
async function getProviderById(id) {
	return makeRequest("GET", `/api/providers/${id}`)
}

/**
 * Test provider connection
 * @param {string} id - Provider ID
 * @returns {Promise<Object>} { success, data: { valid, error } }
 */
async function testProvider(id) {
	return makeRequest("POST", `/api/providers/${id}/test`)
}

/**
 * Delete provider
 * @param {string} id - Provider ID
 * @returns {Promise<Object>} { success, data: { message } }
 */
async function deleteProvider(id) {
	return makeRequest("DELETE", `/api/providers/${id}`)
}

/**
 * Get provider models
 * @param {string} id - Provider ID
 * @returns {Promise<Object>} { success, data: { provider, connectionId, models } }
 */
async function getProviderModels(id) {
	return makeRequest("GET", `/api/providers/${id}/models`)
}

// ============================================================================
// OAUTH API
// ============================================================================

/**
 * Get OAuth authorization URL
 * @param {string} provider - Provider ID
 * @returns {Promise<Object>} { success, data: { authUrl, codeVerifier, state, redirectUri } }
 */
async function getOAuthAuthUrl(provider) {
	// Codex requires fixed port 1455 and path /auth/callback
	const redirectUri =
		provider === "codex" ? "http://localhost:1455/auth/callback" : "http://localhost:20128/callback"
	return makeRequest(
		"GET",
		`/api/oauth/${provider}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
	)
}

/**
 * Exchange OAuth authorization code for token
 * @param {string} provider - Provider ID
 * @param {Object} data - { code, redirectUri, codeVerifier, state }
 * @returns {Promise<Object>} { success, data }
 */
async function exchangeOAuthCode(provider, data) {
	return makeRequest("POST", `/api/oauth/${provider}/exchange`, data)
}

/**
 * Get OAuth device code
 * @param {string} provider - Provider ID
 * @returns {Promise<Object>} { success, data: { device_code, user_code, verification_uri, verification_uri_complete, codeVerifier, extraData } }
 */
async function getOAuthDeviceCode(provider) {
	return makeRequest("GET", `/api/oauth/${provider}/device-code`)
}

/**
 * Poll OAuth token using device code
 * @param {string} provider - Provider ID
 * @param {Object} data - { deviceCode, codeVerifier, extraData }
 * @returns {Promise<Object>} { success, data: { pending } }
 */
async function pollOAuthToken(provider, data) {
	return makeRequest("POST", `/api/oauth/${provider}/poll`, data)
}

/**
 * Create API key provider connection
 * @param {Object} data - { provider, name, apiKey }
 * @returns {Promise<Object>} { success, data }
 */
async function createApiKeyProvider(data) {
	return makeRequest("POST", "/api/providers", data)
}

/**
 * Update provider connection
 * @param {string} id - Connection ID
 * @param {Object} data - { name, priority, defaultModel, isActive }
 * @returns {Promise<Object>} { success, data: { connection } }
 */
async function updateConnection(id, data) {
	return makeRequest("PUT", `/api/providers/${id}`, data)
}

// ============================================================================

export {
	createApiKeyProvider,
	deleteProvider,
	deleteProvider as deleteConnection,
	exchangeOAuthCode,
	getOAuthAuthUrl,
	getOAuthDeviceCode,
	getProviderById,
	getProviderModels,
	getProviders,
	pollOAuthToken,
	testProvider,
	testProvider as testConnection,
	updateConnection,
}
