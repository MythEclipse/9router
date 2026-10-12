/**
 * Web search runner — provider selection wired to handleSearchCore, plus the
 * domain-filter enforcement that backs the client's allowed/blocked promise.
 *
 * The search dispatcher itself is mocked: this file's job is the wiring and the
 * policy, and handleSearchCore has its own coverage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are HOISTED above top-level consts, so the factory cannot
// close over searchCoreMock. vi.hoisted() creates the holder in the hoisted
// scope, which is the documented fix.
const { searchCoreMock } = vi.hoisted(() => ({ searchCoreMock: vi.fn() }));

vi.mock("../../open-sse/handlers/search/index.js", () => ({
  handleSearchCore: (...args) => searchCoreMock(...args),
}));

import { createSearchRunner } from "../../open-sse/handlers/webSearchRunner.js";

const result = (over = {}) => ({
  title: "T", url: "https://docs.example.com/a", snippet: "s", published_at: null, ...over,
});

const plan = (over = {}) => ({
  active: true, lane: "bridge", maxUses: 5, defaultMaxResults: 5,
  allowedDomains: [], blockedDomains: [], ...over,
});

/** A resolver that hands back credentials for any provider. */
const credsResolver = () => vi.fn().mockResolvedValue({ accessToken: "runtime" });

let coreResult;
beforeEach(() => {
  searchCoreMock.mockReset();
  coreResult = { success: true, data: { results: [result()] } };
  searchCoreMock.mockImplementation(async () => coreResult);
});

