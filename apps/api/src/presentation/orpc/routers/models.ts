/**
 * Model-registry procedures.
 *
 * Exposed over oRPC so a programmatic caller can do what the dashboard does:
 * read the catalogue, alias a model, disable one, add a custom model.
 *
 * Two deliberate omissions, both because this transport accepts an API key:
 *
 *  - **provider-node writes are absent.** A node is a URL this server will dial
 *    with stored credentials; a key that can add one can make the server fetch an
 *    arbitrary host.
 *  - **starting a catalogue sync is absent.** It fetches models.dev and rewrites
 *    the capability file the router reads.
 *
 * Reads stay here: they answer questions about the caller's own catalogue and
 * change nothing.
 */
import { z } from "zod"

import { audited, authed } from "../base.ts"

const AliasInput = z.object({ model: z.string(), alias: z.string() })
const AliasQuery = z.object({ alias: z.string() })

const DisabledInput = z.object({
	providerAlias: z.string(),
	ids: z.array(z.string()),
})

const CustomModelInput = z.object({
	providerAlias: z.string(),
	id: z.string(),
	type: z.string().optional(),
	name: z.string().optional(),
	ownedBy: z.string().optional(),
	caps: z.record(z.string(), z.unknown()).optional(),
	transport: z.string().optional(),
	inputMultiplier: z.number().optional(),
	outputMultiplier: z.number().optional(),
	antiProbe: z.unknown().optional(),
})

const CooldownInput = z.object({
	action: z.literal("clearCooldown"),
	provider: z.string(),
	model: z.string(),
})

const ProbeInput = z.object({ model: z.string(), kind: z.string().optional() })

const ListingQuery = z.object({ providerAlias: z.string().optional() }).optional()

export const modelsRouter = {
	/** Every model a client may call, with the plugin badges it carries. */
	list: authed.handler(async ({ context }) => ({
		models: await context.useCases.modelCatalogue.list(),
	})),

	aliases: {
		list: authed.handler(async ({ context }) => ({
			aliases: await context.useCases.modelAliases.list(),
		})),
		set: audited("model.set")
			.input(AliasInput)
			.handler(async ({ input, context }) => context.useCases.modelAliases.set(input)),
		remove: authed.input(AliasQuery).handler(async ({ input, context }) => {
			const result = await context.useCases.modelAliases.remove(input.alias)
			return { success: true, keysLeftForReview: result.keysLeftForReview }
		}),
	},

	disabled: {
		list: authed
			.input(ListingQuery)
			.handler(async ({ input, context }) =>
				context.useCases.disabledModels.list(input?.providerAlias ?? null),
			),
		disable: audited("model.disable")
			.input(DisabledInput)
			.handler(async ({ input, context }) => context.useCases.disabledModels.disable(input)),
		/** An absent `id` re-enables the provider's whole list. */
		enable: authed
			.input(z.object({ providerAlias: z.string(), id: z.string().optional() }))
			.handler(async ({ input, context }) =>
				context.useCases.disabledModels.enable({
					providerAlias: input.providerAlias,
					id: input.id ?? null,
				}),
			),
	},

	custom: {
		list: authed.handler(async ({ context }) => ({
			models: await context.useCases.customModels.list(),
		})),
		add: authed.input(CustomModelInput).handler(async ({ input, context }) => ({
			added: await context.useCases.customModels.add(input),
		})),
		remove: authed
			.input(z.object({ providerAlias: z.string(), id: z.string(), type: z.string().optional() }))
			.handler(async ({ input, context }) => {
				const result = await context.useCases.customModels.remove({
					providerAlias: input.providerAlias,
					id: input.id,
					type: input.type ?? "llm",
				})
				return { success: true, keysLeftForReview: result.keysLeftForReview }
			}),
	},

	availability: {
		list: authed.handler(async ({ context }) => context.useCases.modelAvailability.list()),
		clearCooldown: authed
			.input(CooldownInput)
			.handler(async ({ input, context }) => context.useCases.modelAvailability.clearCooldown(input)),
	},

	/** A single probe, so a caller can check a model before relying on it. */
	probe: authed
		.input(ProbeInput)
		.handler(async ({ input, context }) => context.useCases.modelProbe.ping(input)),

	/** The daily catalogue sync's state. Starting one is dashboard-only. */
	syncStatus: authed.handler(async ({ context }) => context.useCases.catalogueSync.status()),
}

export type ModelsRouter = typeof modelsRouter
