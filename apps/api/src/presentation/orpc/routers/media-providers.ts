/**
 * Media-provider procedures — the TTS voice catalogues the pickers read.
 *
 * All five answer the same shape: the voices, the languages they span, and the same voices
 * keyed by language. `?lang=` narrows to one language, and the narrowing is applied *before*
 * grouping so the language list matches the voices — filtering afterwards would advertise
 * languages whose list is now empty.
 *
 * Everything is `authed`: a voice list is derived from a stored provider connection, and the
 * generic endpoint also accepts a key in the query, so none of this is public.
 */
import { z } from "zod"
import { authed } from "../base.ts"

const Lang = z.object({ lang: z.string().optional() }).optional()

export const mediaProvidersRouter = {
	/** `/tts/voices` — edge-tts, local-device, elevenlabs and gemini behind one query. */
	mediaVoices: authed
		.input(
			z
				.object({
					provider: z.string().optional(),
					lang: z.string().optional(),
					apiKey: z.string().optional(),
				})
				.optional(),
		)
		.handler(async ({ input, context }) =>
			context.useCases.ttsVoices.listing({
				provider: input?.provider,
				lang: input?.lang,
				apiKey: input?.apiKey,
			}),
		),

	/** One voice per model, language in `languages` or the canonical-name suffix. */
	deepgramVoices: authed
		.input(Lang)
		.handler(async ({ input, context }) =>
			context.useCases.ttsVoices.deepgram({ lang: input?.lang }),
		),

	/** A voice is listed under every language it was verified for, not only its primary one. */
	elevenlabsVoices: authed
		.input(Lang)
		.handler(async ({ input, context }) =>
			context.useCases.ttsVoices.elevenlabs({ lang: input?.lang }),
		),

	/** `languages: [...]` per voice; a voice with none is still usable. */
	inworldVoices: authed
		.input(Lang)
		.handler(async ({ input, context }) => context.useCases.ttsVoices.inworld({ lang: input?.lang })),

	/** Two hosts, and a failure reported inside a 200 body. */
	minimaxVoices: authed
		.input(
			z
				.object({
					provider: z.string().optional(),
					voiceType: z.string().optional(),
					lang: z.string().optional(),
				})
				.optional(),
		)
		.handler(async ({ input, context }) =>
			context.useCases.ttsVoices.minimax({
				provider: input?.provider,
				voiceType: input?.voiceType,
				lang: input?.lang,
			}),
		),
}

export type MediaProvidersRouter = typeof mediaProvidersRouter
