import { makeRequest } from "./core.js"

// API KEYS API
// ============================================================================

/**
 * Get all API keys
 * @returns {Promise<Object>} { success, data: { keys } }
 */
async function getApiKeys() {
	return makeRequest("GET", "/api/keys")
}

/**
 * Create new API key
 * @param {string} name - Key name
 * @returns {Promise<Object>} { success, data: { key, name, id, machineId } }
 */
async function createApiKey(name) {
	return makeRequest("POST", "/api/keys", { name })
}

/**
 * Delete API key
 * @param {string} id - Key ID
 * @returns {Promise<Object>} { success, data: { success } }
 */
async function deleteApiKey(id) {
	return makeRequest("DELETE", `/api/keys/${id}`)
}

// ============================================================================
// COMBOS API
// ============================================================================

/**
 * Get all combos
 * @returns {Promise<Object>} { success, data: { combos } }
 */
async function getCombos() {
	return makeRequest("GET", "/api/combos")
}

/**
 * Get combo by ID
 * @param {string} id - Combo ID
 * @returns {Promise<Object>} { success, data: combo }
 */
async function getComboById(id) {
	return makeRequest("GET", `/api/combos/${id}`)
}

/**
 * Create new combo
 * @param {Object} data - Combo data { name, models }
 * @returns {Promise<Object>} { success, data: combo }
 */
async function createCombo(data) {
	return makeRequest("POST", "/api/combos", data)
}

/**
 * Update combo
 * @param {string} id - Combo ID
 * @param {Object} data - Update data { name?, models? }
 * @returns {Promise<Object>} { success, data: combo }
 */
async function updateCombo(id, data) {
	return makeRequest("PUT", `/api/combos/${id}`, data)
}

/**
 * Delete combo
 * @param {string} id - Combo ID
 * @returns {Promise<Object>} { success, data: { success } }
 */
async function deleteCombo(id) {
	return makeRequest("DELETE", `/api/combos/${id}`)
}

// ============================================================================
// CLI TOOLS API
// ============================================================================

/**
 * Get CLI tool settings
 * @param {string} tool - Tool name: claude | codex | droid | openclaw
 * @param {string} [profile] - Hermes profile name (defaults to the default profile)
 * @returns {Promise<Object>} { success, data: { installed, has9Router, ... } }
 */
async function getCliToolSettings(tool, profile) {
	const qs = profile ? `?profile=${encodeURIComponent(profile)}` : ""
	return makeRequest("GET", `/api/cli-tools/${tool}-settings${qs}`)
}

/**
 * Apply CLI tool settings (POST)
 * @param {string} tool - Tool name: claude | codex | droid | openclaw
 * @param {Object} body - Payload depends on tool
 * @returns {Promise<Object>} { success, data }
 */
async function applyCliToolSettings(tool, body) {
	return makeRequest("POST", `/api/cli-tools/${tool}-settings`, body)
}

/**
 * Reset CLI tool settings (DELETE)
 * @param {string} tool - Tool name: claude | codex | droid | openclaw
 * @param {string} [profile] - Hermes profile name (defaults to the default profile)
 * @returns {Promise<Object>} { success, data }
 */
async function resetCliToolSettings(tool, profile) {
	const qs = profile ? `?profile=${encodeURIComponent(profile)}` : ""
	return makeRequest("DELETE", `/api/cli-tools/${tool}-settings${qs}`)
}

/**
 * List Hermes profiles (default home + ~/.hermes/profiles/*)
 * @returns {Promise<Object>} { success, data: { profiles: [...] } }
 */
async function listHermesProfiles() {
	return makeRequest("GET", "/api/cli-tools/hermes-profiles")
}

// ============================================================================
// SETTINGS API
// ============================================================================

/**
 * Get settings
 * @returns {Promise<Object>} { success, data: settings }
 */
async function getSettings() {
	return makeRequest("GET", "/api/settings")
}

/**
 * Update settings
 * @param {Object} data - Settings data
 * @returns {Promise<Object>} { success, data: settings }
 */
async function updateSettings(data) {
	return makeRequest("PATCH", "/api/settings", data)
}

/**
 * Reset dashboard password to default (clears stored hash server-side)
 * @returns {Promise<Object>} { success }
 */
async function resetPassword() {
	return makeRequest("POST", "/api/auth/reset-password")
}

// ============================================================================
// MODELS API
// ============================================================================

/**
 * Get all models (internal API)
 * @returns {Promise<Object>} { success, data: { models } }
 */
async function getModels() {
	return makeRequest("GET", "/api/models")
}

/**
 * Get available models from active providers + combos (OpenAI compatible)
 * @returns {Promise<Object>} { success, data: { object, data: [...models] } }
 */
async function getAvailableModels() {
	return makeRequest("GET", "/v1/models")
}

// ============================================================================

export {
	applyCliToolSettings,
	createApiKey,
	createCombo,
	deleteApiKey,
	deleteCombo,
	getApiKeys,
	getAvailableModels,
	getCliToolSettings,
	getComboById,
	getCombos,
	getModels,
	getSettings,
	listHermesProfiles,
	resetCliToolSettings,
	resetPassword,
	updateCombo,
	updateSettings,
}
