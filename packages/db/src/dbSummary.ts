/**
 * Database summary.
 *
 * Extracted verbatim from index.ts.
 */

import { exportDb } from "./dbExport.ts"

export async function getDbSummary() {
	const sectionMeta: Record<
		string,
		{ label: string; keys: string[]; default: boolean; isHeavy: boolean }
	> = {
		settings: {
			label: "Settings & System Config",
			keys: ["settings"],
			default: true,
			isHeavy: false,
		},
		providers: {
			label: "Provider Connections & Custom Nodes",
			keys: ["providerConnections", "providerNodes", "proxyPools"],
			default: true,
			isHeavy: false,
		},
		apiKeys: { label: "API Keys & Quota Limits", keys: ["apiKeys"], default: true, isHeavy: false },
		combos: { label: "Combos & Custom Routing", keys: ["combos"], default: true, isHeavy: false },
		customModels: {
			label: "Custom Models & Aliases",
			keys: ["customModels", "modelAliases", "mitmAlias"],
			default: true,
			isHeavy: false,
		},
		pricing: {
			label: "Pricing & Model Overrides",
			keys: ["pricing", "modelOverrides", "disabledModels"],
			default: true,
			isHeavy: false,
		},
		usage: {
			label: "Usage History & Logs",
			keys: ["usageHistory", "usageDaily"],
			default: false,
			isHeavy: true,
		},
	}

	const sections: Record<
		string,
		{ key: string; label: string; bytes: number; count: number; default: boolean; isHeavy: boolean }
	> = {}
	let totalBytes = 0

	for (const [secKey, meta] of Object.entries(sectionMeta)) {
		const data = await exportDb([secKey])
		const jsonStr = JSON.stringify(data)
		const bytes = Buffer.byteLength(jsonStr, "utf8")

		let count = 0
		for (const k of meta.keys) {
			const val = data[k]
			if (Array.isArray(val)) count += val.length
			else if (val && typeof val === "object") count += Object.keys(val).length
		}

		sections[secKey] = {
			key: secKey,
			label: meta.label,
			bytes,
			count,
			default: meta.default,
			isHeavy: meta.isHeavy,
		}
		totalBytes += bytes
	}

	return { sections, totalBytes }
}
