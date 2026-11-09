/**
 * `9router xai video` - generate a Grok Imagine video through the local
 * 9router gateway and save the result as an MP4 file.
 *
 * Flow: POST /v1/videos/generations → poll GET /v1/videos/{request_id}
 * until done/failed/timeout → download video.url → atomic rename.
 *
 * No OAuth tokens or Authorization headers are ever printed.
 */

import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import path from "node:path"

const DEFAULT_PORT = 20128
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_MODEL = "xai/grok-imagine-video"
const DEFAULT_TIMEOUT_SEC = 600
const DEFAULT_POLL_INTERVAL_MS = 5000

const TERMINAL_STATUSES = new Set(["done", "failed", "completed", "error", "expired", "cancelled"])
const FAILED_STATUSES = new Set(["failed", "error", "expired", "cancelled"])

const HELP = `
Usage: 9router xai video --prompt "..." [options]

Generate a Grok Imagine video via your local 9router gateway
(requires a connected xAI account - Grok Build OAuth or API key).

Options:
  --prompt <text>         Video description (required)
  --output <file>         Output MP4 path (default: video.mp4)
  --model <id>            Model (default: ${DEFAULT_MODEL})
  --duration <seconds>    Video duration
  --aspect-ratio <ratio>  e.g. 16:9, 9:16, 1:1
  --resolution <res>      480p | 720p | 1080p
  --image <path-or-url>   Image input for image-to-video
  --timeout <seconds>     Max wait for the job (default: ${DEFAULT_TIMEOUT_SEC})
  --port <port>           Gateway port (default: ${DEFAULT_PORT})
  --host <host>           Gateway host (default: ${DEFAULT_HOST})
  --api-key <key>         9router API key (or env NINE_ROUTER_API_KEY)
  -h, --help              Show this help
`

function sanitizeText(text) {
	return String(text ?? "").replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
}

function parseArgs(argv) {
	const opts = {
		model: DEFAULT_MODEL,
		output: "video.mp4",
		timeoutSec: DEFAULT_TIMEOUT_SEC,
		port: DEFAULT_PORT,
		host: DEFAULT_HOST,
		apiKey: process.env.NINE_ROUTER_API_KEY || null,
		pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
	}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		const next = () => argv[++i]
		if (a === "--prompt") opts.prompt = next()
		else if (a === "--output" || a === "-o") opts.output = next()
		else if (a === "--model") opts.model = next()
		else if (a === "--duration") opts.duration = parseInt(next(), 10)
		else if (a === "--aspect-ratio") opts.aspectRatio = next()
		else if (a === "--resolution") opts.resolution = next()
		else if (a === "--image") opts.image = next()
		else if (a === "--timeout") opts.timeoutSec = parseInt(next(), 10) || DEFAULT_TIMEOUT_SEC
		else if (a === "--port" || a === "-p") opts.port = parseInt(next(), 10) || DEFAULT_PORT
		else if (a === "--host" || a === "-H") opts.host = next() || DEFAULT_HOST
		else if (a === "--api-key") opts.apiKey = next()
		else if (a === "--poll-interval-ms")
			opts.pollIntervalMs = parseInt(next(), 10) || DEFAULT_POLL_INTERVAL_MS
		else if (a === "-h" || a === "--help") opts.help = true
		else {
			throw new Error(`Unknown option: ${a}`)
		}
	}
	return opts
}

/** Local file path → base64 data URL; URLs pass through untouched. */
function imageInputToUrl(input) {
	if (/^(https?:|data:)/i.test(input)) return input
	const buf = fs.readFileSync(input)
	const ext = path.extname(input).toLowerCase()
	const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg"
	return `data:${mime};base64,${buf.toString("base64")}`
}

/** Minimal JSON request against the local gateway. Returns { status, headers, body }. */
function gatewayRequest({ host, port, apiKey, method, reqPath, body, signal }) {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : null
		const headers = { Accept: "application/json" }
		if (payload) {
			headers["Content-Type"] = "application/json"
			headers["Content-Length"] = Buffer.byteLength(payload)
		}
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`

		const req = http.request(
			{ hostname: host, port, path: reqPath, method, headers, signal },
			(res) => {
				let data = ""
				res.on("data", (c) => (data += c))
				res.on("end", () => {
					let parsed = null
					try {
						parsed = data ? JSON.parse(data) : null
					} catch {
						/* keep raw */
					}
					resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data })
				})
			},
		)
		req.on("error", reject)
		if (payload) req.write(payload)
		req.end()
	})
}

const sleep = (ms, signal) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms)
		signal?.addEventListener?.(
			"abort",
			() => {
				clearTimeout(t)
				reject(new Error("aborted"))
			},
			{ once: true },
		)
	})

/**
 * Poll GET /v1/videos/{id} until a terminal status or deadline.
 * @returns {Promise<object>} final poll body (status done) - throws on failed/timeout.
 */
async function pollUntilDone({
	host,
	port,
	apiKey,
	requestId,
	connectionId,
	timeoutSec,
	pollIntervalMs,
	signal,
	onProgress,
}) {
	const deadline = Date.now() + timeoutSec * 1000
	while (true) {
		if (signal?.aborted) throw new Error("aborted")
		if (Date.now() > deadline) {
			throw new Error(`Timed out after ${timeoutSec}s waiting for video job ${requestId}`)
		}

		const res = await gatewayRequestWithConnection({
			host,
			port,
			apiKey,
			requestId,
			connectionId,
			signal,
		})
		if (res.status === 200 && res.body) {
			const status = String(res.body.status || "").toLowerCase()
			onProgress?.(status || "pending", res.body.progress)
			if (FAILED_STATUSES.has(status)) {
				const msg = res.body.error?.message || res.body.error || "video generation failed"
				throw new Error(
					`Job ${requestId} failed: ${sanitizeText(typeof msg === "string" ? msg : JSON.stringify(msg))}`,
				)
			}
			if (TERMINAL_STATUSES.has(status)) return res.body
		} else if (res.status >= 400 && res.status !== 429 && res.status !== 503) {
			throw new Error(`Polling failed (HTTP ${res.status}): ${sanitizeText(res.raw?.slice(0, 300))}`)
		}
		await sleep(pollIntervalMs, signal)
	}
}

function gatewayRequestWithConnection({ host, port, apiKey, requestId, connectionId, signal }) {
	return new Promise((resolve, reject) => {
		const headers = { Accept: "application/json" }
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`
		if (connectionId) headers["x-connection-id"] = connectionId
		const req = http.request(
			{
				hostname: host,
				port,
				path: `/v1/videos/${encodeURIComponent(requestId)}`,
				method: "GET",
				headers,
				signal,
			},
			(res) => {
				let data = ""
				res.on("data", (c) => (data += c))
				res.on("end", () => {
					let parsed = null
					try {
						parsed = data ? JSON.parse(data) : null
					} catch {
						/* keep raw */
					}
					resolve({ status: res.statusCode, body: parsed, raw: data })
				})
			},
		)
		req.on("error", reject)
		req.end()
	})
}

/**
 * Download a URL to `outputPath` via a `.part` temp file with atomic rename.
 * The temp file is removed on any failure.
 */

export {
	DEFAULT_HOST,
	DEFAULT_MODEL,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_PORT,
	DEFAULT_TIMEOUT_SEC,
	FAILED_STATUSES,
	gatewayRequest,
	gatewayRequestWithConnection,
	HELP,
	imageInputToUrl,
	parseArgs,
	pollUntilDone,
	sanitizeText,
	sleep,
	TERMINAL_STATUSES,
}
