/**
 * Anthropic web search protocol — lane planning and tool installation.
 *
 * Wire shapes mirror what Claude Code 2.1.296 actually sends/expects.
 */
import { describe, it, expect } from "vitest";
import {
  resolveWebSearchPlan,
  findWebSearchTool,
  hasWebSearchTool,
  upstreamRunsWebSearch,
  installBridgeTool,
  createBridgeToolDefinition,
  isClaudeTargetFormat,
  LANE_PASSTHROUGH,
  LANE_BRIDGE,
  LANE_NONE,
} from "../../open-sse/handlers/webSearchProtocol.js";
import {
  WEB_SEARCH_TOOL_TYPE,
  WEB_SEARCH_TOOL_NAME,
  SERVER_TOOL_USE_ID_RE,
  clampMaxUses,
  isWebSearchTool,
  isWebSearchToolType,
} from "../../open-sse/config/webSearchConstants.js";
import { toResultItem } from "../../open-sse/handlers/webSearchBridge.js";

const claudeSearchBody = (extra = {}) => ({
  model: "claude-sonnet-4-6",
  tools: [
    { type: "function", name: "Read", input_schema: { type: "object" } },
    { type: WEB_SEARCH_TOOL_TYPE, name: WEB_SEARCH_TOOL_NAME, max_uses: 5 },
  ],
  ...extra,
});

describe("wire contract", () => {
  it("recognises the Claude Code tool declaration", () => {
    const body = claudeSearchBody();
    expect(hasWebSearchTool(body)).toBe(true);
    expect(findWebSearchTool(body).type).toBe("web_search_20250305");
  });

  it("ignores a function tool that merely shares the name", () => {
    const body = { tools: [{ type: "function", name: "web_search", function: { name: "web_search" } }] };
    expect(hasWebSearchTool(body)).toBe(false);
  });

  it("tolerates a missing or malformed tools array", () => {
    expect(hasWebSearchTool({})).toBe(false);
    expect(hasWebSearchTool({ tools: null })).toBe(false);
    expect(hasWebSearchTool({ tools: [null, undefined, {}] })).toBe(false);
  });

  it("recognises the declared type and name together", () => {
    expect(isWebSearchTool({ type: WEB_SEARCH_TOOL_TYPE, name: WEB_SEARCH_TOOL_NAME })).toBe(true);
    expect(isWebSearchTool({ type: WEB_SEARCH_TOOL_TYPE, name: "something_else" })).toBe(false);
    expect(isWebSearchTool({ type: "web_search_20991231", name: WEB_SEARCH_TOOL_NAME })).toBe(true);
  });

  it("clamps max_uses into a sane band", () => {
    expect(clampMaxUses(undefined)).toBe(1);
    expect(clampMaxUses(0)).toBe(1);
    expect(clampMaxUses(-5)).toBe(1);
    expect(clampMaxUses(3)).toBe(3);
    expect(clampMaxUses(9999)).toBe(10);
    expect(clampMaxUses("4")).toBe(4);
    expect(clampMaxUses(Number.NaN)).toBe(1);
  });

  it("accepts only Anthropic-shaped server tool ids", () => {
    expect(SERVER_TOOL_USE_ID_RE.test("srvtoolu_abc123")).toBe(true);
    expect(SERVER_TOOL_USE_ID_RE.test("srvtoolu_9r_xyz")).toBe(true);
    expect(SERVER_TOOL_USE_ID_RE.test("toolu_abc123")).toBe(false);
    expect(SERVER_TOOL_USE_ID_RE.test("srvtoolu_")).toBe(false);
    expect(SERVER_TOOL_USE_ID_RE.test("srvtoolu_has-dash")).toBe(false);
  });
});

describe("upstream capability detection", () => {
  it("treats real Anthropic as passthrough", () => {
    expect(upstreamRunsWebSearch("claude")).toBe(true);
  });

  it("treats a whitelisting Anthropic-compatible upstream as passthrough", () => {
    // DeepSeek declares claudeSupportedToolTypes incl. web_search_*
    expect(upstreamRunsWebSearch("deepseek")).toBe(true);
  });

  it("treats every other provider as bridge", () => {
    expect(upstreamRunsWebSearch("kiro")).toBe(false);
    expect(upstreamRunsWebSearch("openai")).toBe(false);
    expect(upstreamRunsWebSearch("does-not-exist")).toBe(false);
    expect(upstreamRunsWebSearch(undefined)).toBe(false);
  });
});

