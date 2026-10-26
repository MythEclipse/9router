import { describe, expect, it } from "vitest";
import {
  API_KEY_ENDPOINT_KINDS,
  classifyApiKeyEndpoint,
  clampAllowedEndpoints,
  isApiKeyEndpointAllowed,
  normalizeAllowedEndpoints,
} from "../../src/shared/constants/keyEndpoints";

describe("API key endpoint scopes", () => {
  it.each([
    ["/v1/chat/completions", "chat"],
    ["/v1/v1/chat/completions", "chat"],
    ["/api/v1/messages", "chat"],
    ["/codex", "responses"],
    ["/responses", "responses"],
    ["/v1/responses", "responses"],
    ["/v1beta/models", "models"],
    ["/v1/embeddings", "embeddings"],
    ["/v1/images/generations", "images"],
    ["/v1/audio/transcriptions", "audio"],
    ["/v1/search", "search"],
    ["/v1/videos", "videos"],
    ["/api/v1/systemone/run", "systemone"],
    ["/systemone", "systemone"],
    ["/api/unrecognized", "other"],
  ] as const)("classifies %s as %s", (path, kind) => {
    expect(classifyApiKeyEndpoint(path)).toBe(kind);
  });

  it("normalizes persisted allowlists and removes invalid or duplicate categories", () => {
    expect(normalizeAllowedEndpoints('["chat","models","chat","invalid"]')).toEqual(["chat", "models"]);
    expect(normalizeAllowedEndpoints("not-json")).toEqual([]);
    expect(normalizeAllowedEndpoints(null)).toEqual([]);
    expect(API_KEY_ENDPOINT_KINDS).toContain("other");
  });

  it("treats an empty allowlist as unrestricted and enforces non-empty allowlists", () => {
    expect(isApiKeyEndpointAllowed([], "chat")).toBe(true);
    expect(isApiKeyEndpointAllowed(undefined, "chat")).toBe(true);
    expect(isApiKeyEndpointAllowed(["chat"], "chat")).toBe(true);
    expect(isApiKeyEndpointAllowed(["chat"], "models")).toBe(false);
  });

  it("never turns a restricted parent key into an unrestricted child after an empty intersection", () => {
    expect(clampAllowedEndpoints(["models"], ["chat"])).toEqual(["chat"]);
    expect(clampAllowedEndpoints([], ["chat", "models"])).toEqual(["chat", "models"]);
    expect(clampAllowedEndpoints(["models"], [])).toEqual(["models"]);
  });
});
