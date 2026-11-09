import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import path from "node:path"
import {
	DEFAULT_HOST,
	DEFAULT_MODEL,
	DEFAULT_PORT,
	DEFAULT_TIMEOUT_SEC,
	FAILED_STATUSES,
	gatewayRequest,
	HELP,
	imageInputToUrl,
	parseArgs,
	pollUntilDone,
	sanitizeText,
	TERMINAL_STATUSES,
} from "./args.js"

async function downloadToFile(url, outputPath, { signal } = {}) {
	const partPath = `${outputPath}.part`
	await new Promise((resolve, reject) => {
		const cleanupAnd = (fn) => (err) => {
			try {
				fs.unlinkSync(partPath)
			} catch {
				/* not created yet */
			}
			fn(err)
		}
		const get = (target, redirectsLeft) => {
			const mod = target.startsWith("https:") ? https : http
			const req = mod.get(target, { signal }, (res) => {
				if (
					res.statusCode >= 300 &&
					res.statusCode < 400 &&
					res.headers.location &&
					redirectsLeft > 0
				) {
					res.resume()
					return get(new URL(res.headers.location, target).toString(), redirectsLeft - 1)
				}
				if (res.statusCode !== 200) {
					res.resume()
					return cleanupAnd(reject)(new Error(`Download failed: HTTP ${res.statusCode}`))
				}
				const out = fs.createWriteStream(partPath)
				res.pipe(out)
				out.on("finish", () => out.close(resolve))
				out.on("error", cleanupAnd(reject))
				res.on("error", cleanupAnd(reject))
			})
			req.on("error", cleanupAnd(reject))
		}
		get(url, 5)
	})
	fs.renameSync(partPath, outputPath)
}

async function run(argv) {
	let opts
	try {
		opts = parseArgs(argv)
	} catch (err) {
		console.error(`❌ ${err.message}`)
		console.log(HELP)
		return 1
	}
	if (opts.help) {
		console.log(HELP)
		return 0
	}
	if (!opts.prompt) {
		console.error("❌ --prompt is required")
		console.log(HELP)
		return 1
	}

	const controller = new AbortController()
	const partPath = `${opts.output}.part`
	const onSigint = () => {
		controller.abort()
		try {
			fs.unlinkSync(partPath)
		} catch {
			/* absent */
		}
		console.error("\n✋ Cancelled")
		process.exit(130)
	}
	process.on("SIGINT", onSigint)

	try {
		const body = { model: opts.model, prompt: opts.prompt }
		if (opts.duration) body.duration = opts.duration
		if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio
		if (opts.resolution) body.resolution = opts.resolution
		if (opts.image) body.image = { url: imageInputToUrl(opts.image) }

		console.log(`🎬 Requesting video (${opts.model})…`)
		const create = await gatewayRequest({
			host: opts.host,
			port: opts.port,
			apiKey: opts.apiKey,
			method: "POST",
			reqPath: "/v1/videos/generations",
			body,
			signal: controller.signal,
		})

		if (create.status !== 200 || !create.body?.request_id) {
			const detail =
				create.body?.error?.message || create.body?.error || create.raw || `HTTP ${create.status}`
			console.error(
				`❌ Create failed: ${sanitizeText(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500)}`,
			)
			if (create.status === 400 && /No credentials/i.test(String(detail))) {
				console.error("   Connect an xAI account first: dashboard → Providers → xAI (Grok).")
			}
			return 1
		}

		const requestId = create.body.request_id
		const connectionId = create.headers["x-9router-connection-id"] || null
		console.log(`📋 Job accepted: ${requestId}`)

		let lastLine = ""
		const result = await pollUntilDone({
			host: opts.host,
			port: opts.port,
			apiKey: opts.apiKey,
			requestId,
			connectionId,
			timeoutSec: opts.timeoutSec,
			pollIntervalMs: opts.pollIntervalMs,
			signal: controller.signal,
			onProgress: (status, progress) => {
				const line = `⏳ ${status}${Number.isFinite(progress) ? ` ${progress}%` : ""}`
				if (line !== lastLine) {
					lastLine = line
					if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${line}`)
					else console.log(line)
				}
			},
		})
		if (process.stdout.isTTY) process.stdout.write("\n")

		const videoUrl = result.video?.url || result.video?.file_output?.public_url
		if (!videoUrl) {
			console.error("❌ Job finished but no video URL was returned")
			return 1
		}

		console.log("⬇️  Downloading…")
		await downloadToFile(videoUrl, opts.output, { signal: controller.signal })
		console.log(`✅ Saved ${opts.output}`)
		return 0
	} catch (err) {
		if (process.stdout.isTTY) process.stdout.write("\n")
		console.error(`❌ ${sanitizeText(err?.message || String(err))}`)
		return 1
	} finally {
		process.removeListener("SIGINT", onSigint)
	}
}

export { downloadToFile, run }
