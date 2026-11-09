import { makeRequest } from "./core.js"

// PROVIDER NODES API (custom providers)
// ============================================================================

async function getProviderNodes() {
	return makeRequest("GET", "/api/provider-nodes")
}

async function createProviderNode(data) {
	return makeRequest("POST", "/api/provider-nodes", data)
}

async function updateProviderNode(id, data) {
	return makeRequest("PUT", `/api/provider-nodes/${id}`, data)
}

async function deleteProviderNode(id) {
	return makeRequest("DELETE", `/api/provider-nodes/${id}`)
}

async function validateProviderNode(data) {
	return makeRequest("POST", "/api/provider-nodes/validate", data)
}

// ============================================================================
// TUNNEL API
// ============================================================================

/**
 * Get tunnel status
 * @returns {Promise<Object>} { success, data: { enabled, tunnelUrl, shortId, running } }
 */
async function getTunnelStatus() {
	return makeRequest("GET", "/api/tunnel/status")
}

/**
 * Enable tunnel
 * @returns {Promise<Object>} { success, data: { tunnelUrl, shortId } }
 */
async function enableTunnel() {
	return makeRequest("POST", "/api/tunnel/enable")
}

/**
 * Disable tunnel
 * @returns {Promise<Object>} { success, data: { success } }
 */
async function disableTunnel() {
	return makeRequest("POST", "/api/tunnel/disable")
}

export {
	createProviderNode,
	deleteProviderNode,
	disableTunnel,
	enableTunnel,
	getProviderNodes,
	getTunnelStatus,
	updateProviderNode,
	validateProviderNode,
}
