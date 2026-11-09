import { FORMATS } from "../translator/formats.ts"

export const BUFFER_TOKENS = 2000

export function addBufferToUsage(usage) {
	if (!usage || typeof usage !== "object") return usage

	const result = { ...usage }

	// Claude format
	if (result.input_tokens !== undefined) {
		result.input_tokens += BUFFER_TOKENS
	}

	// OpenAI format
	if (result.prompt_tokens !== undefined) {
		result.prompt_tokens += BUFFER_TOKENS
	}

	// Calculate or update total_tokens
	if (result.total_tokens !== undefined) {
		result.total_tokens += BUFFER_TOKENS
	} else if (result.prompt_tokens !== undefined && result.completion_tokens !== undefined) {
		// Calculate total_tokens if not exists
		result.total_tokens = result.prompt_tokens + result.completion_tokens
	}

	return result
}

/**
 * Apply token multipliers for custom/virtual models (e.g. 5x completion output tokens)
 * @param {object} usage - Usage object containing prompt_tokens / completion_tokens
 * @param {{ inputMultiplier?: number, outputMultiplier?: number }} multipliers
 * @returns {object}
 */
export function estimateInputTokens(body) {
	if (!body || typeof body !== "object") return 0

	try {
		// Calculate total body size (includes messages, tools, system, thinking config, etc.)
		const bodyStr = JSON.stringify(body)
		const totalChars = bodyStr.length

		// Estimate: ~4 chars per token (rough average across all tokenizers)
		return Math.ceil(totalChars / 4)
	} catch (_err) {
		// Fallback if stringify fails
		return 0
	}
}

/**
 * Estimate output tokens from content length
 */
export function estimateOutputTokens(contentLength) {
	if (!contentLength || contentLength <= 0) return 0
	return Math.max(1, Math.floor(contentLength / 4))
}

/**
 * Format usage object based on target format
 * @param {number} inputTokens - Input/prompt tokens
 * @param {number} outputTokens - Output/completion tokens
 * @param {string} targetFormat - Target format from FORMATS
 */
export function formatUsage(inputTokens, outputTokens, targetFormat) {
	// Claude format uses input_tokens/output_tokens
	if (targetFormat === FORMATS.CLAUDE) {
		return addBufferToUsage({
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			estimated: true,
		})
	}

	// Default: OpenAI format (works for openai, gemini, responses, etc.)
	return addBufferToUsage({
		prompt_tokens: inputTokens,
		completion_tokens: outputTokens,
		total_tokens: inputTokens + outputTokens,
		estimated: true,
	})
}

/**
 * Estimate full usage when provider doesn't return it
 * @param {object} body - Request body for input token estimation
 * @param {number} contentLength - Content length for output token estimation
 * @param {string} targetFormat - Target format from FORMATS constant
 */
export function estimateUsage(body, contentLength, targetFormat = FORMATS.OPENAI) {
	return formatUsage(estimateInputTokens(body), estimateOutputTokens(contentLength), targetFormat)
}

/**
 * Log usage with cache info (green color)
 */
