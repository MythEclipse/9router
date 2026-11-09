/** Combo fusion. */
import { extractTextContent } from "../translator/formats/gemini.ts"
import { deepCopyBody, flattenToolHistory } from "./combo-response.ts"

function extractPanelText(json) {
	if (!json || typeof json !== "object") return ""

	// OpenAI chat completion
	const choice = json.choices?.[0]
	if (choice) {
		const msg = choice.message ?? choice.delta ?? {}
		const t = extractTextContent(msg.content)
		if (t.trim()) return t
		if (typeof choice.text === "string" && choice.text.trim()) return choice.text
	}

	// Claude messages (text blocks share OpenAI's {type:"text"} shape)
	const claudeText = extractTextContent(json.content)
	if (claudeText.trim()) return claudeText

	// Gemini (parts carry .text without a type discriminator)
	const parts = json.candidates?.[0]?.content?.parts
	if (Array.isArray(parts)) {
		const t = parts.map((p) => p?.text || "").join("")
		if (t.trim()) return t
	}

	// OpenAI Responses API
	if (Array.isArray(json.output)) {
		const t = json.output
			.flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
			.join("")
		if (t.trim()) return t
	}

	return ""
}

/**
 * Append a synthesized user turn to whichever message array the request format uses.
 * Preserves the original conversation + system prompt so the judge has full context.
 */
function appendUserTurn(body, text) {
	const next = { ...body }
	if (Array.isArray(body.messages)) {
		next.messages = [...body.messages, { role: "user", content: text }]
	} else if (Array.isArray(body.input)) {
		next.input = [...body.input, { role: "user", content: text }]
	} else if (Array.isArray(body.contents)) {
		next.contents = [...body.contents, { role: "user", parts: [{ text }] }]
	} else {
		next.messages = [{ role: "user", content: text }]
	}
	return next
}

/**
 * Build the judge directive. Per OpenRouter's Fusion design, the judge does NOT
 * merge - it analyzes (consensus / contradictions / partial coverage / unique
 * insights / blind spots) then writes one answer grounded in that analysis.
 * ~3/4 of fusion's quality lift comes from this synthesis step.
 *
 * Sources are anonymized ("Source N") so the judge weighs substance, not the
 * reputation of a model brand.
 */
