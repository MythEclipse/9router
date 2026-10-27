import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The TLS-impersonating transports (opencode, grok) arrive as the `directFetch`
// argument of proxyAwareFetch. They must win over plain fetch on every direct
// egress path — the free tier rejects Node's TLS fingerprint with 403
// FreeTierError, so silently using native fetch is a hard failure, not a slower
// fallback.
//
// proxyFetch captures `globalThis.fetch` at import time, so the stub has to be
// installed before the module is (re)loaded.

const realFetch = globalThis.fetch;
const plainFetch = vi.fn(async () => new Response("plain", { status: 200 }));

beforeEach(() => {
  plainFetch.mockClear();
  globalThis.fetch = plainFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function loadProxyFetch() {
  vi.resetModules();
  return import("../../open-sse/utils/proxyFetch.js");
}

describe("proxyAwareFetch directFetch (TLS transport) routing", () => {
  it("routes the no-proxy path through directFetch instead of native fetch", async () => {
    const { proxyAwareFetch } = await loadProxyFetch();
    const directFetch = vi.fn(async () => new Response("tls", { status: 200 }));

    const response = await proxyAwareFetch(
      "https://opencode.ai/inference/v1/chat/completions",
      { method: "POST", body: "{}" },
      null,
      directFetch
    );

    expect(await response.text()).toBe("tls");
    expect(directFetch).toHaveBeenCalledOnce();
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it("still uses native fetch when no directFetch transport is supplied", async () => {
    const { proxyAwareFetch } = await loadProxyFetch();

    const response = await proxyAwareFetch(
      "https://opencode.ai/inference/v1/chat/completions",
      { method: "POST", body: "{}" },
      null,
      null
    );

    expect(await response.text()).toBe("plain");
    expect(plainFetch).toHaveBeenCalledOnce();
  });

  it("prefers the directFetch argument over a stale options.directFetch", async () => {
    const { proxyAwareFetch } = await loadProxyFetch();
    const argumentFetch = vi.fn(async () => new Response("argument", { status: 200 }));
    const optionFetch = vi.fn(async () => new Response("option", { status: 200 }));

    const options = { method: "POST", body: "{}", directFetch: optionFetch };
    const response = await proxyAwareFetch(
      "https://opencode.ai/inference/v1/chat/completions",
      options as unknown as RequestInit,
      null,
      argumentFetch
    );

    expect(await response.text()).toBe("argument");
    expect(optionFetch).not.toHaveBeenCalled();
  });

  it("keeps the TLS transport on the direct path even when a proxy env var exists", async () => {
    // HTTPS_PROXY must not silently downgrade the free-tier lane to native
    // fetch: the upstream gate keys on the TLS fingerprint, so the direct
    // egress always has to run through the wreq-js transport.
    const { proxyAwareFetch } = await loadProxyFetch();
    const directFetch = vi.fn(async () => new Response("tls", { status: 200 }));

    const previousProxy = process.env.HTTPS_PROXY;
    const previousNoProxy = process.env.NO_PROXY;
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    process.env.NO_PROXY = "opencode.ai";
    try {
      const response = await proxyAwareFetch(
        "https://opencode.ai/inference/v1/chat/completions",
        { method: "POST", body: "{}" },
        null,
        directFetch
      );
      expect(await response.text()).toBe("tls");
      expect(directFetch).toHaveBeenCalledOnce();
    } finally {
      if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previousProxy;
      if (previousNoProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = previousNoProxy;
    }
  });
});