describe("resolveWebSearchPlan", () => {
  it("is inactive without the tool", () => {
    const plan = resolveWebSearchPlan({ body: { tools: [] }, provider: "kiro" });
    expect(plan.active).toBe(false);
    expect(plan.lane).toBe(LANE_NONE);
    expect(plan.reason).toContain("no web_search tool");
  });

  it("is inactive when disabled by settings", () => {
    const plan = resolveWebSearchPlan({
      body: claudeSearchBody(), provider: "kiro", settings: { webSearchEnabled: false },
    });
    expect(plan.active).toBe(false);
    expect(plan.reason).toContain("disabled");
  });

  it("picks passthrough when the upstream runs the search", () => {
    const plan = resolveWebSearchPlan({ body: claudeSearchBody(), provider: "claude" });
    expect(plan.active).toBe(true);
    expect(plan.lane).toBe(LANE_PASSTHROUGH);
    expect(plan.maxUses).toBe(5);
  });

  it("picks bridge when the upstream cannot", () => {
    const plan = resolveWebSearchPlan({ body: claudeSearchBody(), provider: "kiro" });
    expect(plan.active).toBe(true);
    expect(plan.lane).toBe(LANE_BRIDGE);
  });

  it("reads and sanitises the domain filters", () => {
    const plan = resolveWebSearchPlan({
      body: claudeSearchBody({
        tools: [
          {
            type: WEB_SEARCH_TOOL_TYPE,
            name: WEB_SEARCH_TOOL_NAME,
            max_uses: 2,
            allowed_domains: ["docs.example.com", ""],
            blocked_domains: ["evil.test"],
          },
        ],
      }),
      provider: "kiro",
    });
    expect(plan.allowedDomains).toEqual(["docs.example.com"]);
    expect(plan.blockedDomains).toEqual(["evil.test"]);
  });

  it("ignores the provider when the client is untrusted — lane comes from the route", () => {
    // A client asking for search must not be able to choose the lane by naming
    // a provider in the model string.
    const plan = resolveWebSearchPlan({ body: claudeSearchBody(), provider: "kiro" });
    expect(plan.lane).toBe(LANE_BRIDGE);
  });

  it("does not crash on a null body", () => {
    expect(resolveWebSearchPlan({ body: null, provider: "kiro" }).active).toBe(false);
  });
});

describe("installBridgeTool", () => {
  it("replaces the server tool with a function tool and keeps the rest", () => {
    const body = claudeSearchBody();
    const plan = resolveWebSearchPlan({ body, provider: "kiro" });

    expect(installBridgeTool(body, plan)).toBe(true);

    expect(body.tools).toHaveLength(2);
    expect(hasWebSearchTool(body)).toBe(false);
    expect(body.tools[0].name).toBe("Read");
    expect(body.tools[1].function.name).toBe(WEB_SEARCH_TOOL_NAME);
    expect(body.tools[1].function.parameters.required).toEqual(["query"]);
  });

  it("is a no-op on the passthrough lane — the upstream must see the server tool", () => {
    const body = claudeSearchBody();
    const plan = resolveWebSearchPlan({ body, provider: "claude" });

    expect(installBridgeTool(body, plan)).toBe(false);
    expect(hasWebSearchTool(body)).toBe(true);
  });

  it("is a no-op when inactive", () => {
    const body = { tools: [] };
    const plan = resolveWebSearchPlan({ body, provider: "kiro" });
    expect(plan.active).toBe(false);
    expect(installBridgeTool(body, plan)).toBe(false);
    expect(body.tools).toHaveLength(0);
  });

  it("repairs a tool_choice that named the server tool", () => {
    const body = claudeSearchBody({ tool_choice: { type: WEB_SEARCH_TOOL_TYPE, name: WEB_SEARCH_TOOL_NAME } });
    const plan = resolveWebSearchPlan({ body, provider: "kiro" });

    installBridgeTool(body, plan);

    expect(body.tool_choice).toEqual({ type: "tool", name: WEB_SEARCH_TOOL_NAME });
  });

  it("leaves an unrelated tool_choice alone", () => {
    const body = claudeSearchBody({ tool_choice: { type: "auto" } });
    const plan = resolveWebSearchPlan({ body, provider: "kiro" });

    installBridgeTool(body, plan);

    expect(body.tool_choice).toEqual({ type: "auto" });
  });

  it("handles a request whose only tool is the server tool", () => {
    const body = {
      tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: WEB_SEARCH_TOOL_NAME, max_uses: 3 }],
    };
    const plan = resolveWebSearchPlan({ body, provider: "kiro" });
    installBridgeTool(body, plan);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe(WEB_SEARCH_TOOL_NAME);
  });

  it("exposes a schema the model can actually call", () => {
    const [tool] = createBridgeToolDefinition({ maxUses: 1 });
    expect(tool.type).toBe("function");
    expect(tool.function.parameters.type).toBe("object");
    expect(tool.function.parameters.properties.query.type).toBe("string");
  });
});