function buildJudgePrompt(answers) {
	const panel = answers.map((a, i) => `[Source ${i + 1}]\n${a.text}`).join("\n\n")

	return [
		`You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
		"",
		"Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
		"",
		"First, internally analyze the panel along these dimensions: consensus (points most sources agree on - treat as higher-confidence), contradictions (where they disagree - resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis - more complete and correct than any single response, with no filler.",
		"",
		"=== PANEL RESPONSES ===",
		panel,
		"=== END PANEL RESPONSES ===",
		"",
		"Now write the final answer to the user's original request.",
	].join("\n")
}

// Fusion tuning. Overridable per-combo via settings.comboStrategies[name].
const FUSION_DEFAULTS = {
	minPanel: 2, // answers needed before stragglers get a grace window
	stragglerGraceMs: 8000, // wait this long for laggards once quorum is reached
	panelHardTimeoutMs: 90000, // absolute cap so one hung model can't stall forever
}

/** Marker results the panel collector can receive in place of a Response. */
interface PanelTimeout {
	__timeout: true
}

interface PanelError {
	__error: unknown
}

type PanelOutcome<T> = T | PanelTimeout | PanelError

// Resolve a Response (or {__error}) within ms; the loser keeps running but is ignored.
function withTimeout<T>(promise: Promise<T> | T, ms: number): Promise<PanelOutcome<T>> {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve({ __timeout: true }), ms)
		Promise.resolve(promise)
			.then((v) => {
				clearTimeout(t)
				resolve(v)
			})
			.catch((e) => {
				clearTimeout(t)
				resolve({ __error: e })
			})
	})
}

/**
 * Collect panel responses with quorum-grace: as soon as `minPanel` calls succeed,
 * start a short grace timer for the rest, then proceed with whatever arrived. This
 * caps the straggler penalty (the slowest model otherwise dominates wall time) while
 * still preferring a full panel when everyone is fast. Bounded by a hard timeout.
 * Returns a sparse array aligned to `calls` (undefined = not yet / dropped).
 */
function collectPanel<T>(
	calls: Array<Promise<PanelOutcome<T>> | PanelOutcome<T>>,
	{ minPanel, stragglerGraceMs, panelHardTimeoutMs }: typeof FUSION_DEFAULTS,
): Promise<Array<PanelOutcome<T> | undefined>> {
	return new Promise((resolve) => {
		const out: Array<PanelOutcome<T> | undefined> = new Array(calls.length)
		let settled = 0
		let ok = 0
		let finished = false
		let graceTimer: ReturnType<typeof setTimeout> | null = null
		const finish = () => {
			if (finished) return
			finished = true
			clearTimeout(hardTimer)
			if (graceTimer) clearTimeout(graceTimer)
			resolve(out)
		}
		const hardTimer = setTimeout(finish, panelHardTimeoutMs)
		calls.forEach((p, i) => {
			Promise.resolve(p)
				.then((v) => {
					out[i] = v
				})
				.catch((e) => {
					out[i] = { __error: e }
				})
				.finally(() => {
					settled++
					if (out[i] && (out[i] as Response).ok) ok++
					if (settled === calls.length) return finish()
					if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs)
				})
		})
	})
}

/**
 * Handle a fusion combo: fan the prompt out to every panel model in parallel,
 * then a judge model synthesizes one final answer from all panel responses.
 *
 * Panel calls are forced non-streaming with tools stripped (the judge needs
 * complete prose to synthesize). The judge call keeps the client's original
 * stream flag + tools, so streaming and downstream tool use still work.
 *
 * Speed: quorum-grace collection caps the straggler penalty. Quality: the judge
 * runs the consensus/contradiction/blind-spot analysis before writing.
 *
 * Degrades gracefully: 0 panel answers -> 503, exactly 1 -> return it directly.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Panel model strings
 * @param {Function} options.handleSingleModel - (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.judgeModel] - Judge model; falls back to panel[0]
 * @param {Object} [options.tuning] - Override FUSION_DEFAULTS (minPanel, grace, timeout)
 * @returns {Promise<Response>}
 */
export async function handleFusionChat({
	body,
	models,
	handleSingleModel,
	log,
	comboName,
	judgeModel,
	tuning,
	signal = null,
}) {
	if (signal?.aborted) {
		return new Response(JSON.stringify({ error: { message: "Request aborted" } }), {
			status: 499,
			headers: { "Content-Type": "application/json" },
		})
	}

	const panel = Array.isArray(models) ? models.filter(Boolean) : []
	if (panel.length === 0) {
		return new Response(JSON.stringify({ error: { message: "Fusion combo has no models" } }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		})
	}

	// A single-model fusion has nothing to fuse - just answer directly.
	if (panel.length === 1) {
		return handleSingleModel(deepCopyBody(body), panel[0])
	}

	const cfg = { ...FUSION_DEFAULTS, ...(tuning || {}) }
	const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length)
	const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0]
	log.info(
		"FUSION",
		`Combo "${comboName}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`,
	)

	// 1. Fan out to the panel in parallel: non-streaming, tools stripped (we want prose).
	const { tools, tool_choice, stream_options, ...rest } = body
	// Fusion runs panel models non-streaming; drop stream_options too, or providers
	// like DeepSeek reject it with "stream_options should be set along with stream = true".
	// See issue #3024.
	const panelBody = deepCopyBody({ ...rest, stream: false })

	// Flatten tool turns to prose so panel models keep context without emitting tool_calls.
	if (Array.isArray(panelBody.messages)) {
		panelBody.messages = flattenToolHistory(panelBody.messages)
	} else if (Array.isArray(panelBody.input)) {
		panelBody.input = flattenToolHistory(panelBody.input)
	}

	const t0 = Date.now()
	// Copy the body per panel so translators in one parallel call cannot
	// mutate the objects used by the other panels.
	const calls = panel.map((m) =>
		withTimeout(handleSingleModel(deepCopyBody(panelBody), m, true), cfg.panelHardTimeoutMs),
	)
	const settled = await collectPanel(calls, { ...cfg, minPanel })
	log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`)

	// 2. Collect successful answers.
	const answers = []
	for (let i = 0; i < settled.length; i++) {
		const res = settled[i]
		const model = panel[i]
		if (!res) {
			log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`)
			continue
		}
		if (res.__timeout) {
			log.warn("FUSION", `Panel ${model} timed out`)
			continue
		}
		if (res.__error) {
			log.warn("FUSION", `Panel ${model} threw`, {
				error: res.__error?.message || String(res.__error),
			})
			continue
		}
		if (!res.ok) {
			log.warn("FUSION", `Panel ${model} failed`, { status: res.status })
			continue
		}
		try {
			const json = await res.clone().json()
			const text = extractPanelText(json)
			if (text) {
				answers.push({ model, text })
				log.info("FUSION", `Panel ${model} ok (${text.length} chars)`)
			} else {
				log.warn("FUSION", `Panel ${model} returned empty content`)
			}
		} catch (e) {
			log.warn("FUSION", `Panel ${model} unparseable`, { error: e.message || String(e) })
		}
	}

	// 3. Degrade gracefully when the panel is too thin to fuse.
	if (answers.length === 0) {
		log.warn("FUSION", "All panel models failed")
		return new Response(JSON.stringify({ error: { message: "All fusion panel models failed" } }), {
			status: 503,
			headers: { "Content-Type": "application/json" },
		})
	}
	if (answers.length === 1) {
		log.info("FUSION", `Only ${answers[0].model} succeeded - answering directly (no fusion)`)
		return handleSingleModel(deepCopyBody(body), answers[0].model)
	}

	// 4. Judge analyzes + writes one final answer (streams to client if requested).
	const judgeBody = appendUserTurn(body, buildJudgePrompt(answers))
	log.info("FUSION", `Judging ${answers.length} answers with ${judge}`)
	return handleSingleModel(deepCopyBody(judgeBody), judge)
}
