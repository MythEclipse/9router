// Build OpenAI chat.completion.chunk. Caller supplies id/created/model so each
// translator keeps its exact id-generation + created semantics (no Date.now here).

/** One choice inside a streamed chunk. */
export interface ChunkChoice {
	index: number
	delta: unknown
	finish_reason: unknown
}

/**
 * Streamed OpenAI chunk. `usage` is attached by translators on the final chunk
 * only (OpenAI's include_usage semantics), so it is optional.
 */
export interface Chunk {
	id: unknown
	object: string
	created: unknown
	model: unknown
	choices: ChunkChoice[]
	usage?: unknown
}

export function buildChunk({ id, created, model }, delta, finishReason = null): Chunk {
	return {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	}
}
