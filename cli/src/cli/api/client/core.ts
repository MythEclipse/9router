import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import nodeMachineId from "node-machine-id"

const { machineIdSync } = nodeMachineId

// Default configuration
const DEFAULT_CONFIG = {
	host: "localhost",
	port: 20128,
	protocol: "http:",
}

const CLI_TOKEN_HEADER = "x-9r-cli-token"
const CLI_TOKEN_SALT = "9r-cli-auth"
const APP_NAME = "9router"

function getDataDir() {
	if (process.env.DATA_DIR) return process.env.DATA_DIR
	if (process.platform === "win32") {
		return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME)
	}
	return path.join(os.homedir(), `.${APP_NAME}`)
}

const MACHINE_ID_FILE = path.join(getDataDir(), "machine-id")
const AUTH_DIR = path.join(getDataDir(), "auth")
const CLI_SECRET_FILE = path.join(AUTH_DIR, "cli-secret")

let config = { ...DEFAULT_CONFIG }
let cachedCliToken = null
let cachedCliSecret = null

// Read raw machineId from shared file (written by server) → guarantees token match
function loadRawMachineId() {
	try {
		const raw = fs.readFileSync(MACHINE_ID_FILE, "utf8").trim()
		if (raw) return raw
	} catch {}
	try {
		return machineIdSync()
	} catch {
		return ""
	}
}

// Random secret shared with server via file → token unpredictable from machineId alone.
function loadCliSecret() {
	if (cachedCliSecret) return cachedCliSecret
	try {
		cachedCliSecret = fs.readFileSync(CLI_SECRET_FILE, "utf8").trim()
		if (cachedCliSecret) return cachedCliSecret
	} catch {}
	cachedCliSecret = crypto.randomBytes(32).toString("hex")
	try {
		fs.mkdirSync(AUTH_DIR, { recursive: true })
		fs.writeFileSync(CLI_SECRET_FILE, cachedCliSecret, { mode: 0o600 })
	} catch {}
	return cachedCliSecret
}

function getCliToken() {
	if (cachedCliToken !== null) return cachedCliToken
	const raw = loadRawMachineId()
	const secret = loadCliSecret()
	cachedCliToken = raw
		? crypto
				.createHash("sha256")
				.update(raw + CLI_TOKEN_SALT + secret)
				.digest("hex")
				.substring(0, 16)
		: ""
	return cachedCliToken
}

/**
 * Configure API client
 * @param {Object} options - Configuration options
 * @param {string} options.host - API host
 * @param {number} options.port - API port
 * @param {string} options.protocol - Protocol (http: or https:)
 */
function configure(options = {}) {
	config = { ...config, ...options }
}

/**
 * Make HTTP request to API
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {Object} body - Request body (optional)
 * @returns {Promise<Object>} Response with { success, data/error }
 */
function makeRequest(method, path, body = null) {
	return new Promise((resolve) => {
		const httpModule = config.protocol === "https:" ? https : http

		const options = {
			hostname: config.host,
			port: config.port,
			path: path,
			method: method,
			headers: {
				"Content-Type": "application/json",
				[CLI_TOKEN_HEADER]: getCliToken(),
			},
		}

		// Add Content-Length for POST/PUT requests
		if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
			const bodyString = JSON.stringify(body)
			options.headers["Content-Length"] = Buffer.byteLength(bodyString)
		}

		const req = httpModule.request(options, (res) => {
			let data = ""

			res.on("data", (chunk) => {
				data += chunk
			})

			res.on("end", () => {
				try {
					const parsed = data ? JSON.parse(data) : {}

					// Check if response indicates error
					if (res.statusCode >= 400 || parsed.error) {
						resolve({
							success: false,
							error: parsed.error || `HTTP ${res.statusCode}`,
							statusCode: res.statusCode,
						})
					} else {
						resolve({
							success: true,
							data: parsed,
							statusCode: res.statusCode,
						})
					}
				} catch (err) {
					resolve({
						success: false,
						error: `Failed to parse response: ${err.message}`,
					})
				}
			})
		})

		req.on("error", (err) => {
			resolve({
				success: false,
				error: `Network error: ${err.message}`,
			})
		})

		req.on("timeout", () => {
			req.destroy()
			resolve({
				success: false,
				error: "Request timeout",
			})
		})

		// Set timeout (30 seconds)
		req.setTimeout(30000)

		// Write body if present
		if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
			req.write(JSON.stringify(body))
		}

		req.end()
	})
}

export { configure, makeRequest }
