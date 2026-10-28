"use client"

import type { ReactNode } from "react"
import Card from "./Card.tsx"

// Only show fields user actually cares about
type ProviderInfoValue = string | number | readonly string[]

interface FieldSchema {
	label: string
	format: (v: ProviderInfoValue) => ReactNode
	isLink?: boolean
	mono?: boolean
}

function formatCurrency(value: ProviderInfoValue): ReactNode {
	if (typeof value !== "number") return value
	return value === 0 ? "Free" : `$${value.toFixed(4)}`
}

function formatQuota(value: ProviderInfoValue): ReactNode {
	if (typeof value !== "number") return value
	return value === 0 ? "n/a" : value >= 999999 ? "Unlimited" : `${value.toLocaleString()} / mo`
}

function formatList(value: ProviderInfoValue): ReactNode {
	return Array.isArray(value) ? value.join(", ") : value
}

function formatNumber(value: ProviderInfoValue): ReactNode {
	return typeof value === "number" ? value.toLocaleString() : value
}

const FIELD_SCHEMA: Record<string, FieldSchema> = {
	mode: { label: "Mode", format: (v) => v },
	defaultModel: { label: "Model", format: (v) => v, mono: true },
	baseUrl: { label: "Endpoint", format: (v) => v, isLink: true, mono: true },
	costPerQuery: { label: "Cost / call", format: formatCurrency },
	pricingUrl: { label: "Pricing", format: () => "View pricing", isLink: true },
	freeTier: { label: "Free tier", format: (v) => v },
	freeMonthlyQuota: { label: "Free quota", format: formatQuota },
	searchTypes: { label: "Types", format: formatList },
	formats: { label: "Formats", format: formatList },
	maxMaxResults: { label: "Max results", format: (v) => v },
	maxCharacters: { label: "Max chars", format: formatNumber },
}

export default function ProviderInfoCard({ config, provider, title = "Provider Info" }) {
	if (!config) return null

	const rows = Object.entries(FIELD_SCHEMA)
		.filter(([key]) => config[key] !== undefined && config[key] !== null && config[key] !== "")
		.map(([key, schema]) => ({
			key,
			label: schema.label,
			value: schema.format(config[key]) as string | number,
			isLink: schema.isLink,
			mono: schema.mono,
			raw: config[key],
		}))

	const signupUrl = provider?.notice?.apiKeyUrl || provider?.website
	const noticeText = provider?.notice?.text

	return (
		<Card>
			<div className="flex items-center justify-between mb-3">
				<h2 className="text-lg font-semibold">{title}</h2>
				{signupUrl && (
					<a
						href={signupUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="text-xs text-primary hover:underline inline-flex items-center gap-1"
					>
						<span className="material-symbols-outlined text-sm">open_in_new</span>
						Get API Key
					</a>
				)}
			</div>
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
				{rows.map((r) => (
					<div key={r.key} className="flex items-center gap-3 min-w-0">
						<span className="text-xs text-text-muted w-28 shrink-0">{r.label}</span>
						{r.isLink ? (
							<a
								href={r.raw}
								target="_blank"
								rel="noopener noreferrer"
								className={`text-sm text-primary hover:underline truncate ${r.mono ? "font-mono" : ""}`}
							>
								{r.value}
							</a>
						) : (
							<span className={`text-sm text-text-main truncate ${r.mono ? "font-mono" : ""}`}>
								{r.value}
							</span>
						)}
					</div>
				))}
				{noticeText && (
					<div className="flex items-start gap-3 min-w-0 sm:col-span-2">
						<span className="text-xs text-text-muted w-28 shrink-0 mt-0.5">Notice</span>
						<span className="text-sm text-text-main leading-relaxed">{noticeText}</span>
					</div>
				)}
			</div>
		</Card>
	)
}
