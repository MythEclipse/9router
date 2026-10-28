"use client"

import { getDefaultPricing } from "open-sse/providers/pricing"
import { useEffect, useMemo, useState } from "react"

/** `provider -> model -> rate field -> cost per 1M tokens` */
type PricingData = Record<string, Record<string, Record<string, number>>>

interface PricingModalProps {
	isOpen: boolean
	onClose(...args: unknown[]): unknown
	onSave?(...args: unknown[]): unknown
}

// The dialog's contents - the rates it loaded plus every edit in progress -
// belong to one opening, so the caller remounts it per open. That removes the
// need for an effect that wipes or re-reads state whenever `isOpen` flips.
export function pricingModalKey(isOpen: boolean): string {
	return `pricing-modal:${isOpen ? "open" : "closed"}`
}

export default function PricingModal({ isOpen, onClose, onSave }: PricingModalProps) {
	// `loadedPricing` is what the API returned; `editedPricing` holds only the
	// cells the operator changed. The table renders the two merged, so `loading`
	// is simply "opened, nothing loaded yet" and saving sends the same merge.
	const [loadedPricing, setLoadedPricing] = useState<PricingData | null>(null)
	const [editedPricing, setEditedPricing] = useState<PricingData>({})
	const [saving, setSaving] = useState(false)

	const fetchPricing = (): Promise<PricingData> =>
		fetch("/api/pricing")
			.then((response) => {
				if (!response.ok) return getDefaultPricing()
				return response.json()
			})
			.catch((error) => {
				console.error("Failed to load pricing:", error)
				return getDefaultPricing()
			})

	// The rates are fetched once per opening, straight into the request callback.
	useEffect(() => {
		if (!isOpen) return undefined
		let cancelled = false
		fetchPricing().then((data) => {
			if (!cancelled) setLoadedPricing(data)
		})
		return () => {
			cancelled = true
		}
	}, [isOpen])

	// A cell appears here the moment it is edited, so the loaded rates never have
	// to be copied wholesale just to apply one keystroke.
	const pricingData = useMemo(() => {
		if (!editedPricing) return loadedPricing || {}
		const merged: PricingData = {}
		for (const [provider, models] of Object.entries(loadedPricing || {})) {
			merged[provider] = { ...models }
		}
		for (const [provider, models] of Object.entries(editedPricing)) {
			merged[provider] = { ...(merged[provider] || {}), ...models }
		}
		return merged
	}, [loadedPricing, editedPricing])

	const loading = isOpen && !loadedPricing

	const handlePricingChange = (provider: string, model: string, field: string, value: string) => {
		const numValue = parseFloat(value)
		if (Number.isNaN(numValue) || numValue < 0) return

		setEditedPricing((prev) => ({
			...prev,
			[provider]: {
				...(prev[provider] || {}),
				[model]: { ...((prev[provider] || {})[model] || {}), [field]: numValue },
			},
		}))
	}

	const handleSave = async () => {
		setSaving(true)
		try {
			const response = await fetch("/api/pricing", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(pricingData),
			})

			if (response.ok) {
				onSave?.()
				onClose()
			} else {
				const error = await response.json()
				alert(`Failed to save pricing: ${error.error}`)
			}
		} catch (error) {
			console.error("Failed to save pricing:", error)
			alert("Failed to save pricing")
		} finally {
			setSaving(false)
		}
	}

	const handleReset = async () => {
		if (!confirm("Reset all pricing to defaults? This cannot be undone.")) return

		try {
			const response = await fetch("/api/pricing", { method: "DELETE" })
			if (response.ok) {
				const defaults = getDefaultPricing()
				setLoadedPricing(defaults)
				// The reset replaces every cell, so pending edits would otherwise be
				// merged back on top of the defaults.
				setEditedPricing({})
			}
		} catch (error) {
			console.error("Failed to reset pricing:", error)
			alert("Failed to reset pricing")
		}
	}

	if (!isOpen) return null

	// Get all unique providers and models for display
	const allProviders = Object.keys(pricingData).sort()
	const pricingFields = ["input", "output", "cached", "reasoning", "cache_creation"]

	return (
		<div
			className="fixed inset-0 flex items-center justify-center z-50 p-4"
			style={{ backgroundColor: "var(--color-scrim)" }}
		>
			<div className="bg-bg-base border border-border rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
				{/* Header */}
				<div className="p-4 border-b border-border flex items-center justify-between">
					<h2 className="text-xl font-semibold">Pricing Configuration</h2>
					<button onClick={onClose} className="text-text-muted hover:text-text text-2xl leading-none">
						×
					</button>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-auto p-4">
					{loading ? (
						<div className="text-center py-8 text-text-muted">Loading pricing data...</div>
					) : (
						<div className="space-y-6">
							{/* Instructions */}
							<div className="bg-bg-subtle border border-border rounded-lg p-3 text-sm">
								<p className="font-medium mb-1">Pricing Rates Format</p>
								<p className="text-text-muted">
									All rates are in <strong>dollars per million tokens</strong> ($/1M tokens). Example: Input
									rate of 2.50 means $2.50 per 1,000,000 input tokens.
								</p>
							</div>

							{/* Pricing Tables */}
							{allProviders.map((provider) => {
								const models = Object.keys(pricingData[provider]).sort()
								return (
									<div key={provider} className="border border-border rounded-lg overflow-hidden">
										<div className="bg-bg-subtle px-4 py-2 font-semibold text-sm">
											{provider.toUpperCase()}
										</div>
										<div className="overflow-x-auto">
											<table className="w-full text-sm">
												<thead className="bg-bg-hover text-text-muted uppercase text-xs">
													<tr>
														<th className="px-3 py-2 text-left">Model</th>
														<th className="px-3 py-2 text-right">Input</th>
														<th className="px-3 py-2 text-right">Output</th>
														<th className="px-3 py-2 text-right">Cached</th>
														<th className="px-3 py-2 text-right">Reasoning</th>
														<th className="px-3 py-2 text-right">Cache Creation</th>
													</tr>
												</thead>
												<tbody className="divide-y divide-border">
													{models.map((model) => (
														<tr key={model} className="hover:bg-bg-subtle/50">
															<td className="px-3 py-2 font-medium">{model}</td>
															{pricingFields.map((field) => (
																<td key={field} className="px-3 py-2">
																	<input
																		type="number"
																		step="0.01"
																		min="0"
																		value={pricingData[provider][model][field] || 0}
																		onChange={(e) => handlePricingChange(provider, model, field, e.target.value)}
																		className="w-20 px-2 py-1 text-right bg-bg-base border border-border rounded focus:outline-none focus:border-primary"
																	/>
																</td>
															))}
														</tr>
													))}
												</tbody>
											</table>
										</div>
									</div>
								)
							})}

							{allProviders.length === 0 && (
								<div className="text-center py-8 text-text-muted">No pricing data available</div>
							)}
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="p-4 border-t border-border flex items-center justify-between gap-2">
					<button
						onClick={handleReset}
						className="px-4 py-2 text-sm text-red-500 hover:bg-red-500/10 rounded border border-red-500/20 transition-colors"
						disabled={saving}
					>
						Reset to Defaults
					</button>
					<div className="flex gap-2">
						<button
							onClick={onClose}
							className="px-4 py-2 text-sm text-text-muted hover:text-text border border-border rounded transition-colors"
							disabled={saving}
						>
							Cancel
						</button>
						<button
							onClick={handleSave}
							className="px-4 py-2 text-sm bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
							disabled={saving}
						>
							{saving ? "Saving..." : "Save Changes"}
						</button>
					</div>
				</div>
			</div>
		</div>
	)
}
