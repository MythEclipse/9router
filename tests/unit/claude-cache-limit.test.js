// Cache-marker budget: a request may carry at most as many cache_control
// markers as this turn allows, and shrinking the budget must never move a
// breakpoint — only drop tail-most markers.
import { describe, it, expect } from "vitest";
import {
  CACHE_DEFAULT_MARKERS,
  CACHE_MAX_MARKERS,
  newCacheLimit,
  applyClaudeCacheLimits,
  countCacheControlBlocks,
  cacheConfigFrom,
} from "../../open-sse/translator/formats/claudeCache.js";
import { anchorClaudeCache } from "../../open-sse/translator/formats/claude.js";

const CC = { type: "ephemeral" };
const text = (t, extra = {}) => ({ type: "text", text: t, ...extra });
const tool = (name, extra = {}) => ({ name, description: "d", input_schema: {}, ...extra });

/** Body with a marked last system block, a marked tool and `n` marked turns. */
function bodyWithMarkers(n) {
  const messages = [];
  for (let i = 0; i < n; i++) {
    messages.push({ role: "user", content: [text(`u${i}`, { cache_control: CC })] });
    messages.push({ role: "assistant", content: [text(`a${i}`, { cache_control: CC })] });
  }
  messages.push({ role: "user", content: [text("q")] });
  return {
    system: [text("s1"), text("s2", { cache_control: CC })],
    tools: [tool("t1"), tool("t2", { cache_control: CC })],
    messages,
  };
}

describe("newCacheLimit — effective budget from config", () => {
  it("defaults to the proxy budget when no config is supplied", () => {
    expect(newCacheLimit()).toBe(CACHE_DEFAULT_MARKERS);
    expect(newCacheLimit({})).toBe(CACHE_DEFAULT_MARKERS);
  });

  it("honours a larger configured budget", () => {
    expect(newCacheLimit({ maxMarkers: 6 })).toBe(6);
    expect(newCacheLimit({ maxMarkers: 1 })).toBe(1);
    expect(newCacheLimit({ maxMarkers: 0 })).toBe(0);
  });

  it("clamps a config typo back into the supported range", () => {
    expect(newCacheLimit({ maxMarkers: 99 })).toBe(CACHE_MAX_MARKERS);
    expect(newCacheLimit({ maxMarkers: -3 })).toBe(0);
    expect(newCacheLimit({ maxMarkers: "many" })).toBe(CACHE_DEFAULT_MARKERS);
  });

  it("leaves exactly one marker when the model does not cache", () => {
    expect(newCacheLimit({ cacheSupported: false })).toBe(1);
    expect(newCacheLimit({ cacheSupported: false, maxMarkers: 6 })).toBe(1);
  });

  it("leaves none when a non-caching turn starts a fresh context", () => {
    expect(newCacheLimit({ cacheSupported: false, newContextReason: true })).toBe(0);
  });

  it("keeps the budget when caching is on", () => {
    expect(newCacheLimit({ cacheSupported: true, maxMarkers: 6 })).toBe(6);
    expect(newCacheLimit({ cacheSupported: true, newContextReason: true })).toBe(4);
  });
});

