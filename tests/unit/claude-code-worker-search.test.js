// Contract test for Claude Code's CCR worker web-search route.
//
// Claude Code's own WebSearch client tool posts to
//   POST {base}/v1/code/sessions/{ccrSessionId}/worker/web-search
// and expects { results: [{ title, url, snippet? }] }.
//
// It does NOT use the Anthropic server_tool_use/web_search_tool_result pair —
// that is a different protocol (the Anthropic server-tool lane). With the route
// absent or malformed, Claude Code silently falls back to its local stub, which
// is the "Did 0 searches" / empty-placeholder behaviour.

import { describe, it, expect, vi, beforeEach } from "vitest";

const handleSearch = vi.fn();
const listProvidersWithCredentials = vi.fn();
const getSettings = vi.fn();

vi.mock("@/sse/handlers/search.js", () => ({ handleSearch: (...a) => handleSearch(...a) }));
vi.mock("@/sse/handlers/chat.js", () => ({
  listProvidersWithCredentials: (...a) => listProvidersWithCredentials(...a),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: (...a) => getSettings(...a) }));
vi.mock("open-sse/handlers/webSearchCredentials.js", () => ({
  // Mirrors the real resolveSearchProvider preference order: a connected
  // dedicated engine wins over the chat provider, which is what keeps
  // antigravity (Vertex redirect URLs) out of the results.
  resolveSearchProvider: ({ providerId, candidates = [] }) => {
    if (providerId) return { providerId, source: "settings" };
    const usable = candidates.filter((id) => ["tinyfish", "exa"].includes(id));
    return { providerId: usable[0] || null, source: usable.length ? "auto" : "none" };
  },
}));

const { POST } = await import(
  "../../src/app/api/v1/code/sessions/[id]/worker/[worker]/route.js"
);

const params = Promise.resolve({ id: "sess_abc", worker: "web-search" });

const searchResult = (over = {}) => ({
  title: "Claude Code CHANGELOG",
  url: "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
  snippet: "Release notes and version history.",
  ...over,
});

const searchOk = (results) =>
  new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const request = (body) =>
  new Request("http://local/v1/code/sessions/sess_abc/worker/web-search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({ webSearchProvider: "" });
  listProvidersWithCredentials.mockResolvedValue(["tinyfish", "antigravity"]);
  handleSearch.mockResolvedValue(searchOk([searchResult()]));
});

