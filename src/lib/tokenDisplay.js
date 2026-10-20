// Token-count presentation helpers for the request-details view.
//
// Two storage shapes reach this table and they mean different things:
//
//   OpenAI shape     { prompt_tokens, completion_tokens, prompt_tokens_details: { cached_tokens } }
//                    prompt_tokens is cache-INCLUSIVE — the cached part is already inside it.
//
//   Anthropic shape  { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
//                    input_tokens is cache-EXCLUSIVE — cached reads are billed on top of it.
//
// Reading only one shape is how a real row with 548 fresh + 244,736 cached input and
// 377 output tokens rendered as "Input 244,736 / Output 0", making a healthy request
// look like a broken recorder. Every helper here accepts both shapes.

export function getCachedTokens(tokens) {
  return tokens?.cached_tokens ?? tokens?.prompt_tokens_details?.cached_tokens ?? tokens?.cache_read_input_tokens ?? 0;
}

export function getCacheCreationTokens(tokens) {
  return tokens?.cache_creation_tokens ?? tokens?.prompt_tokens_details?.cache_creation_tokens ?? tokens?.cache_creation_input_tokens ?? 0;
}

export function getOutputTokens(tokens) {
  return tokens?.completion_tokens ?? tokens?.output_tokens ?? 0;
}

/**
 * Total input tokens across both storage shapes.
 *
 * OpenAI shape: prompt_tokens already includes the cached part, so adding the cache
 * again would double count. Legacy rows sometimes stored a cache-exclusive prompt
 * under prompt_tokens, so keep the "cache larger than prompt" fallback for those.
 *
 * Anthropic shape: input_tokens excludes the cache entirely, so the prompt total is
 * input_tokens + cache_read + cache_creation.
 */
export function getInputTokens(tokens) {
  const cache = getCachedTokens(tokens);
  const cacheCreation = getCacheCreationTokens(tokens);

  if (tokens?.prompt_tokens !== undefined && tokens?.prompt_tokens !== null) {
    const prompt = tokens.prompt_tokens;
    return prompt < cache ? cache : prompt;
  }

  const exclusive = tokens?.input_tokens || 0;
  if (exclusive === 0 && cache === 0) return 0;
  return exclusive + cache + cacheCreation;
}
