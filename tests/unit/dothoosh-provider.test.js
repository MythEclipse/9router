import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { getModelSupportedFormats, getModelTargetFormat } from "../../open-sse/config/providerModels.js";

describe("DotHoosh provider", () => {
  const entry = REGISTRY.find((e) => e.id === "dothoosh");

  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.authType).toBe("apikey");
    expect(entry.alias).toBe("dothoosh");
    expect(entry.aliases).toContain("dh");
    expect(entry.display.name).toBe("DotHoosh (دات‌هوش)");
  });

  it("points at the verified OpenAI-compatible base URL", () => {
    expect(PROVIDERS.dothoosh.baseUrl).toBe("https://gateway.dothoosh.com/v1/chat/completions");
    expect(PROVIDERS.dothoosh.validateUrl).toBe("https://gateway.dothoosh.com/v1/models");
    // transport.format defaults to "openai" via the shared provider default
    expect(PROVIDERS.dothoosh.format).toBe("openai");
  });

  it("declares no provider-wide thinkingFormat so each model resolves its own", () => {
    // A provider-wide thinkingFormat would override capabilities.js and force
    // one wire format onto every model, which an OpenAI endpoint may reject.
    expect(PROVIDERS.dothoosh.thinkingFormat).toBeUndefined();
  });

  it("accepts passthrough ids and skips the keyless suggestion fetch", () => {
    expect(entry.passthroughModels).toBe(true);
    // DotHoosh /v1/models needs a key, so a keyless modelsFetcher would only 401.
    expect(entry.modelsFetcher).toBeUndefined();
  });

  it("lists every enabled DotHoosh offering", () => {
    const ids = (PROVIDER_MODELS.dothoosh || []).map((m) => m.id);
    expect(ids).toHaveLength(19);
    expect(new Set(ids)).toEqual(new Set([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "gpt-6-luna",
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
      "gemini-4-argon",
      "deepseek-flash",
      "deepseek-v4-pro",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "kimi-k3",
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.3-flashx",
      "glm-5.2",
    ]));
  });

  it("exposes a small seed of bare (unprefixed) model ids", () => {
    const ids = (PROVIDER_MODELS.dothoosh || []).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("claude-sonnet-5-5");
    // DotHoosh does not prefix ids by upstream vendor
    expect(ids.every((id) => !id.includes("/"))).toBe(true);
  });

  it("routes through the shared DefaultExecutor (no custom adapter)", () => {
    expect(getExecutor("dothoosh")).toBeInstanceOf(DefaultExecutor);
  });

  it("resolves per-model capabilities from the shared tables", () => {
    // Bare ids must still reach the canonical family patterns.
    expect(getCapabilitiesForModel("dothoosh", "claude-opus-5-5")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-adaptive",
    });
    expect(getCapabilitiesForModel("dothoosh", "gpt-6.1-sol")).toMatchObject({
      reasoning: true,
      thinkingFormat: "openai",
    });
  });

  it("does not invent capabilities for an uncatalogued model", () => {
    // Vision/reasoning must not be blanket-granted across the provider.
    const caps = getCapabilitiesForModel("dothoosh", "some-unknown-model-x");
    expect(caps.vision).toBe(false);
    expect(caps.reasoning).toBe(false);
    expect(caps.thinkingFormat).toBeNull();
  });

  it("keeps every registry id unique after adding dothoosh", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves the Anthropic-compatible claude transport with x-api-key auth", () => {
    const transport = resolveTransport("dothoosh", "claude");
    expect(transport).toMatchObject({
      format: "claude",
      baseUrl: "https://gateway.dothoosh.com/anthropic/v1/messages",
      auth: { header: "x-api-key", scheme: "raw", anthropicVersion: true },
    });
  });

  it("resolves the OpenAI transport with bearer auth", () => {
    const transport = resolveTransport("dothoosh", "openai");
    expect(transport.baseUrl).toBe("https://gateway.dothoosh.com/v1/chat/completions");
    expect(transport.auth).toMatchObject({ header: "Authorization", scheme: "bearer" });
  });

  it("declares the protocol lanes each model family is served on", () => {
    expect(getModelSupportedFormats("dothoosh", "claude-sonnet-5-5")).toEqual(["claude"]);
    expect(getModelSupportedFormats("dothoosh", "deepseek-flash")).toEqual(["openai", "claude"]);
    expect(getModelSupportedFormats("dothoosh", "gpt-6.1-sol")).toEqual(["openai", "openai-responses"]);
    expect(getModelSupportedFormats("dothoosh", "gemini-4-argon")).toEqual(["openai"]);
    expect(getModelSupportedFormats("dothoosh", "kimi-k3")).toEqual(["openai"]);
    expect(getModelSupportedFormats("dothoosh", "glm-5.3")).toEqual(["openai"]);
  });

  it("targets the claude wire format for Claude models only", () => {
    expect(getModelTargetFormat("dothoosh", "claude-opus-5-5")).toBe("claude");
    expect(getModelTargetFormat("dothoosh", "gpt-6.1-sol")).toBeFalsy();
  });

  it("resolves the OpenAI Responses transport with bearer auth", () => {
    const transport = resolveTransport("dothoosh", "openai-responses");
    expect(transport.baseUrl).toBe("https://gateway.dothoosh.com/v1/responses");
    expect(transport.auth).toMatchObject({ header: "Authorization", scheme: "bearer" });
  });

  it("sends only x-api-key and anthropic-version on the claude transport", () => {
    const headers = new DefaultExecutor("dothoosh").buildHeaders(
      { apiKey: "dh_test_x", runtimeTransport: resolveTransport("dothoosh", "claude") },
      true,
      undefined,
      "claude-sonnet-5-5",
      {},
    );
    expect(headers["x-api-key"]).toBe("dh_test_x");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).not.toHaveProperty("authorization");
    expect(headers).not.toHaveProperty("Anthropic-Beta");
    expect(headers).not.toHaveProperty("anthropic-beta");
  });
});
