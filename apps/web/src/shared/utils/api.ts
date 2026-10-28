/**
 * API utility functions for making HTTP requests
 */

const DEFAULT_HEADERS = {
	"Content-Type": "application/json",
}

/** An APIError carries the HTTP status and the parsed body alongside the message. */
export class APIError extends Error {
	status: number
	data: unknown

	constructor(message: string, status: number, data: unknown) {
		super(message)
		this.name = "APIError"
		this.status = status
		this.data = data
	}
}

/**
 * Make a GET request
 * @param {string} url - API endpoint
 * @param {object} options - Fetch options
 * @returns {Promise<object>}
 */
export async function get(url: string, options: RequestInit = {}) {
	const response = await fetch(url, {
		method: "GET",
		headers: { ...DEFAULT_HEADERS, ...options.headers },
		...options,
	})
	return handleResponse(response)
}

/**
 * Make a POST request
 * @param {string} url - API endpoint
 * @param {object} data - Request body
 * @param {object} options - Fetch options
 * @returns {Promise<object>}
 */
export async function post(url: string, data: unknown, options: RequestInit = {}) {
	const response = await fetch(url, {
		method: "POST",
		headers: { ...DEFAULT_HEADERS, ...options.headers },
		body: JSON.stringify(data),
		...options,
	})
	return handleResponse(response)
}

/**
 * Make a PUT request
 * @param {string} url - API endpoint
 * @param {object} data - Request body
 * @param {object} options - Fetch options
 * @returns {Promise<object>}
 */
export async function put(url: string, data: unknown, options: RequestInit = {}) {
	const response = await fetch(url, {
		method: "PUT",
		headers: { ...DEFAULT_HEADERS, ...options.headers },
		body: JSON.stringify(data),
		...options,
	})
	return handleResponse(response)
}

/**
 * Make a DELETE request
 * @param {string} url - API endpoint
 * @param {object} options - Fetch options
 * @returns {Promise<object>}
 */
export async function del(url: string, options: RequestInit = {}) {
	const response = await fetch(url, {
		method: "DELETE",
		headers: { ...DEFAULT_HEADERS, ...options.headers },
		...options,
	})
	return handleResponse(response)
}

/**
 * Handle API response
 * @param {Response} response - Fetch response
 * @returns {Promise<object>}
 */
async function handleResponse(response: Response) {
	const data = await response.json()

	if (!response.ok) {
		throw new APIError(data?.error || "An error occurred", response.status, data)
	}

	return data
}

const api = { get, post, put, del }
export default api
