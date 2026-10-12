// Exa moved its content options under a `contents` object. The old top-level
// `text` / `highlights` booleans are still accepted by the API but silently
// ignored, so every hit came back with an empty snippet — which is what broke
// Claude Code's citation rendering, since it builds the model's tool_result
// text from `snippet` and drops hits that have none.

import { describe, it, expect } from "vitest";
import { buildSearchRequest } from "open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "open-sse/handlers/search/normalizers.js";

const config = { id: "exa", baseUrl: "https://api.exa.ai/search" };
const params = { query: "claude code subagents", maxResults: 5, searchType: "web" };

describe("exa request builder", () => {
  it("asks for content under `contents`, not top-level booleans", () => {
    const { init } = buildSearchRequest(config, params);
    const body = JSON.parse(init.body);
    expect(body.contents).toEqual({ text: true, highlights: true });
    // The old shape is what Exa now ignores; keep it out of the request.
    expect(body).not.toHaveProperty("text");
    expect(body).not.toHaveProperty("highlights");
  });

  it("keeps the rest of the query contract intact", () => {
    const body = JSON.parse(buildSearchRequest(config, params).init.body);
    expect(body.query).toBe("claude code subagents");
    expect(body.numResults).toBe(5);
    expect(body.type).toBe("auto");
  });

  it("still maps domain filters to include/excludeDomains", () => {
    const body = JSON.parse(
      buildSearchRequest(config, { ...params, domainFilter: ["docs.example.com", "-spam.test"] }).init.body,
    );
    expect(body.includeDomains).toEqual(["docs.example.com"]);
    expect(body.excludeDomains).toEqual(["spam.test"]);
  });
});

describe("exa response normalizer", () => {
  const result = (extra) => ({ title: "Subagents", url: "https://docs.example.com/a", ...extra });

  it("reads content nested under `contents`", () => {
    const { results } = normalizeSearchResponse("exa", {
      results: [result({ contents: { highlights: ["nested highlight"], text: "nested text" } })],
    }, params.query, "web");
    expect(results[0].snippet).toBe("nested highlight");
  });

  it("still reads the flat legacy shape", () => {
    const { results } = normalizeSearchResponse("exa", {
      results: [result({ highlights: ["flat highlight"] })],
    }, params.query, "web");
    expect(results[0].snippet).toBe("flat highlight");
  });

  it("prefers highlights, then summary, then a text prefix", () => {
    const of = (contents) =>
      normalizeSearchResponse("exa", { results: [result(contents)] }, "q", "web").results[0].snippet;

    expect(of({ contents: { highlights: ["h"], summary: "s", text: "t" } })).toBe("h");
    expect(of({ contents: { summary: "s", text: "t" } })).toBe("s");
    expect(of({ contents: { text: "abcdefghij" } })).toBe("abcdefghij");
  });

  it("never drops a result for lacking a snippet", () => {
    const { results } = normalizeSearchResponse("exa", {
      results: [result({}), result({ contents: {} })],
    }, "q", "web");
    expect(results).toHaveLength(2);
    expect(results[0].snippet).toBe("");
  });
});