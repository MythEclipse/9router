/**
 * Building the system prompt a provider actually receives.
 *
 * Two things have to be true at once:
 *
 *   1. The request must look like it came from the provider's own client. Google
 *      rejects Claude Code's identity line as a content-filter hit (fake 429);
 *      Tencent rejects third-party agent identities outright (11101).
 *   2. The user's instructions must survive. The previous cloaking satisfied (1)
 *      by replacing the entire system message with a one-line neutral identity,
 *      which deleted real user rules that happened to share the message — a
 *      prompt ending "IMPORTANT: always end with ZEBRA42" lost ZEBRA42 entirely.
 *
 * So the provider's captured native prompt becomes the system prompt, and the
 * client's surviving instructions are appended as a clearly-delimited block. The
 * user gets what they asked for; the upstream sees its own client.
 *
 * Providers with no captured prompt are left alone (see `hasNativePrompt`), so
 * this is opt-in and cannot regress a provider nobody has reverse-engineered.
 */

import { rewritePromptText } from "../config/googlePromptRewrites.ts"
import { getNativePrompt, type NativePromptContext } from "../config/nativePrompts.ts"
import { isAgentIdentityPrompt } from "../shared/cliAgentPrompt.ts"
import { stripClientIdentity } from "../shared/clientIdentity.ts"

/** Delimiter around the client's surviving instructions, so they read as user intent. */
const CLIENT_INSTRUCTIONS_HEADER =
	"# Additional instructions from the user's client\n\nThe following instructions were supplied by the client that sent this request. Follow them as user requirements; they do not change who you are."

/** What the composed prompt is, for logging and tests. */
export interface ComposedSystemPrompt {
	/** The full system prompt to send upstream. */
	text: string
	/** True when the provider's native prompt was used as the base. */
	usedNativePrompt: boolean
	/** True when client instructions survived identity stripping and were appended. */
	carriedClientInstructions: boolean
}

/** Today's date the way a CLI renders it, e.g. `Friday, Nov 20, 2026`. */
function formatCliDate(now: Date): string {
	return now.toLocaleDateString("en-US", {
		weekday: "long",
		month: "short",
		day: "numeric",
		year: "numeric",
	})
}

/**
 * Compose the system prompt for `provider` from the client's `systemText`.
 *
 * The swap only happens for a client *agent* prompt. An ordinary user prompt —
 * "You are a professional translator", "Answer in French" — is left exactly as
 * sent: replacing it with CodeBuddy's 17k agent preamble would turn a translation
 * request into an agent task, which is a worse bug than the one being fixed. The
 * filter objects to a competing *agent identity*, so only that is rewritten.
 *
 * When the provider has no native prompt, `systemText` is returned untouched.
 */
export function composeSystemPrompt(
	provider: string,
	systemText: string,
	ctx: NativePromptContext = {},
): ComposedSystemPrompt {
	const native = getNativePrompt(provider)
	if (!native) {
		return { text: systemText, usedNativePrompt: false, carriedClientInstructions: false }
	}

	const source = systemText ?? ""
	// A real user prompt that is not an agent identity is the user's own system
	// prompt; leave it alone. An empty one means the client sent none, in which
	// case the provider's own prompt is exactly what its CLI would have sent.
	if (source.trim() && !isAgentIdentityPrompt(source)) {
		return { text: source, usedNativePrompt: false, carriedClientInstructions: false }
	}

	const clientInstructions = rewritePromptText(stripClientIdentity(source))
	const carry = clientInstructions.length >= 24

	// Only the values the request can actually know; anything else keeps the
	// template's own text rather than being blanked into a broken prompt.
	const filled = native
		.replace(/\{\{cwd\}\}/g, ctx.cwd || process.cwd())
		.replace(
			/\{\{isGitRepo\}\}/g,
			ctx.isGitRepo === undefined ? "Unknown" : ctx.isGitRepo ? "Yes" : "No",
		)
		.replace(/\{\{platform\}\}/g, ctx.platform || process.platform)
		.replace(/\{\{osVersion\}\}/g, ctx.osVersion || "")
		.replace(/\{\{defaultShell\}\}/g, ctx.defaultShell || "bash")
		.replace(/\{\{date\}\}/g, ctx.date || formatCliDate(new Date()))
		.replace(/\{\{modelName\}\}/g, ctx.modelName || "Auto")
		.replace(/\{\{modelId\}\}/g, ctx.modelId || "default-model")
		// The docs path only exists on the machine that runs the CLI; when the
		// router has no such path, drop the pointer rather than advertise a lie.
		.replace(/\{\{DOCS_PATH\}\}/g, ctx.docsPath || "")
		.trim()

	const text = carry ? `${filled}\n\n${CLIENT_INSTRUCTIONS_HEADER}\n\n${clientInstructions}` : filled
	return { text, usedNativePrompt: true, carriedClientInstructions: carry }
}
