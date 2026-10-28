/**
 * Read, update, and reset pricing.
 *
 * Validation lives in `domain/pricing.ts`; this layer translates a rejection
 * into an `AppError` and routes a reset target to the port.
 */

import { invalid } from "../../domain/errors.ts"
import { parsePricingResetTarget, parsePricingUpdate } from "../../domain/pricing.ts"
import type { PricingMap, PricingPort } from "../dependencies.ts"

export function makeGetPricing(port: PricingPort) {
	return (): Promise<PricingMap> => port.read()
}

export function makeUpdatePricing(port: PricingPort) {
	return async (body: unknown): Promise<PricingMap> => {
		const parsed = parsePricingUpdate(body)
		if (parsed.ok === false) throw invalid(parsed.error.reason, parsed.error.path)
		return port.update(parsed.value)
	}
}

export function makeResetPricing(port: PricingPort) {
	return async (
		provider: string | null | undefined,
		model: string | null | undefined,
	): Promise<PricingMap> => {
		const parsed = parsePricingResetTarget(provider, model)
		if (parsed.ok === false) throw invalid(parsed.error.reason, parsed.error.path)
		return port.reset(parsed.value)
	}
}
