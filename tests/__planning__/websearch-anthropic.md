# Web search (Anthropic protocol) — plan

Goal: Claude Code pointing `ANTHROPIC_BASE_URL` at 9router must get working web
search, natively, via Anthropic's server-tool contract — not a client-side
tool loop.

## Authoritative wire contract (extracted from Claude Code 2.1.296 binary)

Request (tool declaration, top-level `tools[]`):

    { type: "web_search_20250305", name: "web_search", max_uses: N,
      allowed_domains: [...], blocked_domains: [...] }

Response (assistant turn, content blocks):

    { type: "server_tool_use", id: "srvtoolu_…", name: "web_search", input: {query} }
    { type: "web_search_tool_result",
      tool_use_id: "<same srvtoolu_ id>",
      content: [ { type: "web_search_result", title, url, page_age,
                   encrypted_content, … } ] }

Invariants:
- `server_tool_use.id` MUST match `/^srvtoolu_[a-zA-Z0-9_]+$/` (already enforced in
  formats/claude.js:168).
- `web_search_tool_result.tool_use_id` MUST equal that id — it is the pairing key.

## Architecture (mirrors safeguards/)

1. `open-sse/config/webSearchConstants.js`   — contract constants.
2. `open-sse/handlers/webSearchProtocol.js`  — detect request, detect upstream
   pass-through capability, plan the two lanes.
3. `open-sse/handlers/webSearchBridge.js`    — lane 2: run the search via
   `handleSearchCore` and map unified SearchResult[] → Anthropic result blocks.
4. `open-sse/handlers/webSearchStream.js`    — streaming injection (final
   `message_delta` / non-streaming body), same shape as safeguardsStream.
5. `open-sse/handlers/webSearchCredentials.js` — resolve the search provider's
   credentials at call time from the provider store (never inline).

## Two lanes

- **passthrough**: upstream is Anthropic (or Anthropic-compatible AND declares
  `claudeSupportedToolTypes` incl. `web_search_*`) → forward the tool verbatim.
  9router runs nothing.
- **bridge**: otherwise, 9router strips the server tool, injects a regular
  `web_search` *function* tool so the model can call it, executes the call, and
  synthesizes the `server_tool_use` + `web_search_tool_result` blocks itself.

Fail-safe: no search provider configured / failure → omit the result block and
say so in the assistant text. NEVER fabricate results.

## Settings

`webSearchProvider` (provider id for handleSearchCore), `webSearchEnabled`.
Auto-detect: if unset, use the request's provider when it supports search, else
the first configured search provider.