describe("applyClaudeCacheLimits — drop without moving the chain", () => {
  it("drops the surplus message markers when the budget shrinks 6 → 4", () => {
    const body = bodyWithMarkers(2); // tools + last system + 4 message markers
    expect(countCacheControlBlocks(body)).toBe(6);

    // budget was 6 (the client marked freely), this turn only allows 4
    const { before, after, dropped } = applyClaudeCacheLimits(body, { maxMarkers: 4 });
    expect(before).toBe(6);
    expect(after).toBe(4);
    expect(dropped).toBe(2);

    // head anchors survive: last system block + last cacheable tool
    expect(body.system[1].cache_control).toEqual(CC);
    expect(body.tools[1].cache_control).toEqual(CC);
    // the two OLDEST message markers went, the tail-most pair stayed
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
    expect(body.messages[1].content[0].cache_control).toBeUndefined();
    expect(body.messages[2].content[0].cache_control).toEqual(CC);
    expect(body.messages[3].content[0].cache_control).toEqual(CC);
    expect(countCacheControlBlocks(body)).toBe(4);
  });

  it("leaves exactly one marker, on the last system block, at limit 1", () => {
    const body = bodyWithMarkers(1);
    expect(countCacheControlBlocks(body)).toBe(4); // system + tool + 2 messages

    applyClaudeCacheLimits(body, { cacheSupported: false });
    expect(countCacheControlBlocks(body)).toBe(1);
    expect(body.system[1].cache_control).toEqual(CC);
    expect(body.tools[1].cache_control).toBeUndefined();
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
    expect(body.messages[2].content[0].cache_control).toBeUndefined();
  });

  it("drops every marker at limit 0", () => {
    const body = bodyWithMarkers(3);
    const markersBefore = countCacheControlBlocks(body);
    const { dropped, after } = applyClaudeCacheLimits(body, {
      cacheSupported: false,
      newContextReason: true,
    });
    expect(after).toBe(0);
    expect(dropped).toBe(markersBefore);
    expect(countCacheControlBlocks(body)).toBe(0);
  });

  it("never adds a marker and never removes a block", () => {
    const body = {
      system: [text("s1")],
      tools: [tool("t1"), tool("t2")],
      messages: [
        { role: "user", content: [text("u1")] },
        { role: "assistant", content: text("a1") }, // single-object content
      ],
    };
    const toolsBefore = body.tools.length;
    const systemBefore = body.system.length;
    const messagesBefore = body.messages.length;

    const { before, dropped } = applyClaudeCacheLimits(body, { maxMarkers: 6 });

    expect(before).toBe(0);
    expect(dropped).toBe(0);
    expect(body.tools).toHaveLength(toolsBefore);
    expect(body.system).toHaveLength(systemBefore);
    expect(body.messages).toHaveLength(messagesBefore);
    expect(countCacheControlBlocks(body)).toBe(0);
  });

  it("counts and drops a marker sitting on single-object content", () => {
    const body = {
      messages: [
        { role: "user", content: text("u1", { cache_control: CC }) },
        { role: "assistant", content: text("a1", { cache_control: CC }) },
        { role: "user", content: [text("q")] },
      ],
    };
    expect(countCacheControlBlocks(body)).toBe(2);

    applyClaudeCacheLimits(body, { cacheSupported: false });
    expect(countCacheControlBlocks(body)).toBe(1);
    // tail-most survives: the largest cached prefix is kept
    expect(body.messages[1].content.cache_control).toEqual(CC);
    expect(body.messages[0].content.cache_control).toBeUndefined();
  });

  it("is a no-op when the body already fits the budget", () => {
    const body = bodyWithMarkers(1);
    const before = JSON.stringify(body);
    applyClaudeCacheLimits(body, { maxMarkers: 4 });
    expect(JSON.stringify(body)).toBe(before);
  });

  it("keeps re-anchored passthrough bodies inside the budget", () => {
    // anchorClaudeCache pins the head; the limit pass must not undo that
    const body = anchorClaudeCache(bodyWithMarkers(2));
    const headSystem = body.system[body.system.length - 1].cache_control;
    applyClaudeCacheLimits(body, { maxMarkers: 4 });
    expect(countCacheControlBlocks(body)).toBeLessThanOrEqual(4);
    expect(body.system[body.system.length - 1].cache_control).toEqual(headSystem);
  });
});

describe("cacheConfigFrom — config keys, both spellings", () => {
  it("reads camelCase settings overrides", () => {
    expect(cacheConfigFrom({ cacheSupported: false, maxMarkers: 1, newContextReason: true }))
      .toEqual({ cacheSupported: false, maxMarkers: 1, newContextReason: true });
  });

  it("reads snake_case config dumps", () => {
    expect(cacheConfigFrom({ cache_supported: false, max_markers: 0 }))
      .toEqual({ cacheSupported: false, maxMarkers: 0 });
  });

  it("omits absent keys so defaults apply", () => {
    expect(cacheConfigFrom({ headers: { "x-a": "b" } })).toEqual({});
    expect(cacheConfigFrom(null)).toEqual({});
    expect(cacheConfigFrom(undefined)).toEqual({});
  });

  it("wires straight into the limit calculation", () => {
    expect(newCacheLimit(cacheConfigFrom({ cache_supported: false }))).toBe(1);
    expect(newCacheLimit(cacheConfigFrom({ max_markers: 6 }))).toBe(6);
    expect(newCacheLimit(cacheConfigFrom({}))).toBe(CACHE_DEFAULT_MARKERS);
  });
});
