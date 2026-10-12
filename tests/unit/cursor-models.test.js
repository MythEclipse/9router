import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cursorModels.js talks to agent.api5.cursor.sh over raw HTTP/2 (6994cd1f) —
// node fetch/undici cannot speak h2 — so the seam to mock is node:http2, not
// global fetch. Mocked at module scope so it applies before the import below.
const h2Requests = [];
// Status/body the mocked session will answer every request with. Set per test
// BEFORE the call: resolveCursorModels awaits before it opens the session, so
// the mock cannot wait for the caller to reply.
let h2Reply = { status: 200, body: new Uint8Array() };

vi.mock("http2", () => ({
  default: {
    connect: () => ({
      close: () => {},
      on: () => {},
      request: (hdrs) => {
        h2Requests.push(hdrs);
        const handlers = {};
        const req = {
          on(ev, fn) { handlers[ev] = fn; return req; },
          end() {
            // Replay the reply in wire order, on a later microtask so the
            // caller has already attached its handlers.
            queueMicrotask(() => {
              handlers.response?.({ ":status": h2Reply.status });
              handlers.data?.(Buffer.from(h2Reply.body));
              handlers.end?.();
            });
            return req;
          },
          write() { return req; },
          setEncoding() { return req; },
        };
        return req;
      },
    }),
  },
}));

import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

/** Set what the next mocked h2 session answers with. */
function replyWith(status, body) {
  h2Reply = { status, body };
}

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
  });

  afterEach(() => {
    h2Requests.length = 0;
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    replyWith(200, concat(model("claude-4.6-opus", "Claude 4.6 Opus")));
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    // Second call must be served from cache: no new request, no new network I/O.
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(h2Requests).toHaveLength(1);
    expect(h2Requests[0]).toEqual(expect.objectContaining({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/GetUsableModels",
      ":authority": "agent.api5.cursor.sh",
      ":scheme": "https",
      "content-type": "application/proto",
      accept: "application/proto",
    }));
  });

  it("fails open when the Cursor catalog request fails", async () => {
    replyWith(403, "no");

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});