describe("createSearchRunner", () => {
  it("runs the search and returns unified results", async () => {
    const run = createSearchRunner({
      webSearchPlan: plan(), requestProvider: "serper", getProviderCredentials: credsResolver(),
    });

    await expect(run({ query: "how to test" })).resolves.toHaveLength(1);
  });

  it("passes the query and result budget to the dispatcher", async () => {
    const run = createSearchRunner({
      webSearchPlan: plan({ defaultMaxResults: 7 }),
      requestProvider: "serper",
      getProviderCredentials: credsResolver(),
    });

    await run({ query: "q" });

    const [args] = searchCoreMock.mock.calls;
    expect(args[0].body.query).toBe("q");
    expect(args[0].body.max_results).toBe(7);
  });

  it("resolves credentials through the injected resolver, never inline", async () => {
    const resolver = credsResolver();
    const run = createSearchRunner({
      webSearchPlan: plan(), requestProvider: "serper", getProviderCredentials: resolver,
    });

    await run({ query: "q" });

    expect(resolver).toHaveBeenCalled();
    expect(searchCoreMock.mock.calls[0][0].credentials).toEqual({ accessToken: "runtime" });
  });

  it("throws a clear error when no search provider is available", async () => {
    const run = createSearchRunner({
      webSearchPlan: plan(), requestProvider: "kiro", getProviderCredentials: credsResolver(),
    });

    await expect(run({ query: "q" })).rejects.toThrow(/no search provider/i);
  });

  it("routes through the endpoint path when one is injected", async () => {
    // The endpoint path is the only layer that understands combos, per-key
    // access and combo fallback; the bridge must not duplicate (or bypass) it.
    const runSearchViaEndpoint = vi.fn().mockResolvedValue({ results: [result()] });
    const run = createSearchRunner({
      webSearchPlan: plan({ searchTargetModel: "search-combo-1" }),
      requestProvider: "openai",
      getProviderCredentials: credsResolver(),
      listCandidateProviders: async () => ["tinyfish"],
      runSearchViaEndpoint,
    });

    const out = await run({ query: "latest AI news" });

    expect(runSearchViaEndpoint).toHaveBeenCalledOnce();
    expect(runSearchViaEndpoint.mock.calls[0][0]).toMatchObject({
      model: "search-combo-1", query: "latest AI news",
    });
    expect(out).toHaveLength(1);
    // handleSearchCore must not run when the endpoint path handles it.
    expect(searchCoreMock).not.toHaveBeenCalled();
  });

  it("throws when the endpoint reports an error", async () => {
    const runSearchViaEndpoint = vi.fn().mockRejectedValue(new Error("No credentials for provider: tinyfish"));
    const run = createSearchRunner({
      webSearchPlan: plan({ searchTargetModel: "search-combo-1" }),
      requestProvider: "openai",
      getProviderCredentials: credsResolver(),
      listCandidateProviders: async () => ["tinyfish"],
      runSearchViaEndpoint,
    });

    await expect(run({ query: "q" })).rejects.toThrow(/no credentials/i);
  });

  it("still applies domain filters on the endpoint path", async () => {
    const runSearchViaEndpoint = vi.fn().mockResolvedValue({
      results: [
        { title: "A", url: "https://docs.example.com/a" },
        { title: "B", url: "https://other.test/b" },
      ],
    });
    const run = createSearchRunner({
      webSearchPlan: plan({ searchTargetModel: "search-combo-1", allowedDomains: ["docs.example.com"] }),
      requestProvider: "openai",
      getProviderCredentials: credsResolver(),
      listCandidateProviders: async () => ["tinyfish"],
      runSearchViaEndpoint,
    });

    const out = await run({ query: "q" });
    expect(out.map((r) => r.url)).toEqual(["https://docs.example.com/a"]);
  });

  it("forwards the caller's key to the endpoint runner", async () => {
    // Regression: runSearchViaSearchEndpoint is module-level and referenced a
    // free `apiKey` variable, so every bridged search threw "apiKey is not
    // defined" and returned error_code=unavailable with zero results.
    const runSearchViaEndpoint = vi.fn().mockResolvedValue({ results: [result()] });
    const run = createSearchRunner({
      webSearchPlan: plan(),
      requestProvider: "antigravity",
      getProviderCredentials: credsResolver(),
      listCandidateProviders: async () => ["tinyfish"],
      runSearchViaEndpoint,
      requestApiKey: "sk-test-key",
    });

    await run({ query: "q" });

    expect(runSearchViaEndpoint.mock.calls[0][1]).toEqual({ apiKey: "sk-test-key" });
  });

  it("passes an explicit null key rather than a free variable", async () => {
    // No key in scope must mean "no Authorization header", never a ReferenceError.
    const runSearchViaEndpoint = vi.fn().mockResolvedValue({ results: [result()] });
    const run = createSearchRunner({
      webSearchPlan: plan(),
      requestProvider: "antigravity",
      getProviderCredentials: credsResolver(),
      listCandidateProviders: async () => ["tinyfish"],
      runSearchViaEndpoint,
    });

    await run({ query: "q" });
    expect(runSearchViaEndpoint.mock.calls[0][1]).toEqual({ apiKey: null });
  });

  it("never targets the chat provider on the endpoint path", async () => {
    // Production regression: with no webSearchProvider configured the endpoint
    // call used the chat provider (antigravity for claude-opus-5-5), which has
    // no search access — so every Claude Code search came back empty.
    const runSearchViaEndpoint = vi.fn().mockResolvedValue({ results: [result()] });
    const run = createSearchRunner({
      webSearchPlan: plan(),                       // no searchTargetModel
      requestProvider: "antigravity",
      getProviderCredentials: credsResolver(),
      listCandidateProviders: async () => ["tinyfish"],
      runSearchViaEndpoint,
    });

    await run({ query: "q" });

    expect(runSearchViaEndpoint.mock.calls[0][0].model).toBe("tinyfish");
  });

  it("refuses to call the endpoint when nothing connected can search", async () => {
    const runSearchViaEndpoint = vi.fn();
    const run = createSearchRunner({
      webSearchPlan: plan(),
      requestProvider: "antigravity",
      getProviderCredentials: vi.fn().mockResolvedValue(null),
      listCandidateProviders: async () => [],
      runSearchViaEndpoint,
    });

    await expect(run({ query: "q" })).rejects.toThrow(/no credentials|no search provider/i);
    expect(runSearchViaEndpoint).not.toHaveBeenCalled();
  });

  it("still calls the endpoint for a pinned combo with no resolvable provider id", async () => {
    // "search-combo-1" is not in AI_PROVIDERS; that must not block the combo.
    const runSearchViaEndpoint = vi.fn().mockResolvedValue({ results: [result()] });
    const run = createSearchRunner({
      webSearchPlan: plan({ searchTargetModel: "search-combo-1" }),
      requestProvider: "antigravity",
      getProviderCredentials: vi.fn().mockResolvedValue(null),
      listCandidateProviders: async () => [],
      runSearchViaEndpoint,
    });

    await run({ query: "q" });
    expect(runSearchViaEndpoint.mock.calls[0][0].model).toBe("search-combo-1");
  });

  it("uses a connected candidate rather than the chat provider", async () => {
    // Production shape: chat came in on `openai`, which advertises
    // searchViaChat but has no connected account and no search-enabled model.
    const run = createSearchRunner({
      webSearchPlan: plan(),
      requestProvider: "openai",
      getProviderCredentials: credsResolver(),
      listCandidateProviders: async () => ["tinyfish"],
    });

    await run({ query: "q" });
    expect(searchCoreMock.mock.calls[0][0].provider.id).toBe("tinyfish");
  });

  it("surfaces a clear error when nothing is connected to search", async () => {
    // Better an explicit error block the client can report than a silent empty
    // result set, which is what made this look like a flaky backend.
    const run = createSearchRunner({
      webSearchPlan: plan(),
      requestProvider: "openai",
      getProviderCredentials: vi.fn().mockResolvedValue(null),
      listCandidateProviders: async () => [],
    });

    await expect(run({ query: "q" })).rejects.toThrow(/no credentials/i);
  });

  it("throws when the provider has no usable credentials", async () => {
    const run = createSearchRunner({
      webSearchPlan: plan(),
      requestProvider: "serper",
      getProviderCredentials: vi.fn().mockResolvedValue(null),
    });

    await expect(run({ query: "q" })).rejects.toThrow(/no credentials/i);
  });

  it("surfaces a dispatcher failure as a throw, so the caller emits an error block", async () => {
    coreResult = { success: false, error: "serper 500" };
    const run = createSearchRunner({
      webSearchPlan: plan(), requestProvider: "serper", getProviderCredentials: credsResolver(),
    });

    await expect(run({ query: "q" })).rejects.toThrow(/serper 500/);
  });

  it("treats an empty-but-successful search as empty, not as an error", async () => {
    coreResult = { success: true, data: { results: [] } };
    const run = createSearchRunner({
      webSearchPlan: plan(), requestProvider: "serper", getProviderCredentials: credsResolver(),
    });

    await expect(run({ query: "q" })).resolves.toEqual([]);
  });

  it("picks one provider and reuses it for the whole request", async () => {
    const resolver = credsResolver();
    const run = createSearchRunner({
      webSearchPlan: plan(), requestProvider: "kiro", getProviderCredentials: resolver,
      listCandidateProviders: async () => ["serper", "tavily"],
    });

    await run({ query: "first" });
    const afterFirst = resolver.mock.calls.length;
    await run({ query: "second" });

    // No re-selection between calls in the same request.
    expect(resolver.mock.calls.length).toBe(afterFirst);
  });

  it("accepts a bare array result payload", async () => {
    coreResult = { success: true, data: [result()] };
    const run = createSearchRunner({
      webSearchPlan: plan(), requestProvider: "serper", getProviderCredentials: credsResolver(),
    });
    await expect(run({ query: "q" })).resolves.toHaveLength(1);
  });

  it("returns an empty list for an unparseable payload rather than throwing", async () => {
    coreResult = { success: true, data: { unexpected: true } };
    const run = createSearchRunner({
      webSearchPlan: plan(), requestProvider: "serper", getProviderCredentials: credsResolver(),
    });
    await expect(run({ query: "q" })).resolves.toEqual([]);
  });
});

