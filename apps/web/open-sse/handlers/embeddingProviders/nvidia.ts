// NVIDIA NIM embeddings.
//
// NIM's embed endpoint is OpenAI-shaped but not OpenAI-compatible: its retrieval
// models are *asymmetric*, and an asymmetric model refuses a request that does
// not say which side of the pair it is embedding:
//
//   [400]: 'input_type' parameter is required for asymmetric models
//
// The OpenAI embeddings schema has no such field, so a plain
// `/v1/embeddings` call - the dashboard's Test button, the example card, any
// client written against OpenAI - reached NIM without it and failed. The
// requirement is a property of the model, not of the call, so it is declared on
// the registry entry (`inputType`, `truncate`) and applied here; a caller that
// knows better (embedding a search query rather than a document) can still send
// its own `input_type` and it wins.
//
// `nvidia/nv-embedqa-e5-v5` is gone (410 Gone, end of life 2026-08-25), which is
// what this adapter was added alongside: the replacement models are asymmetric,
// so the retired model's plain OpenAI request shape could never have worked on
// them even if the id had been swapped.

import { PROVIDER_MEDIA, PROVIDER_MODELS } from "../../providers/index.ts"
import { bearerAuth } from "./_base.ts"

const PROVIDER_ID = "nvidia"

/** The registry entry for one model id, which carries its wire requirements. */
function modelEntry(model: string): Record<string, unknown> | undefined {
	const models = PROVIDER_MODELS[PROVIDER_ID] as Array<Record<string, unknown>> | undefined
	return models?.find((m) => m.id === model)
}

/** Request body for one NIM embeddings call. */
interface NvidiaEmbedContext {
	input?: unknown
	encoding_format?: string
	dimensions?: number | string
	/** `query` or `passage`; overrides the model's declared default. */
	input_type?: string
	/** `text`, `image` or `text_image` (VLM models). */
	modality?: string | string[]
	/** `START`, `END` or `NONE`; overrides the model's declared default. */
	truncate?: string
}

const Nvidia = {
	buildUrl: () =>
		(PROVIDER_MEDIA[PROVIDER_ID]?.embeddingConfig as { baseUrl?: string } | undefined)?.baseUrl,
	buildHeaders: (creds) => ({
		"Content-Type": "application/json",
		...bearerAuth(creds),
	}),
	buildBody: (
		model: string,
		{ input, encoding_format, dimensions, input_type, modality, truncate }: NvidiaEmbedContext = {},
	) => {
		const entry = modelEntry(model)
		const body: Record<string, unknown> = {
			model,
			input: typeof input === "string" ? [input] : input,
		}
		if (encoding_format) body.encoding_format = encoding_format

		const dim = Number(dimensions)
		if (dimensions != null && dimensions !== "" && Number.isFinite(dim) && dim > 0) {
			body.dimensions = dim
		}

		// A caller's choice wins; otherwise the model's own requirement. Omitted
		// entirely when neither exists - a symmetric model rejects a field it does
		// not implement, so this must not be sent "just in case".
		const resolvedInputType = input_type || (entry?.inputType as string | undefined)
		if (resolvedInputType) body.input_type = resolvedInputType

		const resolvedTruncate = truncate || (entry?.truncate as string | undefined)
		if (resolvedTruncate) body.truncate = resolvedTruncate

		// Modality is only ever the caller's: defaulting it to text_image would
		// change how a text-only vector is produced for a VLM model.
		if (modality) body.modality = modality

		return body
	},
	// NIM answers in the OpenAI embeddings shape already.
	normalize: (responseBody) => responseBody,
}

export default Nvidia