describe("Claude Code CCR worker web-search route", () => {
  it("returns Claude Code's {results:[{title,url,snippet}]} shape", async () => {
    const res = await POST(request({ query: "claude code changelog" }), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      results: [
        {
          title: "Claude Code CHANGELOG",
          url: "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
          snippet: "Release notes and version history.",
        },
      ],
    });
  });

  it("never answers with Anthropic web_search_tool_result blocks", async () => {
    // The pair belongs to a different protocol; emitting it here is what made
    // earlier attempts look right on the wire while the client ignored them.
    const res = await POST(request({ query: "q" }), { params });
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("web_search_tool_result");
    expect(raw).not.toContain("server_tool_use");
  });

  it("keeps the snippet, which the client needs for citations", async () => {
    // With CLAUDE_CODE_WEBSEARCH_CITATIONS set, Claude Code builds the model's
    // tool_result from content[].snippet and drops hits that have none — so a
    // result without a snippet is a result the model never sees cited.
    const res = await POST(
      request({ query: "q" }),
      { params },
    );
    const body = await res.json();
    expect(body.results[0].snippet).toBeTruthy();
  });

  it("omits snippet rather than sending an empty string", async () => {
    handleSearch.mockResolvedValue(searchOk([searchResult({ snippet: "" })]));
    const res = await POST(request({ query: "q" }), { params });
    const body = await res.json();
    expect("snippet" in body.results[0]).toBe(false);
  });

  it("drops results without a url", async () => {
    handleSearch.mockResolvedValue(searchOk([
      searchResult(),
      searchResult({ url: "", title: "no url" }),
    ]));
    const res = await POST(request({ query: "q" }), { params });
    expect((await res.json()).results).toHaveLength(1);
  });

  it("picks a connected search engine, never the chat provider", async () => {
    // antigravity is connected but cannot search; using it is what produced
    // "No credentials for provider" and an empty result set.
    await POST(request({ query: "q" }), { params });
    expect(handleSearch).toHaveBeenCalled();
    const sent = JSON.parse(await handleSearch.mock.calls[0][0].text());
    expect(sent.model).toBe("tinyfish");
  });

  it("honours an operator-pinned provider", async () => {
    getSettings.mockResolvedValue({ webSearchProvider: "search-combo-1" });
    await POST(request({ query: "q" }), { params });
    const sent = JSON.parse(await handleSearch.mock.calls[0][0].text());
    expect(sent.model).toBe("search-combo-1");
  });

  it("forwards domain filters using /v1/search's own field names", async () => {
    await POST(
      request({ query: "q", allowed_domains: ["docs.example.com"], blocked_domains: ["spam.test"] }),
      { params },
    );
    const sent = JSON.parse(await handleSearch.mock.calls[0][0].text());
    expect(sent.allowed_domains).toEqual(["docs.example.com"]);
    expect(sent.blocked_domains).toEqual(["spam.test"]);
  });

  it("passes the caller's key through so per-key access still applies", async () => {
    await POST(request({ query: "q" }), { params });
    expect(handleSearch.mock.calls[0][0].headers.get("authorization")).toBe("Bearer sk-test");
  });

  it("returns 503 when nothing connected can search", async () => {
    listProvidersWithCredentials.mockResolvedValue(["antigravity"]);
    const res = await POST(request({ query: "q" }), { params });
    expect(res.status).toBe(503);
    expect((await res.json()).error.error_type).toBe("no_search_provider");
    expect(handleSearch).not.toHaveBeenCalled();
  });

  it("surfaces a search failure as an api_error", async () => {
    handleSearch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "engine down" } }), { status: 500 }),
    );
    const res = await POST(request({ query: "q" }), { params });
    expect(res.status).toBe(502);
    expect((await res.json()).error.error_message).toBe("engine down");
  });

  it("rejects a missing query", async () => {
    const res = await POST(request({ query: "  " }), { params });
    expect(res.status).toBe(400);
    expect(handleSearch).not.toHaveBeenCalled();
  });

  it("does not fall back to the chat provider when it cannot search", async () => {
    // antigravity is connected and `supportsSearch` is true for it, but it
    // returns Vertex grounding redirect URLs that resolve nowhere useful. A
    // connected dedicated engine must still win.
    listProvidersWithCredentials.mockResolvedValue(["antigravity", "tinyfish", "exa"]);
    await POST(request({ query: "q" }), { params });
    const sent = JSON.parse(await handleSearch.mock.calls[0][0].text());
    expect(sent.model).toBe("tinyfish");
  });

  it("uses the client's error envelope, not the API-wide one", async () => {
    // The client reads data.error.error_type / data.error.error_message. With the
    // {error:{type,message}} shape both are undefined and the user sees an
    // empty failure message instead of the real one.
    handleSearch.mockRejectedValue(new Error("socket hang up"));
    const body = (await (await POST(request({ query: "q" }), { params })).json());
    expect(Object.keys(body.error).sort()).toEqual(["error_message", "error_type"]);
    expect(body.error.error_message).toBe("socket hang up");
  });

  it("answers a genuinely empty search with results: [], not an error", async () => {
    // A search that found nothing is a success with zero hits; the client drops
    // url-less entries itself, so an envelope here would be a false failure.
    handleSearch.mockResolvedValue(searchOk([]));
    const res = await POST(request({ query: "q" }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
  });

  it("derives the result cap from search_profile, not max_uses", async () => {
    // The worker route sends a profile name; max_uses belongs to the client's
    // internal search_subrequest path and never arrives here.
    await POST(request({ query: "q", search_profile: "standard" }), { params });
    expect(JSON.parse(await handleSearch.mock.calls[0][0].text()).max_results).toBe(5);
    vi.clearAllMocks();
    handleSearch.mockResolvedValue(searchOk([searchResult()]));
    await POST(request({ query: "q", search_profile: "extended" }), { params });
    expect(JSON.parse(await handleSearch.mock.calls[0][0].text()).max_results).toBe(10);
  });

  it("404s an unknown worker route", async () => {
    const res = await POST(request({ query: "q" }), {
      params: Promise.resolve({ id: "s", worker: "not-a-worker" }),
    });
    expect(res.status).toBe(404);
  });
});