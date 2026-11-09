import enquirer from "enquirer"
import { CLAUDE_MODELS, resolveTools, TOOLS } from "../connectTools.js"
import {
	Cancelled,
	getOrCreateApiKey,
	HELP,
	loadSavedPassword,
	login,
	maskKey,
	normalizeServerUrl,
	parseArgs,
	prompt,
	promptPassword,
	request,
	savedEnvPath,
	savePassword,
} from "./auth.js"

const { MultiSelect, Password } = enquirer

// Non-Claude tools that take a single model id (omp discovers all models itself).
const needsModel = (t) => t.id !== "claude" && t.needsModel !== false

/**
 * Model choices the server operator already made, read from the server's own
 * cli-tools config. Only model ids are taken — never the server's baseUrl or
 * apiKey, which belong to that host and must not be copied to this machine.
 * Best-effort: any failure returns {} and the built-in defaults apply.
 */
async function fetchServerModels(server, cookie, tools) {
	const out = { claude: {}, byTool: {}, shared: null }
	if (!cookie) return out

	const get = async (route) => {
		try {
			const res = await request(`${server}/api/cli-tools/${route}`, { cookie })
			return res.status === 200 ? res.data : null
		} catch {
			return null // unreachable/unreadable — caller keeps defaults
		}
	}

	if (tools.some((t) => t.id === "claude")) {
		const env = (await get("claude-settings"))?.settings?.env
		for (const m of CLAUDE_MODELS) {
			if (typeof env?.[m.envKey] === "string" && env[m.envKey]) out.claude[m.flag] = env[m.envKey]
		}
	}

	// Each tool's own server config; OpenCode doubles as the shared fallback, so
	// fetch it even when opencode itself wasn't selected.
	const opencodeTool = TOOLS.find((t) => t.id === "opencode")
	const wanted = tools.filter((t) => t.route)
	if (!wanted.includes(opencodeTool) && tools.some(needsModel)) wanted.push(opencodeTool)

	await Promise.all(
		wanted.map(async (t) => {
			const data = await get(t.route)
			if (!data) return
			try {
				const model = await t.serverModel(data)
				if (model) out.byTool[t.id] = model
			} catch {
				/* malformed config on the server — skip this tool */
			}
		}),
	)
	out.shared = out.byTool.opencode || null
	return out
}

async function listModels(server, apiKey) {
	const res = await request(`${server}/v1/models`, { apiKey })
	if (res.status === 401) throw new Error("API key rejected by server (/v1/models returned 401)")
	if (res.status !== 200) return null
	return new Set((res.data?.data || []).map((m) => m.id))
}

async function promptTools() {
	return prompt(
		new MultiSelect({
			message: "Select CLI tools to configure (space to toggle, enter to confirm)",
			choices: TOOLS.map((t) => ({
				name: t.id,
				message: t.name,
				hint: t.paths()[0],
				enabled: t.id === "claude",
			})),
			validate: (v) => v.length > 0 || "Select at least one tool",
		}),
	)
}

async function selectTools(opts) {
	if (opts.tools) return resolveTools(opts.tools)
	if (process.stdin.isTTY) return resolveTools(await promptTools())
	return resolveTools(["claude"])
}

async function run(argv) {
	try {
		return await runConnect(argv)
	} catch (err) {
		if (err instanceof Cancelled) {
			console.log("Cancelled.")
			return 130
		}
		throw err
	}
}

