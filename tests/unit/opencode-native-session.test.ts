import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", () => ({
  spawn: spawnMock,
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

import { executeOpencodeNativeSession } from "../../open-sse/utils/opencodeNativeSession.js";

let homeDir: string;
let realFetch: typeof globalThis.fetch;
let messageBodies: Record<string, unknown>[];
let sessionExists: Set<string>;
let sessionCounter: number;
let configs: Array<{ permission?: Record<string, string>; provider?: Record<string, unknown> }>;
let assistantMessages: Map<string, Record<string, unknown>[]>;

function mockServerProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    setImmediate(() => child.emit("close", 0, "SIGTERM"));
    return true;
  });
  return child;
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "9router-opencode-native-test-"));
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("DATA_DIR", path.join(homeDir, "data"));
  vi.stubEnv("XDG_DATA_HOME", path.join(homeDir, "opencode-data"));
  configs = [];
  spawnMock.mockReset().mockImplementation((_binary, _args, options) => {
    configs.push(JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, "utf8")));
    return mockServerProcess();
  });
  realFetch = globalThis.fetch;
  messageBodies = [];
  sessionExists = new Set();
  sessionCounter = 0;
  assistantMessages = new Map();
  globalThis.fetch = vi.fn(async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/api/info") return jsonResponse({ version: "test" });
    if (url.pathname === "/api/session" && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      const id = `ses_native_${++sessionCounter}`;
      sessionExists.add(id);
      return jsonResponse({ data: { id, title: body.title } });
    }
    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    if (sessionMatch && init.method === "GET") {
      const id = decodeURIComponent(sessionMatch[1]);
      return sessionExists.has(id) ? jsonResponse({ data: { id } }) : jsonResponse({ error: "not found" }, 404);
    }
    if (sessionMatch && init.method === "DELETE") {
      sessionExists.delete(decodeURIComponent(sessionMatch[1]));
      return jsonResponse(true);
    }
    if (url.pathname.endsWith("/model") && init.method === "POST") return jsonResponse(true);
    if (url.pathname.endsWith("/prompt") && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      messageBodies.push(body);
      const sessionID = decodeURIComponent(url.pathname.split("/")[3]);
      const acceptedAt = Date.now();
      assistantMessages.set(sessionID, [{
        type: "assistant",
        time: { created: acceptedAt, completed: acceptedAt + 1 },
        content: [{ type: "text", text: "native response" }],
      }]);
      return jsonResponse({
        data: { id: `msg_${messageBodies.length}`, time: { created: acceptedAt }, type: "user" },
      });
    }
    if (url.pathname.endsWith("/message") && init.method === "GET") {
      const sessionID = decodeURIComponent(url.pathname.split("/")[3]);
      return jsonResponse({ data: assistantMessages.get(sessionID) || [], cursor: { previous: null, next: null } });
    }
    return jsonResponse({ error: `unexpected ${init.method} ${url.pathname}` }, 404);
  });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true });
});

describe("OpenCode native session runner", () => {
  it("sends the current user turn as native parts and reuses native session history", async () => {
    const first = await executeOpencodeNativeSession({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/model-a",
      rawModel: "model-a",
      providerSessionId: "client-session-1",
      connectionId: "connection-1",
      body: {
        system: "Be concise",
        messages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Current question" },
        ],
      },
    });

    expect(first.url).toMatch(/^opencode:\/\/session\/ses_native_/);
    expect(messageBodies[0]).toMatchObject({
      files: [],
      resume: true,
    });
    expect(messageBodies[0].text).toContain("Earlier answer");
    expect(messageBodies[0].text).toContain("Current question");
    expect(spawnMock.mock.calls[0][0]).toBe("/usr/bin/opencode");
    expect(spawnMock.mock.calls[0][1][0]).toBe("serve");
    expect(configs[0].permission["*"]).toBe("deny");
    expect(spawnMock.mock.calls[0][2].env.XDG_DATA_HOME).toBe(process.env.XDG_DATA_HOME);

    await executeOpencodeNativeSession({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/model-a",
      rawModel: "model-a",
      providerSessionId: "client-session-1",
      connectionId: "connection-1",
      body: {
        messages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Next question" },
        ],
      },
    });

    expect(messageBodies[1].text).toBe("Next question");
    expect(messageBodies[1].files).toEqual([]);
    expect(sessionCounter).toBe(1);
  });

  it("keeps multimodal user content in native image and text parts", async () => {
    await executeOpencodeNativeSession({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/model-a",
      rawModel: "model-a",
      providerSessionId: "client-session-image",
      body: {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            { type: "image_url", image_url: { url: "https://images.example/image.png" } },
          ],
        }],
      },
    });

    expect(messageBodies[0]).toEqual({
      text: "Describe this",
      files: [{ uri: "https://images.example/image.png" }],
      resume: true,
    });
  });

  it("preserves the user's OpenCode configuration and credential data directory", async () => {
    const configPath = path.join(homeDir, "opencode-user-config.json");
    writeFileSync(configPath, JSON.stringify({
      provider: { "saved-provider": { options: { apiKey: "stored-credential" } } },
    }));
    vi.stubEnv("OPENCODE_CONFIG_CONTENT", "");
    vi.stubEnv("OPENCODE_CONFIG", configPath);

    await executeOpencodeNativeSession({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/model-a",
      rawModel: "model-a",
      providerSessionId: "client-session-config",
      body: { messages: [{ role: "user", content: "hello" }] },
    });

    expect(configs[0].provider).toMatchObject({
      "saved-provider": { options: { apiKey: "stored-credential" } },
    });
    expect(spawnMock.mock.calls[0][2].env.XDG_DATA_HOME).toBe(path.join(homeDir, "opencode-data"));
    expect(spawnMock.mock.calls[0][2].env.OPENCODE_SERVER_PASSWORD).toBeTruthy();
  });

  it("passes million-token-sized text intact to a native session", async () => {
    const largeText = "token ".repeat(1_000_000);
    await executeOpencodeNativeSession({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/model-a",
      rawModel: "model-a",
      providerSessionId: "client-session-large",
      body: { messages: [{ role: "user", content: largeText }] },
      log: { info: (_provider, message) => {
        if (message.includes("native server start")) expect(message).toContain("timeout=480000ms");
      } },
    });

    expect(messageBodies[0].text).toBe(largeText);
  });

  it("refuses a direct connection when a strict proxy has no usable route", async () => {
    await expect(executeOpencodeNativeSession({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/model-a",
      rawModel: "model-a",
      body: { messages: [{ role: "user", content: "hello" }] },
      proxyOptions: { strictProxy: true, proxyPoolId: "pool-1" },
    })).rejects.toThrow("refusing a direct connection");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not start a server for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(executeOpencodeNativeSession({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/model-a",
      rawModel: "model-a",
      body: { messages: [{ role: "user", content: "hello" }] },
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