describe("domain filters", () => {
  const withResults = (urls) => {
    coreResult = { success: true, data: { results: urls.map((url) => result({ url })) } };
  };

  it("keeps only allowed domains", async () => {
    withResults([
      "https://docs.example.com/a",
      "https://other.test/b",
      "https://sub.docs.example.com/c",
    ]);
    const run = createSearchRunner({
      webSearchPlan: plan({ allowedDomains: ["docs.example.com"] }),
      requestProvider: "serper",
      getProviderCredentials: credsResolver(),
    });

    const out = await run({ query: "q" });
    expect(out.map((r) => r.url)).toEqual([
      "https://docs.example.com/a",
      "https://sub.docs.example.com/c",
    ]);
  });

  it("drops blocked domains", async () => {
    withResults(["https://good.test/a", "https://evil.test/b"]);
    const run = createSearchRunner({
      webSearchPlan: plan({ blockedDomains: ["evil.test"] }),
      requestProvider: "serper",
      getProviderCredentials: credsResolver(),
    });

    const out = await run({ query: "q" });
    expect(out.map((r) => r.url)).toEqual(["https://good.test/a"]);
  });

  it("applies block before allow — a domain on both lists is dropped", async () => {
    withResults(["https://both.test/a"]);
    const run = createSearchRunner({
      webSearchPlan: plan({ allowedDomains: ["both.test"], blockedDomains: ["both.test"] }),
      requestProvider: "serper",
      getProviderCredentials: credsResolver(),
    });

    await expect(run({ query: "q" })).resolves.toEqual([]);
  });

  it("matches subdomains of an allowed domain", async () => {
    withResults(["https://deep.nested.example.org/x"]);
    const run = createSearchRunner({
      webSearchPlan: plan({ allowedDomains: ["example.org"] }),
      requestProvider: "serper",
      getProviderCredentials: credsResolver(),
    });
    await expect(run({ query: "q" })).resolves.toHaveLength(1);
  });

  it("maps the tool's allowed_domains onto the endpoint's domain_filter", async () => {
    // The Anthropic tool spells it allowed_domains; /v1/search spells it
    // domain_filter. A bridge that passed the tool's name through verbatim
    // would silently drop the filter.
    withResults(["https://docs.example.com/a"]);
    const run = createSearchRunner({
      webSearchPlan: plan({ allowedDomains: ["docs.example.com"] }),
      requestProvider: "serper",
      getProviderCredentials: credsResolver(),
    });

    await run({ query: "q" });
    const body = searchCoreMock.mock.calls[0][0].body;
    expect(body.domain_filter).toEqual(["docs.example.com"]);
    expect(body.allowed_domains).toBeUndefined();
  });

  it("passes a per-call search_type through to the endpoint body", async () => {
    withResults(["https://a.test/x"]);
    const run = createSearchRunner({
      webSearchPlan: plan(), requestProvider: "serper", getProviderCredentials: credsResolver(),
    });

    await run({ query: "q", searchType: "news" });
    expect(searchCoreMock.mock.calls[0][0].body.search_type).toBe("news");
  });

  it("omits search_type when neither call nor declaration sets one", async () => {
    withResults(["https://a.test/x"]);
    const run = createSearchRunner({
      webSearchPlan: plan(), requestProvider: "serper", getProviderCredentials: credsResolver(),
    });

    await run({ query: "q" });
    // Absent, so handleSearchCore can fall back to the provider's own default
    // search type rather than us pinning one.
    expect(searchCoreMock.mock.calls[0][0].body.search_type).toBeUndefined();
  });

  it("lets a per-call search_type override the declaration default", async () => {
    withResults(["https://a.test/x"]);
    const run = createSearchRunner({
      webSearchPlan: plan({ searchType: "web" }),
      requestProvider: "serper",
      getProviderCredentials: credsResolver(),
    });

    await run({ query: "q", searchType: "news" });
    expect(searchCoreMock.mock.calls[0][0].body.search_type).toBe("news");
  });

  it("forwards the allow-list to the dispatcher so the engine can filter too", async () => {
    withResults(["https://docs.example.com/a"]);
    const run = createSearchRunner({
      webSearchPlan: plan({ allowedDomains: ["docs.example.com"] }),
      requestProvider: "serper",
      getProviderCredentials: credsResolver(),
    });

    await run({ query: "q" });
    expect(searchCoreMock.mock.calls[0][0].body.domain_filter).toEqual(["docs.example.com"]);
  });

  it("passes everything through when no filters are declared", async () => {
    withResults(["https://a.test/x", "https://b.test/y"]);
    const run = createSearchRunner({
      webSearchPlan: plan(), requestProvider: "serper", getProviderCredentials: credsResolver(),
    });
    await expect(run({ query: "q" })).resolves.toHaveLength(2);
    expect(searchCoreMock.mock.calls[0][0].body.domain_filter).toBeUndefined();
  });

  it("drops entries whose url is unparseable", async () => {
    withResults(["not-a-url", "https://ok.test/x"]);
    const run = createSearchRunner({
      webSearchPlan: plan({ allowedDomains: ["ok.test"] }),
      requestProvider: "serper",
      getProviderCredentials: credsResolver(),
    });
    const out = await run({ query: "q" });
    expect(out.map((r) => r.url)).toEqual(["https://ok.test/x"]);
  });
});

