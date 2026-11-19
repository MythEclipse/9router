import zlib from "node:zlib"
export const COMPRESS_FLAG = { NONE: 0x00, GZIP: 0x01, TRAILER: 0x02, GZIP_TRAILER: 0x03 }
export const CURSOR_STREAM_DEBUG = process.env.CURSOR_STREAM_DEBUG === "1"
export const debugLog = (...args) => {
	if (CURSOR_STREAM_DEBUG) console.log(...args)
}
export function decompressPayload(payload, flags) {
	// Check if payload is JSON error (starts with {"error")
	if (payload.length > 10 && payload[0] === 0x7b && payload[1] === 0x22) {
		try {
			const text = payload.toString("utf-8")
			if (text.startsWith('{"error"')) {
				debugLog(`[DECOMPRESS] Detected JSON error, skipping decompression`)
				return payload
			}
		} catch {}
	}

	if (
		flags === COMPRESS_FLAG.GZIP ||
		flags === COMPRESS_FLAG.TRAILER ||
		flags === COMPRESS_FLAG.GZIP_TRAILER
	) {
		// Primary: try gzip decompression (standard gzip header 0x1f 0x8b)
		try {
			return zlib.gunzipSync(payload)
		} catch (gzipErr) {
			// Fallback: TRAILER and GZIP_TRAILER frames sometimes use raw zlib deflate format
			try {
				return zlib.inflateSync(payload)
			} catch (deflateErr) {
				// Last resort: try raw deflate (no zlib header)
				try {
					return zlib.inflateRawSync(payload)
				} catch (rawErr) {
					debugLog(
						`[DECOMPRESS ERROR] flags=${flags}, payloadSize=${payload.length}, gzip=${gzipErr.message}, deflate=${deflateErr.message}, raw=${rawErr.message}`,
					)
					debugLog(`[DECOMPRESS ERROR] First 50 bytes (hex):`, payload.slice(0, 50).toString("hex"))
					return payload
				}
			}
		}
	}
	return payload
}

// Read one cursor protobuf frame: header + bounds + decompress. Returns status + payload + new offset.
export function readCursorFrame(buffer, offset, frameNum, tag) {
	if (offset + 5 > buffer.length) {
		debugLog(
			`[CURSOR BUFFER${tag}] Reached end, offset=${offset}, remaining=${buffer.length - offset}`,
		)
		return { status: "done" }
	}

	const flags = buffer[offset]
	const length = buffer.readUInt32BE(offset + 1)
	debugLog(
		`[CURSOR BUFFER${tag}] Frame ${frameNum + 1}: flags=0x${flags.toString(16).padStart(2, "0")}, length=${length}`,
	)

	if (offset + 5 + length > buffer.length) {
		debugLog(
			`[CURSOR BUFFER${tag}] Incomplete frame, offset=${offset}, length=${length}, buffer.length=${buffer.length}`,
		)
		return { status: "done" }
	}

	let payload = buffer.slice(offset + 5, offset + 5 + length)
	const newOffset = offset + 5 + length
	payload = decompressPayload(payload, flags)
	if (!payload) {
		debugLog(`[CURSOR BUFFER${tag}] Frame ${frameNum + 1}: decompression failed, skipping`)
		return { status: "skip", offset: newOffset }
	}
	return { status: "ok", payload, offset: newOffset }
}

/**
 * Incremental frame assembler for a length-prefixed protobuf stream.
 *
 * Cursor's reply is `[flags:1][length:4 BE][payload:length]` repeated. `readCursorFrame`
 * can only decode a buffer that already holds a complete frame, which is why the
 * transport used to buffer the whole answer with `arrayBuffer()` — the entire
 * generation arrived as one burst at the end.
 *
 * This class keeps a rolling buffer and emits each frame as soon as its declared
 * length has arrived, so the caller can forward bytes while the upstream is still
 * generating. Feed it whatever chunks arrive; it returns every frame that is now
 * complete and holds the remainder until more bytes come.
 *
 * A frame is only decoded once ALL of its bytes are present, so `decompressPayload`
 * keeps its whole-frame contract and gzip frames still inflate correctly.
 */
export class CursorFrameAssembler {
	private buffer: Buffer = Buffer.alloc(0)
	private frameCount = 0

	constructor(private readonly tag = "") {}

	/**
	 * Feed a chunk. Returns the frames completed by it, in order.
	 * A frame with a broken length is reported as `skip` (matching `readCursorFrame`)
	 * and the assembler keeps going, so one bad frame cannot wedge the stream.
	 */
	push(chunk: Uint8Array | Buffer): Array<{ status: "ok" | "skip"; payload?: Buffer }> {
		if (chunk && chunk.length) {
			this.buffer = this.buffer.length
				? Buffer.concat([this.buffer, Buffer.from(chunk)])
				: Buffer.from(chunk)
		}

		const frames: Array<{ status: "ok" | "skip"; payload?: Buffer }> = []
		let offset = 0
		while (offset + 5 <= this.buffer.length) {
			const length = this.buffer.readUInt32BE(offset + 1)
			const end = offset + 5 + length
			// The rest of this frame has not arrived yet: keep what we have and wait.
			if (end > this.buffer.length) break
			const frame = readCursorFrame(this.buffer, offset, this.frameCount, this.tag)
			this.frameCount++
			if (frame.status === "done") break
			offset = frame.offset
			if (frame.status === "skip") {
				frames.push({ status: "skip" })
				continue
			}
			frames.push({ status: "ok", payload: frame.payload })
		}

		// Drop the bytes already consumed so the buffer does not grow with the answer.
		if (offset > 0) this.buffer = this.buffer.subarray(offset)
		return frames
	}

	/** True when a partial frame is still waiting for bytes. */
	get pendingBytes(): number {
		return this.buffer.length
	}
}
