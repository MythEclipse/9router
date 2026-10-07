// Cache-breakpoint budget for Anthropic-format bodies.
//
// The upstream Messages API rejects a request carrying more cache_control
// markers than it accepts, so a marker budget is a protocol constraint, not a
// style choice. Two things make the budget dynamic:
//   - a model/config may advertise fewer markers than the proxy default
//     (cache_supported: false means the client still wants a breakpoint —
//      exactly one, on the last system block — while a fresh-context request
//      wants none at all),
//   - the client may have already spent a larger budget than this turn allows.
// In both cases markers must be DROPPED, never shifted: a cache_control is a
// prefix anchor, so removing a marker silently moves the breakpoint and breaks
// the chain the cache was built on. Only tail-most markers may go, because the
// head anchors (last system block, last cacheable tool) are what every later
// turn re-reads.

// Default budget this proxy applies when no config says otherwise.
export const CACHE_DEFAULT_MARKERS = 4;
// Highest budget a config may ask for. Nothing in the supported Claude family
// advertises more than this, so a larger number is a config typo, not a wish.
export const CACHE_MAX_MARKERS = 6;

// Ranks decide which markers survive a shrink. Higher rank = keep longer.
// They mirror prompt order (tools → system → messages): a marker on the last
// system block already covers the tools block, so it caches the larger prefix
// and outlives a tools marker when only one slot remains.
const RANK_SYSTEM_LAST = Infinity;
const RANK_TOOL = 1e9;
const RANK_SYSTEM_OTHER = -1; // older system markers go first

/**
 * Effective marker budget for one request.
 *
 * @param {object} config
 * @param {boolean} [config.cacheSupported=true]  false → the model does not cache
 * @param {number}  [config.maxMarkers=4]         budget when caching is on
 * @param {boolean} [config.newContextReason=false] fresh context → nothing to re-read
 * @returns {number} 0..CACHE_MAX_MARKERS
 */
export function newCacheLimit({
  cacheSupported = true,
  maxMarkers = CACHE_DEFAULT_MARKERS,
  newContextReason = false,
} = {}) {
  // Caching off: the client's own marker must still land somewhere, so exactly
  // one survives (the last system block) unless this turn starts a fresh
  // context — then re-reading it would buy nothing, so none do.
  if (cacheSupported === false) return newContextReason ? 0 : 1;
  const requested = Number.isFinite(maxMarkers) ? maxMarkers : CACHE_DEFAULT_MARKERS;
  return Math.max(0, Math.min(requested, CACHE_MAX_MARKERS));
}

/** Every marker in document order, each with the rank that keeps it alive. */
function collectMarkers(body) {
  const found = [];
  const system = Array.isArray(body?.system) ? body.system : [];
  system.forEach((block, i) => {
    if (block?.cache_control) {
      const isLast = i === system.length - 1;
      found.push({ block, rank: isLast ? RANK_SYSTEM_LAST + i : RANK_SYSTEM_OTHER });
    }
  });

  const tools = Array.isArray(body?.tools) ? body.tools : [];
  tools.forEach((tool) => {
    if (tool?.cache_control) found.push({ block: tool, rank: RANK_TOOL });
  });

  let chain = 0;
  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      if (Array.isArray(message?.content)) {
        for (const block of message.content) {
          if (block?.cache_control) found.push({ block, rank: chain });
          chain += 1;
        }
      } else if (message?.content && typeof message.content === "object" && message.content.cache_control) {
        // single-object content is one position in the chain too
        found.push({ block: message.content, rank: chain });
        chain += 1;
      }
    }
  }
  return found;
}

/** Total markers across system, tools and messages. */
export function countCacheControlBlocks(body) {
  return collectMarkers(body).length;
}

/**
 * Read the cache budget out of a provider's config overrides. Both spellings
 * are accepted because overrides arrive from settings (camelCase) and from
 * provider config dumps (snake_case). Missing keys stay missing so
 * `newCacheLimit` can apply its own defaults.
 *
 * @param {object|null|undefined} overrides
 * @returns {{cacheSupported?:boolean, maxMarkers?:number, newContextReason?:boolean}}
 */
export function cacheConfigFrom(overrides) {
  const source = overrides || {};
  const config = {};
  const cacheSupported = source.cacheSupported ?? source.cache_supported;
  const maxMarkers = source.maxMarkers ?? source.max_markers;
  const newContextReason = source.newContextReason ?? source.new_context_reason;
  if (cacheSupported !== undefined) config.cacheSupported = cacheSupported;
  if (maxMarkers !== undefined) config.maxMarkers = maxMarkers;
  if (newContextReason !== undefined) config.newContextReason = newContextReason;
  return config;
}

/**
 * Drop every marker past `maxMarkers`, keeping the most valuable ones so the
 * surviving anchors still describe the longest prefix.
 *
 * @param {object} body   Anthropic-format request (mutated in place)
 * @param {object} config @see newCacheLimit
 * @returns {{before:number, after:number, dropped:number}}
 */
export function applyClaudeCacheLimits(body, config = {}) {
  const limit = newCacheLimit(config);
  const markers = collectMarkers(body);
  const before = markers.length;

  // Best first; compare rather than subtract so Infinity ranks stay safe.
  const ordered = [...markers].sort((a, b) => (b.rank > a.rank) - (b.rank < a.rank));
  for (const { block } of ordered.slice(limit)) delete block.cache_control;

  return { before, after: Math.min(before, limit), dropped: Math.max(0, before - limit) };
}
