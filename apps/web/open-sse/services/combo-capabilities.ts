/** Combo capabilities. */
import { getCapabilitiesForModel } from "../providers/capabilities.ts"
import { extractTextContent } from "../translator/formats/gemini.ts"

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput", "tools"])

// How much of a string message `detectRequiredCapabilities` inspects for an
// embedded data URI. A data URI is the payload when present, so it appears at the
// very start; anything beyond this window is prose that cannot introduce one.
const DATA_URI_SCAN_WINDOW = 4096

export function reorderByCapabilities(models, required) {
	if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models
	const hard = [...required].filter((c) => HARD_CAPS.has(c))
	const soft = [...required].filter((c) => !HARD_CAPS.has(c))

	const tierOf = (m) => {
		const slash = typeof m === "string" ? m.indexOf("/") : -1
		const provider = slash > 0 ? m.slice(0, slash) : ""
		const model = slash > 0 ? m.slice(slash + 1) : m
		const caps = getCapabilitiesForModel(provider, model)
		if (!hard.every((c) => caps[c] === true)) return 2
		return soft.every((c) => caps[c] === true) ? 0 : 1
	}

	// Stable sort by tier (Array.prototype.sort is stable in modern engines).
	return models
		.map((m, i) => ({ m, i, t: tierOf(m) }))
		.sort((a, b) => a.t - b.t || a.i - b.i)
		.map((x) => x.m)
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map()

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model - those get stripped + placeholdered downstream instead.
function trailingUserItems(arr) {
	if (!Array.isArray(arr) || arr.length === 0) return []
	const isAssistant = (r) => r === "assistant" || r === "model"
	let i = arr.length - 1
	while (i >= 0 && !isAssistant(arr[i]?.role)) i--
	return arr.slice(i + 1)
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
	const required = new Set()
	if (!body || typeof body !== "object") return required

	const addByMime = (mime) => {
		if (typeof mime !== "string") return
		if (mime.startsWith("image/")) required.add("vision")
		else if (mime === "application/pdf") required.add("pdf")
		else if (mime.startsWith("audio/")) required.add("audioInput")
		else if (mime.startsWith("video/")) required.add("videoInput")
	}

	const scanBlock = (b) => {
		if (!b || typeof b !== "object") return
		const t = b.type
		if (t === "image_url" || t === "image" || t === "input_image") required.add("vision")
		if (t === "input_audio" || t === "audio_url" || t === "audio") required.add("audioInput")
		if (t === "input_video" || t === "video_url" || t === "video") required.add("videoInput")
		if (t === "file" || t === "document" || t === "input_file") {
			// Infer modality from embedded mime when available; fall back to pdf for generic files.
			let fmime = null
			if (b.input_audio?.format) fmime = `audio/${b.input_audio.format}`
			else if (b.file?.file_data) fmime = String(b.file.file_data).match(/^data:([^;,]+)/)?.[1]
			else if (b.source?.media_type) fmime = b.source.media_type
			else if (b.source?.data) fmime = String(b.source.data).match(/^data:([^;,]+)/)?.[1]
			if (fmime) addByMime(fmime)
			else required.add("pdf")
		}
		// gemini parts: inlineData/fileData carry a mime
		addByMime(b.inlineData?.mimeType || b.fileData?.mimeType)
	}

	const scanContent = (content) => {
		if (Array.isArray(content)) for (const b of content) scanBlock(b)
	}

	const scanMessage = (m) => {
		if (!m || typeof m !== "object") return

		// Ollama / Hermes images array (strings or objects)
		if (Array.isArray(m.images) && m.images.length > 0) {
			required.add("vision")
		}

		// Vercel AI SDK / Hermes attachments / experimental_attachments
		const attachments = m.experimental_attachments || m.attachments
		if (Array.isArray(attachments)) {
			for (const att of attachments) {
				if (!att) continue
				const mime =
					att.contentType ||
					att.mediaType ||
					(typeof att.url === "string" && att.url.match(/^data:([^;,]+)/)?.[1])
				if (mime) addByMime(mime)
				else if (att.url || att.data) required.add("vision")
			}
		}

		// Direct message-level modality properties
		if (m.image_url || m.image) required.add("vision")
		if (m.audio_url || m.audio) required.add("audioInput")

		// Scan array content blocks
		scanContent(m.content)

		// Scan string content for embedded data URIs. Bounded on purpose: a data URI
		// can only appear at the start of a content string (it is the whole payload
		// when present), and a multi-megabyte base64 message made the unbounded
		// `includes` scan the full body once per message, per request. The window
		// covers the scheme plus generous leading prose without touching megabytes.
		if (typeof m.content === "string") {
			const head =
				m.content.length > DATA_URI_SCAN_WINDOW ? m.content.slice(0, DATA_URI_SCAN_WINDOW) : m.content
			if (head.includes("data:image/")) required.add("vision")
			else if (head.includes("data:audio/")) required.add("audioInput")
			else if (head.includes("data:application/pdf")) required.add("pdf")
		}
	}

	// Modalities: current user turn only (trailing user run across each known shape).
	for (const m of trailingUserItems(body.messages)) scanMessage(m) // openai / claude / hermes / ollama
	for (const it of trailingUserItems(body.input)) scanContent(it.content) // responses
	const contents = body.contents || body.request?.contents // gemini / antigravity
	for (const c of trailingUserItems(contents)) scanContent(c.parts)

	// search: temporarily disabled in auto-switch (feature not wired yet).

	// tools: when body.tools is a non-empty array or body.tool_choice is present,
	// the request needs a tool-capable model (providers without tools would ignore
	// the tool definitions / tool_choice).
	if (Array.isArray(body.tools) && body.tools.length > 0) required.add("tools")
	else if (body.tool_choice != null) required.add("tools")

	return required
}
