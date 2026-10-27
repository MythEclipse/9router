import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A relay pool records its URL under one of two keys: the Vercel deploy path
// parks it in `vercelRelayUrl`, while Cloudflare/Deno/Netlify pools and the
// generic connection resolver fill `relayUrl`. proxyAwareFetch used to read
// only the former, so any non-Vercel relay was dropped without a word — the
// request dialled upstream directly and the upstream gate answered as if no
// relay had ever been configured.
//
// proxyFetch captures `globalThis.fetch` at import time, so the stub has to be
// installed before the module is (re)loaded.

type RelayCall = [url: string, init?: RequestInit];

const realFetch = globalThis.fetch;
const relayFetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("relayed", { status: 200 }));

beforeEach(() => {
  relayFetch.mockClear();
  globalThis.fetch = relayFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function loadProxyFetch() {
  vi.resetModules();
  return import("../../open-sse/utils/proxyFetch.js");
}

const UPSTREAM = "https://opencode.ai/inference/openai/v1/chat/completions";
const RELAY = "https://relay.example.workers.dev/";

function relayCall(index = 0): RelayCall {
  return relayFetch.mock.calls[index] as unknown as RelayCall;
}

function relayHeaders(index = 0): Record<string, string> {
  return (relayCall(index)[1]?.headers || {}) as Record<string, string>;
}

describe("proxyAwareFetch relay selection", () => {
  it("routes through a pool that only sets relayUrl", async () => {
    const { proxyAwareFetch } = await loadProxyFetch();

    const res = await proxyAwareFetch(UPSTREAM, { method: "POST" }, { relayUrl: RELAY });

    expect(res.status).toBe(200);
    expect(relayFetch).toHaveBeenCalledTimes(1);
    expect(relayCall()[0]).toBe(RELAY);
  });

  it("still routes through a pool that only sets vercelRelayUrl", async () => {
    const { proxyAwareFetch } = await loadProxyFetch();

    await proxyAwareFetch(UPSTREAM, { method: "POST" }, { vercelRelayUrl: RELAY });

    expect(relayCall()[0]).toBe(RELAY);
  });

  it("splits the upstream into origin and path headers", async () => {
    const { proxyAwareFetch } = await loadProxyFetch();

    await proxyAwareFetch(UPSTREAM, { method: "POST" }, { relayUrl: RELAY });

    const headers = relayHeaders();
    expect(headers["x-relay-target"]).toBe("https://opencode.ai");
    expect(headers["x-relay-path"]).toBe("/inference/openai/v1/chat/completions");
  });

  // A relay is a route to the relay, not a replacement for egress. Dialling it
  // directly spends the host IP that the pool exists to protect, so a
  // configured proxy must carry the relay hop too.
  //
  // Which mechanism carries it depends on the engine: Bun ignores undici's
  // `dispatcher` and needs its native `proxy` option, Node is the reverse.
  it("carries the relay hop over the configured proxy", async () => {
    const { proxyAwareFetch } = await loadProxyFetch();
    const proxy = { enabled: true, url: "http://10.0.0.9:8080" };

    await proxyAwareFetch(UPSTREAM, { method: "POST" }, { ...proxy, vercelRelayUrl: RELAY } as never);

    const init = relayCall()[1] as { proxy?: string; dispatcher?: unknown };
    expect(relayCall()[0]).toBe(RELAY);
    expect(init.proxy ?? init.dispatcher).toBeTruthy();
  });

  it("omits proxy egress when no proxy is configured", async () => {
    const { proxyAwareFetch } = await loadProxyFetch();

    await proxyAwareFetch(UPSTREAM, { method: "POST" }, { vercelRelayUrl: RELAY } as never);

    const init = relayCall()[1] as { proxy?: string; dispatcher?: unknown };
    expect(init.proxy ?? init.dispatcher).toBeUndefined();
  });
});
