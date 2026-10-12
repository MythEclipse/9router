/**
 * Web search bridge — run a search and speak Anthropic's result blocks.
 *
 * Consumes the unified SearchResult[] produced by handlers/search/ and emits
 * exactly the two blocks Claude Code pairs up:
 *
 *   { type: "server_tool_use", id: "srvtoolu_…", name: "web_search", input }
 *   { type: "web_search_tool_result", tool_use_id: "<same id>", content: [...] }
 *
 * `encrypted_content` is emitted as an empty string on purpose: it is Anthropic's
 * per-citation token, only meaningful to Anthropic's own index. Inventing one
 * would produce citations that resolve to nothing; leaving it absent degrades
 * to title+url, which is what every other gateway does.
 */

import {
  SERVER_TOOL_USE_BLOCK,
  WEB_SEARCH_RESULT_BLOCK,
  WEB_SEARCH_RESULT_ITEM,
  WEB_SEARCH_TOOL_NAME,
  SYNTHETIC_TOOL_USE_ID_PREFIX,
  RESULT_ERROR_MAX_USES,
  MAX_RESULTS_CEILING,
} from "../config/webSearchConstants.js";

/** Deterministic, collision-resistant id in Anthropic's required shape. */
function makeToolUseId() {
  const rand = Math.random().toString(36).slice(2, 10)
    + Math.random().toString(36).slice(2, 10);
  return `${SYNTHETIC_TOOL_USE_ID_PREFIX}${rand}`;
}

/**
 * Map one unified SearchResult to an Anthropic `web_search_result` item.
 * Only keys Claude Code actually reads are emitted.
 */
export function toResultItem(result, index) {
  const item = {
    type: WEB_SEARCH_RESULT_ITEM,
    title: String(result?.title || "").slice(0, 500),
    url: String(result?.url || ""),
  };
  // page_age is what the client renders as "published 3 days ago"; absent is
  // normal for engines that do not return a date.
  if (result?.published_at) item.page_age = result.published_at;
  // Anthropic's own field: opaque content the client echoes back on later turns
  // to keep citations resolvable. 9router has no equivalent upstream cipher,
  // so it carries the snippet — enough for the client to round-trip the block
  // and keep the citation, without pretending to be encrypted.
  item.encrypted_content = String(result?.snippet || "").slice(0, 2000);
  // Deterministic ordering key — the model cites results by index.
  void index;
  return item;
}

/** Map unified results → the Anthropic `content[]` of a tool_result block. */
export function toResultContent(results) {
  const list = Array.isArray(results) ? results : [];
  return list
    .slice(0, MAX_RESULTS_CEILING)
    .filter((r) => r && r.url)
    .map((r, i) => toResultItem(r, i));
}

/**
 * Build the Anthropic block pair for a completed search.
 *
 * @param {object} args
 * @param {string} args.query        the query the model asked for
 * @param {string} args.toolUseId    id to pair both blocks with (pass the
 *                                   model's own call id when it has one)
 * @param {object[]} args.results    unified SearchResult[]
 * @returns {{serverToolUse: object, toolResult: object}}
 */
export function buildSearchBlocks({ query, toolUseId, results }) {
  const id = toolUseId || makeToolUseId();
  const serverToolUse = {
    type: SERVER_TOOL_USE_BLOCK,
    id,
    name: WEB_SEARCH_TOOL_NAME,
    input: { query: String(query || "") },
  };
  const toolResult = {
    type: WEB_SEARCH_RESULT_BLOCK,
    tool_use_id: id,
    content: toResultContent(results),
  };
  return { serverToolUse, toolResult };
}

/**
 * Build the failure variant. `error_code` must be one Anthropic itself defines
 * (RESULT_ERROR_*) — the client renders it verbatim, so an invented code reads
 * as a 9router bug to the user.
 *
 * Never used to hide an empty-but-successful search: that case emits a
 * well-formed result block with zero items, which is honest.
 */
export function buildSearchErrorBlocks({ query, toolUseId, errorCode, message }) {
  const { serverToolUse, toolResult } = buildSearchBlocks({ query, toolUseId, results: [] });
  toolResult.content = [];
  toolResult.error_code = errorCode || RESULT_ERROR_MAX_USES;
  if (message) toolResult.error_message = String(message).slice(0, 500);
  return { serverToolUse, toolResult };
}

/** Human-readable summary injected into the assistant turn when search fails. */
export function searchFailureNotice(message) {
  return `\n\n[web search unavailable: ${String(message || "search provider failed").slice(0, 200)}]`;
}