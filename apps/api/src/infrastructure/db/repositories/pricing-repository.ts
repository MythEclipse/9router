/**
 * Adapter for {@link PricingPort}.
 *
 * The reset target is a three-way shape; `packages/db` exposes three functions.
 * Mapping the shape to the call is the whole job — deciding *which* scope was
 * asked for is a rule and lives in `domain/pricing.ts`.
 */
import {
	getPricing,
	resetAllPricing,
	resetPricing,
	updatePricing,
} from "@9router/db/repos/pricingRepo"
import type { PricingMap, PricingPort } from "../../../application/dependencies.ts"

export function createPricingRepository(): PricingPort {
	return {
		read: async () => (await getPricing()) as unknown as PricingMap,
		update: async (update) => (await updatePricing(update)) as unknown as PricingMap,
		async reset(target) {
			if (target.scope === "model") {
				return (await resetPricing(target.provider, target.model)) as unknown as PricingMap
			}
			if (target.scope === "provider") {
				return (await resetPricing(target.provider)) as unknown as PricingMap
			}
			await resetAllPricing()
			// The reset clears the overrides; what the caller wants back is the
			// catalogue as it now stands, not the empty override table.
			return (await getPricing()) as unknown as PricingMap
		},
	}
}