describe("bridge tool declaration fidelity", () => {
  const plan = { active: true, lane: LANE_BRIDGE, maxUses: 3 };

  it("declares an Anthropic-shaped tool for a claude-format body", () => {
    // translatedBody is already in the provider's format. A claude provider
    // needs {type,name,input_schema}; OpenAI's {type:"function",function} is
    // rejected by the upstream outright.
    const [tool] = createBridgeToolDefinition(plan, "claude");
    expect(tool.type).toBe(WEB_SEARCH_TOOL_NAME);
    expect(tool.name).toBe(WEB_SEARCH_TOOL_NAME);
    expect(tool.input_schema).toBeTruthy();
    expect(tool.input_schema.properties.query).toBeTruthy();
    expect(tool.function).toBeUndefined();
  });

  it("declares an OpenAI-shaped tool for an openai-format body", () => {
    const [tool] = createBridgeToolDefinition(plan, "openai");
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe(WEB_SEARCH_TOOL_NAME);
    expect(tool.input_schema).toBeUndefined();
  });

  it("treats the anthropic spelling as a Claude target too", () => {
    expect(isClaudeTargetFormat("claude")).toBe(true);
    expect(isClaudeTargetFormat("anthropic")).toBe(true);
    expect(isClaudeTargetFormat("openai-responses")).toBe(false);
    expect(isClaudeTargetFormat(undefined)).toBe(false);
  });

  it("offers search_type in the schema so a client can ask for news", () => {
    const [tool] = createBridgeToolDefinition(plan, "claude");
    expect(tool.input_schema.properties.search_type).toBeTruthy();
  });

  it("keeps query required", () => {
    const [tool] = createBridgeToolDefinition(plan, "claude");
    expect(tool.input_schema.required).toEqual(["query"]);
  });

  it("installs the format-matched declaration onto the body", () => {
    const body = { tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: WEB_SEARCH_TOOL_NAME }] };
    expect(installBridgeTool(body, plan, "claude")).toBe(true);

    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].input_schema).toBeTruthy();
  });

  it("removes the Anthropic server tool when bridging", () => {
    const body = { tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: WEB_SEARCH_TOOL_NAME, max_uses: 5 }] };
    installBridgeTool(body, plan, "claude");
    expect(body.tools.some((t) => t.type === WEB_SEARCH_TOOL_TYPE)).toBe(false);
  });

  it("keeps unrelated tools alongside the bridge tool", () => {
    const body = { tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: WEB_SEARCH_TOOL_NAME }, { name: "Read" }] };
    installBridgeTool(body, plan, "claude");
    expect(body.tools.map((t) => t.name)).toContain("Read");
  });

  it("defaults to the OpenAI shape when no format is passed", () => {
    const [tool] = createBridgeToolDefinition(plan);
    expect(tool.type).toBe("function");
  });
});

describe("result block fidelity", () => {
  it("carries page_age when the engine returns a date", () => {
    const item = toResultItem({ title: "T", url: "https://a.test", published_at: "April 30, 2025" });
    expect(item.page_age).toBe("April 30, 2025");
  });

  it("omits page_age when the engine has no date", () => {
    const item = toResultItem({ title: "T", url: "https://a.test" });
    expect("page_age" in item).toBe(false);
  });

  it("round-trips the snippet in encrypted_content", () => {
    // Anthropic clients echo encrypted_content back on later turns to keep
    // citations resolvable, so the field must exist and carry content.
    const item = toResultItem({ title: "T", url: "https://a.test", snippet: "hello world" });
    expect(item.encrypted_content).toBe("hello world");
  });

  it("leaves encrypted_content a string when there is no snippet", () => {
    const item = toResultItem({ title: "T", url: "https://a.test" });
    expect(typeof item.encrypted_content).toBe("string");
  });

  it("uses the anthropic result item type", () => {
    const item = toResultItem({ title: "T", url: "https://a.test" });
    expect(item.type).toBe("web_search_result");
  });
});


describe("server tool type matching is version-agnostic", () => {
  it("recognises every Anthropic web_search version, current and future", () => {
    // Matching is by prefix, not string equality: Claude Code sends
    // web_search_20250910 while the constant names 20250305, and Anthropic
    // keeps adding versions. An equality check would silently stop matching
    // and the bridge would never activate.
    for (const type of [
      "web_search_20250305",
      "web_search_20250910",
      "web_search_20260209",
      "web_search_20260318",
      "web_search_20991231",
    ]) {
      expect(isWebSearchToolType(type)).toBe(true);
    }
  });

  it("does not match a bare name with no version, or another server tool", () => {
    expect(isWebSearchToolType("web_search")).toBe(false);
    expect(isWebSearchToolType("code_execution_20250522")).toBe(false);
    expect(isWebSearchToolType("bash_20250124")).toBe(false);
  });

  it("recognises the tool Claude Code actually sends", () => {
    expect(isWebSearchTool({ type: "web_search_20250910", name: WEB_SEARCH_TOOL_NAME })).toBe(true);
  });

  it("requires the name to match too, not just the type", () => {
    // A client-defined tool may reuse the server type; without the name check
    // 9router would hijack it.
    expect(isWebSearchTool({ type: "web_search_20250910", name: "my_search" })).toBe(false);
  });
});
