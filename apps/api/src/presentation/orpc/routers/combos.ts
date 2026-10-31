/**
 * Combo procedures.
 *
 * Thin by construction: validate (schema), delegate (use-case), return. No rule
 * and no database call lives here, so the REST route and this router cannot
 * drift apart.
 */
import { audited, authed } from "../base.ts"
import {
	ComboCycleQuerySchema,
	ComboIdSchema,
	ComboPresetSourceSchema,
	CreateComboSchema,
	ListCombosOutputSchema,
	UpdateComboSchema,
} from "../schemas.ts"

export const combosRouter = {
	list: authed.output(ListCombosOutputSchema).handler(async ({ context }) => {
		return context.useCases.listCombos()
	}),

	get: authed
		.input(ComboIdSchema)
		.handler(async ({ input, context }) => context.useCases.getCombo(input.id)),

	create: audited("combo.create")
		.input(CreateComboSchema)
		.handler(async ({ input, context }) => context.useCases.createCombo(input)),

	update: audited("combo.update")
		.input(UpdateComboSchema)
		.handler(async ({ input, context }) => {
			const { id, ...changes } = input
			return context.useCases.updateCombo(id, changes)
		}),

	remove: audited("combo.remove")
		.input(ComboIdSchema)
		.handler(async ({ input, context }) => {
			return context.useCases.deleteCombo(input.id)
		}),

	duplicate: audited("combo.duplicate")
		.input(ComboIdSchema)
		.handler(async ({ input, context }) => {
			return context.useCases.duplicateCombo(input.id)
		}),

	/** Preview the presets a client source proposes, and which already exist. */
	previewPresets: authed
		.input(ComboPresetSourceSchema)
		.handler(async ({ input, context }) => context.useCases.previewComboPresets(input.source)),

	createPresets: authed
		.input(ComboPresetSourceSchema)
		.handler(async ({ input, context }) => context.useCases.createComboPresets(input.source)),

	/** Reports the chain when a studio would route back into the combo. */
	cycle: authed
		.input(ComboCycleQuerySchema)
		.handler(async ({ input, context }) => context.useCases.checkComboCycle(input)),
}
