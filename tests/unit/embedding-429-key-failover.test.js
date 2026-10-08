// End-to-end acceptance for the 429 fallback gap: add two Gemini embedding keys
// through the dashboard flow (no name given), have the first one return 429, and
// require that the request is transparently served by the second key.
//
// Both halves were broken independently:
//   1. an unnamed second key collided on the provider label and was refused (409),
//      so the pool stayed at one key and fallback was impossible;
//   2. a noAuth provider's failure never reached the proxy-rotation branch,
//      because handlers read credentials.connectionId while the synthetic
//      credential only carried id.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-429-e2e-"));
process.env.DATA_DIR = DATA_DIR;

const seen = vi.hoisted(() => ({ keys: [] }));

// The embeddings adapter builds a plain fetch() call with the key in the URL
// query, so the transport stub has to sit on globalThis.fetch. proxyAwareFetch
// is mocked too because proxyFetch.js patches globalThis.fetch as an import
// side-effect, and that patch must not overwrite this stub.
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async () => new Response("{}", { status: 200 }),
  default: async () => new Response("{}", { status: 200 }),
}));

function geminiKeyFromUrl(rawUrl) {
  try {
    return new URL(String(rawUrl)).searchParams.get("key") || "";
  } catch {
    return "";
  }
}

let POST;
let handleEmbeddings;
let getProviderConnections;
let updateSettings;

beforeAll(async () => {
  ({ POST } = await import("@/app/api/providers/route.js"));
  ({ handleEmbeddings } = await import("@/sse/handlers/embeddings.js"));
  ({ getProviderConnections } = await import("@/lib/db/repos/connectionsRepo.js"));
  ({ updateSettings } = await import("@/lib/db/repos/settingsRepo.js"));
  await updateSettings({ requireApiKey: false });
});

afterAll(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

const addKey = (apiKey) => POST(new Request("http://localhost/api/providers", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ provider: "gemini", apiKey }),
}));

describe("gemini embedding key pool", () => {
  beforeEach(() => {
    seen.keys.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const key = geminiKeyFromUrl(url);
      seen.keys.push(key);
      if (key === "limited-key") {
        return new Response(
          JSON.stringify({ error: { message: "Resource has been exhausted (e.g. check quota)." } }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ embedding: { values: [0.5, 0.6, 0.7] } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it("accepts two unnamed keys and fails over when the first is rate-limited", async () => {
    const first = await addKey("limited-key");
    const second = await addKey("healthy-key");

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const pool = await getProviderConnections({ provider: "gemini" });
    expect(pool.map((c) => c.apiKey).sort()).toEqual(["healthy-key", "limited-key"]);

    const res = await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "gemini/gemini-embedding-001", input: "hello" }),
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].embedding).toEqual([0.5, 0.6, 0.7]);

    // The limited key was tried first, then the healthy one answered.
    expect(seen.keys.some((k) => String(k).includes("limited-key"))).toBe(true);
    expect(seen.keys.some((k) => String(k).includes("healthy-key"))).toBe(true);
  });

  it("re-adding an existing key edits it instead of creating a duplicate", async () => {
    const res = await addKey("shared-key");
    expect([201, 409]).toContain(res.status);

    const before = (await getProviderConnections({ provider: "gemini" }))
      .filter((c) => c.apiKey === "shared-key").length;

    await addKey("shared-key");

    const after = (await getProviderConnections({ provider: "gemini" }))
      .filter((c) => c.apiKey === "shared-key").length;
    expect(after).toBe(before);
  });
});