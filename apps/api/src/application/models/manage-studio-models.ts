/**
 * Studio models: the operator's own name for a model, used as a call target.
 *
 * Three rules were buried in the handler and are the reason this is a use-case:
 *
 *  - **A picked target is normalised before it is stored.** The picker sends
 *    `prefix/model`, where the prefix is a provider alias or a node prefix; the
 *    router resolves node ids, not node prefixes, so an unnormalised target
 *    resolves to nothing at request time. A bare name is either a combo or
 *    another studio model, and a chained studio name expands to *its* target so
 *    a rename upstream does not leave a dangling hop.
 *  - **Rename is create-then-delete, and the key reconcile comes after both.**
 *    Doing the delete first means a failed write has already destroyed the old
 *    row; doing the reconcile first renames keys to a name that does not exist
 *    yet.
 *  - **A cycle is refused, not detected at request time.** A studio model may
 *    target a combo whose members include the studio model, which would recurse
 *    until the request times out. The guard lives in `apps/web` beside the combo
 *    graph it walks, so it is injected.
 */
import { invalid, notFound } from "../../domain/errors.ts"
import type {
	AllowedModelReconciler,
	ComboReaderPort,
	NodePrefixPort,
	StudioModelPort,
} from "./ports.ts"

/** 64 chars, alphanumeric start, no "/" — the call name is a model id. */
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export interface StudioModelDependencies {
	readonly studios: StudioModelPort
	readonly combos: ComboReaderPort
	readonly nodes: NodePrefixPort
	readonly reconciler: AllowedModelReconciler
	/** Maps a provider alias to the provider id the router uses. */
	readonly resolveProviderAlias: (prefix: string) => string
	/** Returns a human description of the cycle, or null when the target is safe. */
	readonly findCycle: (input: {
		callName: string
		comboName: string
		combosByName: Map<string, string[]>
		studioTargets: Map<string, string>
		extraSelfNames: string[]
	}) => string | null
}

export function makeStudioModels(deps: StudioModelDependencies) {
	const { studios, combos, nodes, reconciler } = deps

	/**
	 * Resolve a picked target to the provider id the router uses.
	 *
	 * A bare name that is not a combo and not another studio model is returned
	 * unchanged, so the validator can refuse it with a message about *that* name
	 * rather than a generic failure.
	 */
	async function normalizeTarget(targetModel: string): Promise<string> {
		if (!targetModel.includes("/")) {
			const known = await combos.list().catch(() => [])
			if (known.some((combo) => combo.name === targetModel)) return targetModel
			const chained = await studios.find(targetModel).catch(() => null)
			if (chained && typeof chained.targetModel === "string") return chained.targetModel
			return targetModel
		}
		const firstSlash = targetModel.indexOf("/")
		if (firstSlash <= 0) return targetModel
		const prefix = targetModel.slice(0, firstSlash)
		const rest = targetModel.slice(firstSlash + 1)
		const nodeList = await nodes.list().catch(() => [])
		const matched = nodeList.find((node) => node.prefix === prefix || node.id === prefix)
		if (matched) return `${matched.id}/${rest}`
		return `${deps.resolveProviderAlias(prefix)}/${rest}`
	}

	async function validate(input: {
		callName: string
		targetModel: string
		previousName?: string
	}): Promise<string | null> {
		if (!NAME_PATTERN.test(input.callName)) {
			return 'Name must start with a letter or number and only use letters, numbers, dot, dash or underscore (max 64, no "/").'
		}
		if (!input.targetModel.trim()) return "Pick the model this name should call."

		const [models, comboList] = await Promise.all([studios.list(), combos.list().catch(() => [])])
		const renaming = input.callName !== input.previousName

		if (renaming && models.some((model) => model.callName === input.callName)) {
			return `"${input.callName}" already exists - pick another name.`
		}
		if (renaming && comboList.some((combo) => combo.name === input.callName)) {
			return `"${input.callName}" is already used by a combo.`
		}

		const target = input.targetModel.trim()
		if (!target.includes("/")) {
			// Bare names are combo targets only. A leftover studio chain still
			// resolves because `normalizeTarget` expanded it first; an unknown bare
			// name means the combo was renamed or deleted.
			if (!comboList.some((combo) => combo.name === target)) {
				return `"${target}" is not a combo. Pick a combo or a provider model.`
			}
			const cycle = deps.findCycle({
				callName: input.callName,
				comboName: target,
				combosByName: new Map<string, string[]>(
					comboList.map((combo) => [combo.name, combo.models ?? []] as [string, string[]]),
				),
				studioTargets: new Map<string, string>(
					models
						.filter((model) => model.callName !== input.callName && model.callName !== input.previousName)
						.map((model) => [String(model.callName), String(model.targetModel)] as [string, string]),
				),
				extraSelfNames:
					input.previousName && input.previousName !== input.callName ? [input.previousName] : [],
			})
			if (cycle) return cycle
		}
		return null
	}

	/** The fields a create and an update both write. */
	function fieldsOf(body: Record<string, unknown>, callName: string, targetModel: string) {
		return {
			callName,
			targetModel,
			// The label is what the operator picked; the target is what the router calls.
			targetLabel: body.targetModel,
			displayName: body.displayName,
			ownedBy: body.ownedBy,
			contextWindow: body.contextWindow,
			systemPrompt: body.systemPrompt,
			inputMultiplier: body.inputMultiplier,
			outputMultiplier: body.outputMultiplier,
			antiProbe: body.antiProbe,
		}
	}

	return {
		async list(): Promise<Array<Record<string, unknown>>> {
			return studios.list()
		},

		async create(body: Record<string, unknown>): Promise<unknown> {
			const callName = String(body.callName ?? "").trim()
			const targetModel = await normalizeTarget(String(body.targetModel ?? "").trim())
			const refusal = await validate({ callName, targetModel })
			if (refusal) throw invalid(refusal)
			return studios.save(fieldsOf(body, callName, targetModel))
		},

		async update(body: Record<string, unknown>): Promise<unknown> {
			const previousName = String(body.previousName || body.callName || "").trim()
			const callName = String(body.callName ?? "").trim()
			const targetModel = await normalizeTarget(String(body.targetModel ?? "").trim())

			const existing = await studios.find(previousName)
			if (!existing) throw notFound(`Model "${previousName}"`)

			const refusal = await validate({ callName, targetModel, previousName })
			if (refusal) throw invalid(refusal)

			// Written before the old row goes: a failed write must not destroy the
			// name it was meant to replace.
			const saved = await studios.save(fieldsOf(body, callName, targetModel))
			if (previousName !== callName) {
				await studios.remove(previousName)
				// A key listing the old name follows it, rather than pointing at a
				// model that no longer exists.
				await reconciler.reconcile({ renamed: { [previousName.toLowerCase()]: callName } })
			}
			return saved
		},

		async remove(callName: string): Promise<{ keysLeftForReview: string[] }> {
			const name = callName.trim()
			if (!name) throw invalid("name is required")
			const existing = await studios.find(name)
			if (!existing) throw notFound("Model")
			await studios.remove(name)
			const { emptied } = await reconciler.reconcile({ removed: [name] })
			return { keysLeftForReview: emptied }
		},
	}
}

export type StudioModels = ReturnType<typeof makeStudioModels>
