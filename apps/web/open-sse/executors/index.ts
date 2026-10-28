import { AntigravityExecutor } from "./antigravity.ts"
import { AzureExecutor } from "./azure.ts"
import { BedrockExecutor } from "./bedrock.ts"
import { CodeBuddyExecutor } from "./codebuddy-cn.ts"
import { CodeBuddyIntlExecutor } from "./codebuddy-intl.ts"
import { CodexExecutor } from "./codex.ts"
import { CommandCodeExecutor } from "./commandcode.ts"
import { CursorExecutor } from "./cursor.ts"
import { DeepSeekWebExecutor } from "./deepseek-web.ts"
import { DefaultExecutor } from "./default.ts"
import { DevinCliExecutor } from "./devin-cli.ts"
import { GeminiCLIExecutor } from "./gemini-cli.ts"
import { GeminiWebExecutor } from "./gemini-web.ts"
import { GithubExecutor } from "./github.ts"
import { GrokCliExecutor } from "./grok-cli.ts"
import { IFlowExecutor } from "./iflow.ts"
import { KimchiExecutor } from "./kimchi.ts"
import { KimiWebExecutor } from "./kimi-web.ts"
import { KiroExecutor } from "./kiro.ts"
import { MimoFreeExecutor } from "./mimo-free.ts"
import { MinimaxCodeExecutor } from "./minimax-code.ts"
import { OllamaLocalExecutor } from "./ollama-local.ts"
import { OpenCodeExecutor } from "./opencode.ts"
import { OpenCodeGoExecutor } from "./opencode-go.ts"
import { OpenCodeZenExecutor } from "./opencode-zen.ts"
import { PerchAiExecutor } from "./perchai.ts"
import { QoderExecutor } from "./qoder.ts"
import TraeExecutor from "./trae.ts"
import { VertexExecutor } from "./vertex.ts"
import WindsurfExecutor from "./windsurf.ts"
import { XiaomiMimoExecutor } from "./xiaomi-mimo.ts"
import { XiaomiTokenplanExecutor } from "./xiaomi-tokenplan.ts"
import ZedExecutor from "./zed.ts"

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
}

const defaultCache = new Map()

export function getExecutor(provider) {
	if (executors[provider]) return executors[provider]
	if (!defaultCache.has(provider)) defaultCache.set(provider, new DefaultExecutor(provider))
	return defaultCache.get(provider)
}

export function hasSpecializedExecutor(provider) {
	return !!executors[provider]
}

export { AntigravityExecutor } from "./antigravity.ts"
export { AzureExecutor } from "./azure.ts"
export { BaseExecutor } from "./base.ts"
export { BedrockExecutor } from "./bedrock.ts"
export { CodeBuddyExecutor } from "./codebuddy-cn.ts"
export { CodeBuddyIntlExecutor } from "./codebuddy-intl.ts"
export { CodexExecutor } from "./codex.ts"
export { CommandCodeExecutor } from "./commandcode.ts"
export { CursorExecutor } from "./cursor.ts"
export { DefaultExecutor } from "./default.ts"
export { DevinCliExecutor } from "./devin-cli.ts"
export { GeminiCLIExecutor } from "./gemini-cli.ts"
export { GithubExecutor } from "./github.ts"
export { GrokCliExecutor } from "./grok-cli.ts"
export { IFlowExecutor } from "./iflow.ts"
export { KimchiExecutor } from "./kimchi.ts"
export { KiroExecutor } from "./kiro.ts"
export { MimoFreeExecutor } from "./mimo-free.ts"
export { OllamaLocalExecutor } from "./ollama-local.ts"
export { OpenCodeExecutor } from "./opencode.ts"
export { OpenCodeGoExecutor } from "./opencode-go.ts"
export { OpenCodeZenExecutor } from "./opencode-zen.ts"
export { PerchAiExecutor } from "./perchai.ts"
export { QoderExecutor } from "./qoder.ts"
export { default as TraeExecutor } from "./trae.ts"
export { VertexExecutor } from "./vertex.ts"
export { default as WindsurfExecutor } from "./windsurf.ts"
export { XiaomiMimoExecutor } from "./xiaomi-mimo.ts"
export { XiaomiTokenplanExecutor } from "./xiaomi-tokenplan.ts"
export { default as ZedExecutor } from "./zed.ts"
