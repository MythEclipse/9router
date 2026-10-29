/**
 * Model aliases and custom models.
 *
 * Two alias-writing handlers disagreed about what an alias entry is keyed by
 * (see `domain/model-alias.ts`); this use-case is the one place that decides
 * now, and both endpoints call it.
 *
 * The reconciler is awaited on every path that changes what a model is called,
 * because a key whose `allowedModels` still names the old alias will refuse
 * every request after the rename — with an error that blames the caller's key
 * rather than the rename that broke it.
 */

import {
	type CustomModelFields,
	isCustomModelRefusal,
	readCustomModel,
} from "../../domain/custom-model.ts"
import { invalid } from "../../domain/errors.ts"
import {
	type AliasMap,
	reconcileForAliasRepoint,
	validateAliasInput,
} from "../../domain/model-alias.ts"
import type { AllowedModelReconciler, CustomModelPort, ModelAliasPort } from "./ports.ts"

export interface AliasDependencies {
	readonly aliases: ModelAliasPort
	readonly reconciler: AllowedModelReconciler
}

export function makeModelAliases({ aliases, reconciler }: AliasDependencies) {
	return {
		async list(): Promise<AliasMap> {
			return aliases.list()
		},

		/**
		 * Point `alias` at `model`.
		 *
		 * `previous` is read first so a re-point can tell the reconciler what the
		 * alias used to resolve to. Reading and writing are not atomic — the store
		 * is a KV row — but the only writer is this endpoint, so the window is the
		 * dashboard's own double-submit.
		 */
		async set(input: { model: unknown; alias: unknown }): Promise<{ model: string; alias: string }> {
			const refusal = validateAliasInput(input)
			if (refusal) throw invalid(refusal.message)

			const model = String(input.model).trim()
			const alias = String(input.alias).trim()
			const before = await aliases.list()
			const previous = before[alias]

			await aliases.set(alias, model)

			const change = reconcileForAliasRepoint(previous, model)
			if (change) await reconciler.reconcile(change)

			return { model, alias }
		},

		/** Deleting an alias leaves any key that named it pointing at nothing. */
		async remove(alias: string): Promise<{ keysLeftForReview: string[] }> {
			if (!alias.trim()) throw invalid("Alias required")
			const name = alias.trim()
			await aliases.remove(name)
			const { emptied } = await reconciler.reconcile({ removed: [name] })
			return { keysLeftForReview: emptied }
		},
	}
}

export type ModelAliases = ReturnType<typeof makeModelAliases>

export interface CustomModelDependencies {
	readonly models: CustomModelPort
	readonly reconciler: AllowedModelReconciler
	/** The capability keys a custom model may carry. */
	readonly capabilityKeys: readonly string[]
	/** Recognised speech-to-text transports; anything else is dropped, not stored. */
	readonly knownTransport: (value: string) => boolean
}

/**
 * Custom models are added and removed here. The delete has to reconcile two
 * spellings — a key may hold the model bare or provider-qualified — which the
 * handler got right but only for this one endpoint.
 */
export function makeCustomModels({
	models,
	reconciler,
	capabilityKeys,
	knownTransport,
}: CustomModelDependencies) {
	return {
		async list(): Promise<Array<Record<string, unknown>>> {
			return models.list()
		},

		/**
		 * Filter the body before it reaches the store.
		 *
		 * The store merges whatever it is given, so an unrecognised transport used
		 * to land on the row and then survive every later save — a model pointing at
		 * a transport nothing can dial. `readCustomModel` decides what may be stored;
		 * this asserts its verdict.
		 */
		async add(body: Record<string, unknown>): Promise<unknown> {
			const fields = readCustomModel(
				{
					providerAlias: body.providerAlias,
					id: body.id,
					type: body.type,
					caps: body.caps,
					transport: body.transport,
				},
				capabilityKeys,
				knownTransport,
			)
			if (isCustomModelRefusal(fields)) throw invalid(fields.message)

			const { caps, transport, ...rest } = body as Record<string, unknown>
			return models.add({
				...rest,
				...(fields satisfies CustomModelFields),
				// `null` means "nothing usable arrived", and the store treats an
				// absent key as "leave the stored value alone" — which is what a
				// re-save with a bad transport must do.
				...(caps === undefined ? {} : { caps: fields.caps }),
				...(transport === undefined ? {} : fields.transport ? { transport: fields.transport } : {}),
			})
		},

		async remove(fields: {
			providerAlias: string
			id: string
			type: string
		}): Promise<{ keysLeftForReview: string[] }> {
			await models.remove(fields)
			const { emptied } = await reconciler.reconcile({
				removed: [fields.id, `${fields.providerAlias}/${fields.id}`],
			})
			return { keysLeftForReview: emptied }
		},
	}
}

export type CustomModels = ReturnType<typeof makeCustomModels>