describe("endpoint runner adapter (chatCore)", () => {
  // The adapter was `(payload) => searchEndpointRunner(payload)`, which silently
  // dropped the second argument — the caller's key — so every bridged search
  // reached /v1/search with no Authorization header ("Missing API key").
  it("forwards both the payload and the options argument", async () => {
    const inner = vi.fn().mockResolvedValue({ results: [result()] });
    const adapter = (payload, options) => inner(payload, options);

    await adapter({ model: "search-combo-1", query: "q" }, { apiKey: "sk-abc" });

    expect(inner).toHaveBeenCalledWith(
      { model: "search-combo-1", query: "q" },
      { apiKey: "sk-abc" },
    );
  });

  it("does not lose the key when a real runner is composed over it", async () => {
    const inner = vi.fn().mockResolvedValue({ results: [result()] });
    const adapter = (payload, options) => inner(payload, options);

    const run = createSearchRunner({
      webSearchPlan: plan(),
      requestProvider: "antigravity",
      getProviderCredentials: credsResolver(),
      listCandidateProviders: async () => ["tinyfish"],
      runSearchViaEndpoint: adapter,
      requestApiKey: "sk-compose",
    });

    await run({ query: "q" });

    expect(inner.mock.calls[0][1]).toEqual({ apiKey: "sk-compose" });
  });
});
