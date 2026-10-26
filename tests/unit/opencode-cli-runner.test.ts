import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, execFileSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: spawnMock,
  execFileSync: execFileSyncMock,
  execSync: vi.fn(),
}));

import {
  createOpencodeRelayBridge,
  executeOpencodeCli,
} from "../../open-sse/utils/opencodeCliRunner.js";

const realFetch = globalThis.fetch;

function mockChildProcess(promptCapture) {
  const child = new EventEmitter();
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (text) => {
    promptCapture.value = text;
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("CLI response"));
      child.emit("close", 0);
    });
  };
  child.kill = vi.fn();
  return child;
}

function mockChildProcessThroughRelay(promptCapture, options) {
  const child = mockChildProcess(promptCapture);
  child.stdin.end = (text) => {
    promptCapture.value = text;
    setImmediate(async () => {
      try {
        const configContent = await readFile(options.env.OPENCODE_CONFIG, "utf8");
        promptCapture.configContent = configContent;
        const config = JSON.parse(configContent);
        const baseURL = config.provider["9router-opencode-relay"].options.baseURL;
        const response = await realFetch(`${baseURL}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"model":"opencode/big-pickle"}',
        });
        await response.text();
        child.stdout.emit("data", Buffer.from("CLI response"));
        child.emit("close", 0);
      } catch (error) {
        child.stderr.emit("data", Buffer.from(error.message));
        child.emit("close", 1);
      }
    });
  };
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue("Options:\n  --standalone  run without a background server\n");
  globalThis.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://relay.example")) {
      return new Response("relayed", { status: 200 });
    }
    return realFetch(input, options);
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = realFetch;
});

describe("OpenCode CLI runner", () => {
  it("pipes large prompts through stdin instead of process arguments", async () => {
    const prompt = "agent context ".repeat(20000);
    const promptCapture = { value: "" };
    spawnMock.mockImplementation(() => mockChildProcess(promptCapture));

    const result = await executeOpencodeCli({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/big-pickle",
      promptText: prompt,
      rawModel: "big-pickle",
    });

    const [, args, options] = spawnMock.mock.calls[0];
    expect(args).toEqual([
      "run",
      "--model",
      "opencode/big-pickle",
      "--format",
      "default",
    ]);
    expect(promptCapture.value).toBe(prompt);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(result.url).toBe("opencode://cli/run");
  });

  it("does not retry non-transient spawn failures such as E2BIG", async () => {
    spawnMock.mockImplementation(() => {
      throw Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" });
    });

    await expect(executeOpencodeCli({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/big-pickle",
      promptText: "large prompt",
      rawModel: "big-pickle",
      log: { warn: vi.fn() },
    })).rejects.toThrow("spawn E2BIG");

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry transient proxy failures", async () => {
    spawnMock.mockImplementation(() => {
      const child = mockChildProcess({ value: "" });
      child.stdin.end = () => {
        setImmediate(() => {
          child.stderr.emit("data", Buffer.from("tunnel failed"));
          child.emit("close", 1);
        });
      };
      return child;
    });

    await expect(executeOpencodeCli({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/big-pickle",
      promptText: "run once",
      rawModel: "big-pickle",
    })).rejects.toThrow("Proxy tunnel error");

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("terminates the CLI process when it does not exit within its deadline", async () => {
    vi.useFakeTimers();
    const child = mockChildProcess({ value: "" });
    child.stdin.end = vi.fn();
    child.kill = vi.fn(() => {
      child.killed = true;
      setImmediate(() => child.emit("close", null));
      return true;
    });
    spawnMock.mockReturnValue(child);

    const result = executeOpencodeCli({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/big-pickle",
      promptText: "wait forever",
      rawModel: "big-pickle",
    });
    const timeoutAssertion = expect(result).rejects.toThrow("timed out after 180000ms");

    try {
      await vi.advanceTimersByTimeAsync(181_000);
      await timeoutAssertion;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pipes a multi-megabyte chat intact and gives its CLI extra processing time", async () => {
    vi.useFakeTimers();
    const prompt = "x".repeat(4 * 1024 * 1024);
    const promptCapture = { value: "" };
    const child = mockChildProcess(promptCapture);
    child.stdin.end = (text) => {
      promptCapture.value = text;
    };
    child.kill = vi.fn(() => {
      setImmediate(() => child.emit("close", null));
      return true;
    });
    spawnMock.mockReturnValue(child);

    const result = executeOpencodeCli({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/big-pickle",
      promptText: prompt,
      rawModel: "big-pickle",
    });
    const timeoutAssertion = expect(result).rejects.toThrow("timed out after 360000ms");

    try {
      expect(promptCapture.value).toBe(prompt);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(241_000);
      await timeoutAssertion;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting after client abort and force-kills a CLI that ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const child = mockChildProcess({ value: "" });
    child.stdin.end = vi.fn();
    child.kill = vi.fn((signal) => {
      if (signal === "SIGKILL") setImmediate(() => child.emit("close", null));
      return true;
    });
    spawnMock.mockReturnValue(child);
    const controller = new AbortController();

    try {
      const result = executeOpencodeCli({
        opencodeBin: "/usr/bin/opencode",
        targetModel: "opencode/big-pickle",
        promptText: "cancel me",
        rawModel: "big-pickle",
        signal: controller.signal,
      });
      const abortAssertion = expect(result).rejects.toMatchObject({ name: "AbortError" });

      controller.abort();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_000);
      await abortAssertion;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards CLI HTTP requests through the shared relay header contract", async () => {
    const logs = [];
    const log = {
      info: (tag, message) => logs.push({ level: "info", tag, message }),
      warn: (tag, message) => logs.push({ level: "warn", tag, message }),
    };
    const relayFetch = vi.fn(async (_url, options) => {
      expect(options.method).toBe("POST");
      expect(options.redirect).toBe("manual");
      expect(options.headers.get("x-relay-target")).toBe("https://opencode.ai");
      expect(options.headers.get("x-relay-path")).toBe("/inference/openai/v1/chat/completions?stream=true");
      expect(options.headers.get("authorization")).toBe("Bearer cli-token");
      expect(options.headers.has("x-forwarded-for")).toBe(false);
      expect(options.headers.has("host")).toBe(false);
      expect(await new Response(options.body).text()).toBe('{"model":"opencode/big-pickle"}');
      return new Response("event: message\ndata: ok\n\n", {
        status: 202,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const bridge = await createOpencodeRelayBridge(
      "https://relay.example/.netlify/functions/relay?key=relay-secret-123",
      relayFetch,
      { log, reqTag: "🟢", providerTag: "OPENCODE" },
    );

    try {
      const response = await fetch(`${bridge.baseURL}/inference/openai/v1/chat/completions?stream=true`, {
        method: "POST",
        headers: {
          Authorization: "Bearer cli-token",
          "x-forwarded-for": "192.0.2.1",
        },
        body: '{"model":"opencode/big-pickle"}',
      });

      expect(response.status).toBe(202);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(await response.text()).toBe("event: message\ndata: ok\n\n");
      expect(relayFetch).toHaveBeenCalledOnce();
      expect(relayFetch.mock.calls[0][0]).toBe("https://relay.example/.netlify/functions/relay?key=relay-secret-123");
      expect(logs.map(({ message }) => message)).toEqual([
        expect.stringContaining("[🟢] relay request start POST /inference/openai/v1/chat/completions via relay.example/.netlify/functions/relay"),
        expect.stringContaining("[🟢] relay response status=202 method=POST path=/inference/openai/v1/chat/completions"),
      ]);
      expect(logs.map(({ message }) => message).join("\n")).not.toContain("relay-secret-123");
      expect(logs).toHaveLength(2);
    } finally {
      await bridge.close();
    }
  });

  it("configures the CLI provider to use the relay bridge without proxy bypass", async () => {
    vi.stubEnv("OPENCODE_CONFIG_CONTENT", JSON.stringify({
      model: "opencode/big-pickle",
      provider: { opencode: { options: { timeout: 30000 } } },
    }));
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");

    let childOptions;
    let cliArgs;
    const promptCapture = { value: "" };
    spawnMock.mockImplementation((_bin, args, options) => {
      cliArgs = args;
      childOptions = options;
      return mockChildProcessThroughRelay(promptCapture, options);
    });

    await executeOpencodeCli({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/big-pickle",
      promptText: "Use the relay",
      rawModel: "big-pickle",
      proxyOptions: { vercelRelayUrl: "https://relay.example", proxyType: "vercel" },
    });

    const relayConfig = JSON.parse(promptCapture.configContent);
    expect(relayConfig.model).toBe("9router-opencode-relay/big-pickle");
    expect(relayConfig.provider["9router-opencode-relay"].npm).toBe("@ai-sdk/openai-compatible");
    expect(relayConfig.provider["9router-opencode-relay"].options.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/inference\/openai\/v1$/);
    expect(relayConfig.provider["9router-opencode-relay"].options.headers["x-opencode-client"]).toBe("cli");
    expect(JSON.parse(childOptions.env.OPENCODE_CONFIG_CONTENT)).toEqual(relayConfig);
    expect(childOptions.env.OPENCODE_CONFIG_PROJECT_DISABLE).toBe("true");
    expect(childOptions.env.HTTPS_PROXY).toBeUndefined();
    expect(childOptions.env.NO_PROXY).toContain("127.0.0.1");
    expect(cliArgs).toContain("--standalone");
    await expect(readFile(childOptions.env.OPENCODE_CONFIG, "utf8")).rejects.toThrow();
  });

  it("omits --standalone for older CLI versions while keeping relay routing", async () => {
    execFileSyncMock.mockReturnValue("opencode run [message..]\nOptions:\n  --model  model to use\n");
    let cliArgs;
    const promptCapture = { value: "" };
    spawnMock.mockImplementation((_bin, args, options) => {
      cliArgs = args;
      return mockChildProcessThroughRelay(promptCapture, options);
    });

    await executeOpencodeCli({
      opencodeBin: "/usr/bin/opencode-1.18",
      targetModel: "opencode/big-pickle",
      promptText: "Use the relay",
      rawModel: "big-pickle",
      proxyOptions: { relayUrl: "https://relay.example", proxyType: "netlify" },
    });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "/usr/bin/opencode-1.18",
      ["run", "--help"],
      expect.objectContaining({ encoding: "utf8", timeout: 2000 }),
    );
    expect(cliArgs).not.toContain("--standalone");
    expect(cliArgs).toEqual([
      "run",
      "--model",
      "9router-opencode-relay/big-pickle",
      "--format",
      "default",
    ]);
    expect(promptCapture.configContent).toContain("/inference/openai/v1");
  });

  it.each(["vercel", "cloudflare", "deno", "netlify"])(
    "uses the shared relay URL for %s pools",
    async (source) => {
      let childOptions;
    let cliArgs;
    const promptCapture = { value: "" };
    const logs = [];
    spawnMock.mockImplementation((_bin, args, options) => {
      cliArgs = args;
      childOptions = options;
      return mockChildProcessThroughRelay(promptCapture, options);
      });

      await executeOpencodeCli({
        opencodeBin: "/usr/bin/opencode",
        targetModel: "opencode/big-pickle",
        promptText: "Use the relay",
        rawModel: "big-pickle",
        log: {
          info: (tag, message) => logs.push({ level: "info", tag, message }),
          warn: (tag, message) => logs.push({ level: "warn", tag, message }),
        },
        reqTag: "🟣",
        proxyOptions: { proxyType: source, relayUrl: "https://relay.example" },
      });

      const relayConfig = JSON.parse(promptCapture.configContent);
      expect(relayConfig.provider["9router-opencode-relay"].options.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/inference\/openai\/v1$/);
      expect(logs[0].message).toContain(`[🟣] CLI start model=big-pickle route=relay type=${source}`);
      expect(logs.some(({ message }) => message.includes("CLI completed code=0"))).toBe(true);
      expect(cliArgs).toContain("--standalone");
    },
  );

  it("refuses to run directly when a strict pool has no usable proxy", async () => {
    await expect(executeOpencodeCli({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/big-pickle",
      promptText: "Use the relay",
      rawModel: "big-pickle",
      proxyOptions: { proxyPoolId: "pool-1", strictProxy: true },
    })).rejects.toThrow("refusing a direct connection");

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects CLI success when a configured relay receives no request", async () => {
    spawnMock.mockImplementation(() => mockChildProcess({ value: "" }));

    await expect(executeOpencodeCli({
      opencodeBin: "/usr/bin/opencode",
      targetModel: "opencode/big-pickle",
      promptText: "Use the relay",
      rawModel: "big-pickle",
      proxyOptions: {
        proxyPoolId: "pool-1",
        relayUrl: "https://relay.example",
        strictProxy: true,
      },
    })).rejects.toThrow("without using the configured relay");
  });

  it("rejects insecure relay URLs rather than sending CLI traffic without relay", async () => {
    await expect(createOpencodeRelayBridge("http://relay.example"))
      .rejects.toThrow("must be HTTPS");
  });

  it("fails closed when a relay redirects instead of following it directly", async () => {
    const relayFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://opencode.ai/inference/v1/chat/completions" },
    }));
    const bridge = await createOpencodeRelayBridge("https://relay.example", relayFetch);

    try {
      const response = await fetch(`${bridge.baseURL}/inference/v1/chat/completions`);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "OpenCode relay redirected; refusing any direct upstream fallback",
      });
      expect(relayFetch).toHaveBeenCalledOnce();
    } finally {
      await bridge.close();
    }
  });

  it("returns relay transport failures as errors without retrying upstream directly", async () => {
    const relayFetch = vi.fn(async () => {
      throw new Error("relay unavailable");
    });
    const bridge = await createOpencodeRelayBridge("https://relay.example", relayFetch);

    try {
      const response = await fetch(`${bridge.baseURL}/inference/v1/chat/completions`);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "OpenCode relay request failed: relay unavailable",
      });
      expect(relayFetch).toHaveBeenCalledOnce();
    } finally {
      await bridge.close();
    }
  });
});
