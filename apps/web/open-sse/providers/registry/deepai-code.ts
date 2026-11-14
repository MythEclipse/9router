// DeepAI Code — the chat product behind https://deepai.org/chat/ai-code, served on
// api.deepai.org/deepai_code. OpenAI-shaped, not OpenAI-compatible: the key rides
// `Api-Key` (never `Authorization`), every call names a billing lane, and a device
// fingerprint decides which daily quota it is charged to. See shared/deepaiCode.ts
// for the wire contract and the shape upstream validates.
//
// Catalogue is hand-written rather than fetched: /deepai_code/models answers 401
// without a key (probed 2026-11-14), and the suggested-models proxy fetches
// unauthenticated, so a modelsFetcher here would only ever render an error.
// The list below is a snapshot of the live endpoint (27 models, verified with a real
// key) — it drifts, so refresh it against GET /deepai_code/models when upstream adds
// or retires models.
const DeepaiCode = {
	id: "deepai-code",
	priority: 118,
	alias: "deepai-code",
	aliases: ["deepai", "dai"],
	uiAlias: "deepai-code",
	display: {
		name: "DeepAI Code",
		icon: "terminal",
		color: "#1A1A1A",
		textIcon: "DA",
		website: "https://deepai.org/chat/ai-code",
		notice: {
			text:
				"Paste the DeepAI Code account key (UUID form, sent as the Api-Key header). Requests carry a device fingerprint, and the free daily Theos allowance is allocated per device, so several accounts on one host share it. Premier models spend Theos per request (2 to 50).",
			apiKeyUrl: "https://deepai.org/chat/ai-code",
			signupUrl: "https://deepai.org",
		},
	},
	category: "apikey",
	authType: "apikey",
	transport: {
		baseUrl: "https://api.deepai.org/deepai_code/chat/completions",
		validateUrl: "https://api.deepai.org/deepai_code/models",
		// Upstream's WAF answers 426 lane_version_unsupported to any request whose
		// User-Agent is literally `node` (verified: /models and /chat both 426), so
		// the UA is a requirement rather than a fingerprint. Any other value passes.
		headers: { "User-Agent": "9router/1.0" },
		// The key header is Api-Key, not Authorization; the hook adds the lane and
		// device headers the endpoint also requires.
		auth: { combined: true, header: "Api-Key", scheme: "raw", hooks: ["deepaiCodeHeaders"] },
		quirks: {
			// Upstream streams thinking under the OpenRouter alias `reasoning` instead
			// of reasoning_content; lift it for passthrough clients.
			reasoningAliasFields: true,
			// Defensive: the chat lane currently accepts bodies with and without a
			// leading system turn (verified), but /responses is documented to require
			// non-empty `instructions`, and the only model on that lane costs 50 Theos
			// to test. The filler is cheap and keeps both lanes on the documented shape.
			deepaiCodeShape: true,
		},
		// 409 session_busy is capacity, not a bad key: retry before rotating.
		retry: { 409: { attempts: 2, delayMs: 4000 } },
		// Daily Theos allowance; `balance`/`granted` arrive as strings.
		usage: { url: "https://api.deepai.org/deepai_code/theos" },
	},
	// gpt-6-astra only answers on the Responses lane; every other model is Chat.
	transports: [
		{
			format: "openai",
			baseUrl: "https://api.deepai.org/deepai_code/chat/completions",
			headers: { "User-Agent": "9router/1.0" },
			auth: { combined: true, header: "Api-Key", scheme: "raw", hooks: ["deepaiCodeHeaders"] },
		},
		{
			format: "openai-responses",
			baseUrl: "https://api.deepai.org/deepai_code/responses",
			headers: { "User-Agent": "9router/1.0" },
			auth: { combined: true, header: "Api-Key", scheme: "raw", hooks: ["deepaiCodeHeaders"] },
		},
	],
	models: [
		// Free lane: theosPerRequest 0, so these never touch the Theos allowance.
		{ id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
		{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
		{ id: "mimo-2.6-flash", name: "MiMo 2.6 Flash" },
		{ id: "mimo-2.6-pro", name: "MiMo 2.6 Pro" },
		{ id: "qwen-3.8-flash", name: "Qwen 3.8 Flash" },
		{ id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash" },
		{ id: "muse-ember", name: "Muse Ember" },
		{ id: "gpt-6-luna", name: "GPT-6 Luna" },
		{ id: "solar-mini-4", name: "Solar Mini 4" },
		{ id: "glyph-cluster", name: "Glyph Cluster" },
		{ id: "deepai-cyber", name: "DeepAI Cyber" },
		// Premier lane: spends Theos per request (2 to 50).
		{ id: "minimax-m3", name: "MiniMax M3" },
		{ id: "glm-5.3", name: "GLM 5.3" },
		{ id: "kimi-k3", name: "Kimi K3" },
		{ id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro" },
		{ id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
		{ id: "muse-spark-1.3", name: "Muse Spark 1.3" },
		{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
		{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
		{ id: "gemini-4-argon", name: "Gemini 4 Argon" },
		{ id: "gemini-4-carbon", name: "Gemini 4 Carbon" },
		{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
		{ id: "claude-opus-5-5", name: "Claude Opus 5.5" },
		{ id: "muse-wonder", name: "Muse Wonder" },
		{ id: "qwen-3.8-max-prime", name: "Qwen 3.8 Max Prime" },
		{ id: "claude-fable-5-2", name: "Claude Fable 5.2" },
		{
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			targetFormat: "openai-responses",
			supportedFormats: ["openai-responses"],
		},
	],
	features: { usage: true, usageApikey: true },
}

export default DeepaiCode
