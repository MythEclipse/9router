"use client"

import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers"

export interface ComboStrategy {
	fallbackStrategy?: string
	judgeModel?: string
	routerModel?: string
	smartPolicy?: string
	sessionSticky?: boolean
	confidenceThreshold?: number
	[key: string]: unknown
}

/** One capability entry: on/off, rotation mode, and the models that serve it. */
export interface CapEntry {
	enabled: boolean
	roundRobin: boolean
	models: string[]
}

export type CapacityAdapter = Record<string, CapEntry>

export const STRATEGY_OPTIONS = [
	{ value: "fallback", label: "Fallback - try in order" },
	{ value: "round-robin", label: "Round Robin - rotate" },
	{ value: "smart", label: "Smart Router - System One" },
	{ value: "fusion", label: "Fusion - panel + judge" },
]
export const fmtK = (n) => {
	if (!n) return "?"
	if (n >= 1000000) {
		const m = n / 1000000
		return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
	}
	return `${Math.round(n / 1000)}k`
}

export function getRouterModelStatus(routerModel, activeProviders) {
	const effectiveModel =
		typeof routerModel === "string" && routerModel.trim() ? routerModel.trim() : "oc/jev-1.13-free"
	const slashIdx = effectiveModel.indexOf("/")
	const prefix = slashIdx !== -1 ? effectiveModel.slice(0, slashIdx) : effectiveModel
	const providerId = resolveProviderId(prefix)
	const providerDef = AI_PROVIDERS[providerId]
	const isNoAuth = !!providerDef?.noAuth

	if (isNoAuth) {
		return { ready: true, label: "Ready (Free)", providerId }
	}

	const isConnected = (activeProviders || []).some(
		(c) => c.provider === providerId && c.isActive !== false,
	)
	if (isConnected) {
		return { ready: true, label: "Connected", providerId }
	}

	return { ready: false, label: "Not configured", providerId }
}

export function pruneStrategiesForNames(names, base) {
	const updated = { ...base }
	for (const name of names) delete updated[name]
	return updated
}

export async function persistComboStrategies(updated, setComboStrategies) {
	await fetch("/api/settings", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ comboStrategies: updated }),
	})
	setComboStrategies(updated)
}