async function runConnect(argv) {
	const opts = parseArgs(argv)
	if (opts.help) {
		console.log(HELP)
		return 0
	}
	if (!opts.reset && !opts.url) {
		console.log(HELP)
		return 1
	}

	// Pick tools before any network call: bad names fail fast, and cancelling
	// the picker never leaves a freshly created key on the server.
	const tools = await selectTools(opts)

	if (opts.reset) {
		let failed = 0
		for (const t of tools) {
			try {
				const files = await t.reset()
				console.log(
					files.length
						? `✅ ${t.name}: removed 9router settings (${files.join(", ")})`
						: `• ${t.name}: nothing to reset`,
				)
			} catch (err) {
				failed++
				console.log(`❌ ${t.name}: ${err.message}`)
			}
		}
		return failed ? 1 : 0
	}

	const server = normalizeServerUrl(opts.url)
	const isRemoteHttp =
		server.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(server)
	if (isRemoteHttp) {
		console.log(
			"\x1b[33m⚠ Plain HTTP: password and API key travel unencrypted. Use only on a trusted LAN/VPN.\x1b[0m",
		)
	}

	let apiKey = opts.apiKey
	let cookie = null
	if (apiKey) {
		console.log("• Using provided API key")
	} else {
		const saved = opts.password ? null : loadSavedPassword(server)
		if (saved) console.log(`• Using saved password (${savedEnvPath()})`)
		const password = opts.password ?? saved ?? (await promptPassword())
		console.log(`• Logging in to ${server}`)
		try {
			cookie = await login(server, password)
		} catch (err) {
			if (saved)
				err.message += ` — saved password may be stale; delete ${savedEnvPath()} or pass --password`
			throw err
		}
		if (opts.save && password !== saved) {
			console.log(`• Saved password to ${savePassword(server, password)} (plain text, mode 600)`)
		}
		const result = await getOrCreateApiKey(server, cookie, opts.keyName)
		apiKey = result.key
		console.log(
			`• ${result.created ? "Created" : "Reusing"} API key "${opts.keyName}" (${maskKey(apiKey)})`,
		)
	}

	// Models always come from the server's own cli-tools config; flags override.
	const serverModels = await fetchServerModels(server, cookie, tools)
	if (!cookie) {
		console.log(
			"• --api-key given: can't read the server's models (needs a dashboard login) — pass model flags",
		)
	}

	const available = await listModels(server, apiKey)
	const warnMissing = (label, model, flag) => {
		// Claude Code's "[1m]" context marker is part of the env value, not the model id.
		if (available && !available.has(model.replace(/\[1m\]$/, ""))) {
			console.log(
				`\x1b[33m⚠ ${label}: "${model}" not listed by server — override with ${flag} <model>\x1b[0m`,
			)
		}
	}

	// Claude tier: flag > server value > unset (Claude Code then uses its own default).
	const claudeModels = {}
	const claudeUnset = []
	if (tools.some((t) => t.id === "claude")) {
		for (const m of CLAUDE_MODELS) {
			const model = opts.models[m.flag] || serverModels.claude[m.flag] || null
			claudeModels[m.envKey] = model
			if (model) warnMissing(`claude ${m.flag}`, model, `--${m.flag}`)
			else claudeUnset.push(m.flag)
		}
	}
	// Other tools: --model > that tool's own server model > server's OpenCode model.
	// No hardcoded fallback — a tool with no model anywhere is skipped.
	const toolModels = {}
	const fromOpencode = []
	for (const t of tools) {
		if (!needsModel(t)) continue
		toolModels[t.id] = opts.model || serverModels.byTool[t.id] || serverModels.shared || null
		if (!opts.model && !serverModels.byTool[t.id] && serverModels.shared) fromOpencode.push(t.id)
	}
	for (const m of new Set(Object.values(toolModels).filter(Boolean)))
		warnMissing("model", m, "--model")
	if (fromOpencode.length) {
		console.log(`• ${fromOpencode.join(", ")}: no own model on the server — using its OpenCode model`)
	}

	let failed = 0
	let skipped = 0
	for (const t of tools) {
		if (needsModel(t) && !toolModels[t.id]) {
			skipped++
			console.log(`⏭  ${t.name}: no model configured on the server — skipped (pass --model <model>)`)
			continue
		}
		const ctx = { baseUrl: server, apiKey, model: toolModels[t.id], claudeModels }
		try {
			const files = await t.apply(ctx)
			console.log(`✅ ${t.name} → ${files.join(", ")}`)
		} catch (err) {
			failed++
			console.log(`❌ ${t.name}: ${err.message}`)
		}
	}
	console.log(`   Base URL: ${server}/v1`)
	if (tools.some((t) => t.id === "claude")) {
		for (const m of CLAUDE_MODELS) {
			if (claudeModels[m.envKey]) console.log(`   ${m.envKey}=${claudeModels[m.envKey]}`)
		}
		if (claudeUnset.length) {
			console.log(
				`   Claude ${claudeUnset.join(", ")}: not set on the server — Claude Code's own default applies (or pass --${claudeUnset[0]} <model>)`,
			)
		}
	}
	for (const [id, m] of Object.entries(toolModels)) if (m) console.log(`   ${id} model: ${m}`)
	if (tools.some((t) => t.id === "omp"))
		console.log("   omp models: every server model, listed under 9router in /model")
	console.log(
		`   Restart the tools to apply. Undo: npx 9router connect --reset --tools ${tools.map((t) => t.id).join(",")}`,
	)

	if (opts.printEnv) {
		console.log("\nOpenAI-compatible CLIs (codex, opencode, aider, …):")
		console.log(`   OPENAI_BASE_URL=${server}/v1`)
		console.log(`   OPENAI_API_KEY=${apiKey}`)
	}
	// A skipped tool was not configured, so the run did not do what was asked.
	return failed || skipped ? 1 : 0
}

export { run, runConnect }
