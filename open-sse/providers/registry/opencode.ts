const Opencode = {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc1",
  uiAlias: "oc1",
  aliases: ["oc"],
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    timeoutMs: 45000,
    headers: {
      "x-opencode-client": "cli",
    },
    forceStream: true,
    noAuth: true,
    retry: {
      429: { attempts: 0, delayMs: 0 },
      502: { attempts: 0, delayMs: 0 },
      503: { attempts: 0, delayMs: 0 },
      504: { attempts: 0, delayMs: 0 },
    },
    // Zen reasoning models reject multi-turn history whose assistant messages
    // carry no reasoning_content (400 missing_required_parameter), and the
    // response pipeline strips the field before it reaches the client, so the
    // echo can never come from the client. Inject a placeholder instead.
    reasoningInject: {
      scope: "all",
    },
    quirks: {
      forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"],
      // The free lane's MiMo route (OpenRouter-backed) streams thinking as
      // `reasoning` + `reasoning_details[]`, not reasoning_content. stream.js lifts
      // the alias into reasoning_content for OpenAI-shaped clients; every other
      // model on the lane already emits reasoning_content, so the lift is a no-op.
      reasoningAliasFields: true,
    },
  },
  models: [
    { id: "beam-free", name: "Beam Free", isFree: true },
    { id: "big-pickle", name: "Big Pickle", isFree: true },
    { id: "flint-40b-free", name: "Flint 40B Free", isFree: true },
    { id: "glm-5.3-flash-free", name: "GLM-5.3-Flash Free", isFree: true },
    { id: "mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free", isFree: true },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", isFree: true },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", isFree: true },
    { id: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free", isFree: true },
    // Endpoint formats differ per model, so declare non-chat models explicitly.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses", isFree: true },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses", isFree: true },
    { id: "union-alpha", name: "Union Alpha Free", targetFormat: "claude", isFree: true },
    { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", supportedFormats: ["openai", "claude", "openai-responses"], isFree: true },
    // jev-1.13-free intentionally has no chat route: upstream answers
    // ModelProtocolUnsupported on /inference/v1/chat/completions for Jev ids,
    // and /zen/v1/systemone is a decision payload lane, not chat. Listing it
    // as a chat model only produces an unwinnable 400 loop in the fallback.
  ],
  serviceKinds: ["llm", "systemone"],
  systemoneConfig: {
    baseUrl: "https://opencode.ai/inference/v1/systemone",
    headers: {
      "x-opencode-client": "desktop",
      "User-Agent": "opencode/1.19.4 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/inference/v1/models", type: "opencode-free" },
  passthroughModels: true,
};

export default Opencode;
