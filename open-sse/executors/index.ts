import { AntigravityExecutor } from "./antigravity";
import { AzureExecutor } from "./azure";
import { BedrockExecutor } from "./bedrock";
import { GeminiCLIExecutor } from "./gemini-cli";
import { GithubExecutor } from "./github";
import { IFlowExecutor } from "./iflow";
import { QoderExecutor } from "./qoder";
import { KiroExecutor } from "./kiro";
import { KimchiExecutor } from "./kimchi";
import { CodexExecutor } from "./codex";
import { CursorExecutor } from "./cursor";
import { VertexExecutor } from "./vertex";
import { OpenCodeExecutor, OpenCodeV2Executor } from "./opencode";
import { OpenCodeGoExecutor } from "./opencode-go";
import { OpenCodeZenExecutor } from "./opencode-zen";
import { GrokCliExecutor } from "./grok-cli";
import { DeepSeekWebExecutor } from "./deepseek-web";
import { GeminiWebExecutor } from "./gemini-web";
import { KimiWebExecutor } from "./kimi-web";
import { OllamaLocalExecutor } from "./ollama-local";
import { CommandCodeExecutor } from "./commandcode";
import { XiaomiTokenplanExecutor } from "./xiaomi-tokenplan";
import { XiaomiMimoExecutor } from "./xiaomi-mimo";
import { MimoFreeExecutor } from "./mimo-free";
import { CodeBuddyExecutor } from "./codebuddy-cn";
import { CodeBuddyIntlExecutor } from "./codebuddy-intl";
import TraeExecutor from "./trae";
import ZedExecutor from "./zed";
import WindsurfExecutor from "./windsurf";
import { DefaultExecutor } from "./default";
import { MinimaxCodeExecutor } from "./minimax-code";
import { DevinCliExecutor } from "./devin-cli";
import { PerchAiExecutor } from "./perchai";

const executors = {
  antigravity: new AntigravityExecutor(),
  azure: new AzureExecutor(),
  "gemini-cli": new GeminiCLIExecutor(),
  github: new GithubExecutor(),
  iflow: new IFlowExecutor(),
  qoder: new QoderExecutor(),
  "qoder-cn": new QoderExecutor("qoder-cn"),
  kiro: new KiroExecutor(),
  kimchi: new KimchiExecutor(),
  codex: new CodexExecutor(),
  cursor: new CursorExecutor(),
  cu: new CursorExecutor(), // Alias for cursor
  vertex: new VertexExecutor("vertex"),
  "vertex-partner": new VertexExecutor("vertex-partner"),
  opencode: new OpenCodeExecutor(),
  "opencode-v2": new OpenCodeV2Executor(),
  oc2: new OpenCodeV2Executor(),
  oc1: new OpenCodeExecutor(),
  oc: new OpenCodeExecutor(),
  "opencode-go": new OpenCodeGoExecutor(),
  "opencode-zen": new OpenCodeZenExecutor(),
  "grok-cli": new GrokCliExecutor(),
  gcli: new GrokCliExecutor(), // Alias
  gb: new GrokCliExecutor(), // Alias (Grok Build)
  "deepseek-web": new DeepSeekWebExecutor(),
  dsw: new DeepSeekWebExecutor(),
  "deepseek-cookie": new DeepSeekWebExecutor(),
  "gemini-web": new GeminiWebExecutor(),
  gweb: new GeminiWebExecutor(),
  "gemini-cookie": new GeminiWebExecutor(),
  "kimi-web": new KimiWebExecutor(),
  kweb: new KimiWebExecutor(),
  "kimi-cookie": new KimiWebExecutor(),
  "ollama-local": new OllamaLocalExecutor(),
  commandcode: new CommandCodeExecutor(),
  "xiaomi-tokenplan": new XiaomiTokenplanExecutor(),
  "xiaomi-mimo": new XiaomiMimoExecutor(),
  mimocode: new MimoFreeExecutor(), // MiMoCode free channel (anonymous JWT)
  "mimocode-free": new MimoFreeExecutor(), // Alias for mimocode
  mmf: new MimoFreeExecutor(), // Retired id for the same channel
  "mimo-free": new MimoFreeExecutor(),
  "codebuddy-cn": new CodeBuddyExecutor(),
  "codebuddy-intl": new CodeBuddyIntlExecutor(),
  trae: new TraeExecutor(),
  zed: new ZedExecutor(),
  windsurf: new WindsurfExecutor(),
  "minimax-code": new MinimaxCodeExecutor("minimax-code"),
  "minimax-code-global": new MinimaxCodeExecutor("minimax-code-global"),
  "devin-cli": new DevinCliExecutor(),
  perchai: new PerchAiExecutor(),
  bedrock: new BedrockExecutor(),
  br: new BedrockExecutor(), // Alias for bedrock
  // Second Bedrock entry for xAI's Grok, which speaks OpenAI Chat Completions rather than the
  // Anthropic Messages format. Same executor, different registry transport format — the pattern
  // vertex / vertex-partner already uses.
  "bedrock-xai": new BedrockExecutor("bedrock-xai"),
  brx: new BedrockExecutor("bedrock-xai"), // Alias for bedrock-xai
};

const defaultCache = new Map();

export function getExecutor(provider) {
  if (executors[provider]) return executors[provider];
  if (!defaultCache.has(provider)) defaultCache.set(provider, new DefaultExecutor(provider));
  return defaultCache.get(provider);
}

export function hasSpecializedExecutor(provider) {
  return !!executors[provider];
}

export { BaseExecutor } from "./base";
export { AntigravityExecutor } from "./antigravity";
export { AzureExecutor } from "./azure";
export { BedrockExecutor } from "./bedrock";
export { GeminiCLIExecutor } from "./gemini-cli";
export { GithubExecutor } from "./github";
export { IFlowExecutor } from "./iflow";
export { QoderExecutor } from "./qoder";
export { KiroExecutor } from "./kiro";
export { KimchiExecutor } from "./kimchi";
export { CodexExecutor } from "./codex";
export { CursorExecutor } from "./cursor";
export { VertexExecutor } from "./vertex";
export { DefaultExecutor } from "./default";
export { OpenCodeExecutor } from "./opencode";
export { OpenCodeV2Executor } from "./opencode";
export { OpenCodeGoExecutor } from "./opencode-go";
export { OpenCodeZenExecutor } from "./opencode-zen";
export { GrokCliExecutor } from "./grok-cli";
export { OllamaLocalExecutor } from "./ollama-local";
export { CommandCodeExecutor } from "./commandcode";
export { XiaomiTokenplanExecutor } from "./xiaomi-tokenplan";
export { XiaomiMimoExecutor } from "./xiaomi-mimo";
export { MimoFreeExecutor } from "./mimo-free";
export { CodeBuddyExecutor } from "./codebuddy-cn";
export { CodeBuddyIntlExecutor } from "./codebuddy-intl";
export { default as TraeExecutor } from "./trae";
export { default as ZedExecutor } from "./zed";
export { default as WindsurfExecutor } from "./windsurf";
export { DevinCliExecutor } from "./devin-cli";
export { PerchAiExecutor } from "./perchai";
