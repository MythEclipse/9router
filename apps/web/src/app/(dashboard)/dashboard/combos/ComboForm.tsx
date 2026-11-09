"use client"

export { ComboFormModal, ModelItem } from "./ComboFormModal.tsx"

import { useState } from "react"
import { Button, CapacityBadges, Card, ModelSelectModal, Toggle } from "@/shared/components"
import Icon from "../../../../shared/components/Icon"
import {
	addCapModel,
	CAPACITY_ADAPTER_CAPS,
	DEFAULT_FALLBACK_MODEL,
	EMPTY_CAP_ENTRY,
	moveCapModel,
	removeCapModel,
	removeCapModelAt,
} from "./capacityAdapter.ts"

export function CapacityAdapterSection({ capacityAdapter, onChange, activeProviders, getCaps }) {
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="min-w-0">
					<p className="text-sm font-medium">Vision Adapter</p>
					<p className="text-xs text-text-muted mt-0.5">
						Auto-switches to a pool model when yours cannot read image/audio.
					</p>
				</div>
			</div>
			<div className="flex flex-col gap-4">
				{CAPACITY_ADAPTER_CAPS.map((cap) => (
					<CapacityAdapterCap
						key={cap.key}
						cap={cap}
						entry={capacityAdapter[cap.key] || EMPTY_CAP_ENTRY}
						onChange={(entry) => onChange({ ...capacityAdapter, [cap.key]: entry })}
						activeProviders={activeProviders}
						getCaps={getCaps}
					/>
				))}
			</div>
		</div>
	)
}

export function CapacityAdapterCap({ cap, entry, onChange, activeProviders, getCaps }) {
	const [showModelSelect, setShowModelSelect] = useState(false)
	const { enabled, roundRobin, models } = entry

	const patch = (p) => onChange({ ...entry, ...p })

	const handleAdd = (model) => {
		patch({ models: addCapModel(models, model) })
	}

	const handleDeselect = (model) => {
		patch({ models: removeCapModel(models, model) })
	}

	const handleRemove = (index) => {
		patch({ models: removeCapModelAt(models, index) })
	}

	const handleMove = (index, delta) => {
		patch({ models: moveCapModel(models, index, delta) })
	}

	return (
		<Card padding="sm" className={`group ${!enabled ? "opacity-50" : ""}`}>
			<div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				{/* Master toggle + icon + label */}
				<div className="flex min-w-0 flex-1 items-start gap-2.5 sm:items-center">
					<Toggle
						checked={enabled}
						onChange={(v) => patch({ enabled: v })}
						aria-label={`Enable ${cap.label} adapter`}
					/>
					<div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
						<Icon name={cap.icon} size={18} className="text-primary" />
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5">
							<code className="font-mono text-sm font-medium">{cap.label}</code>
							<span className="text-[10px] text-text-muted">- {cap.desc}</span>
						</div>
					</div>
				</div>

				{/* Actions: Round-robin toggle + Add Model */}
				<div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3 sm:shrink-0">
					<label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none">
						<Toggle
							checked={roundRobin}
							onChange={(v) => patch({ roundRobin: v })}
							disabled={!enabled}
							aria-label={`Round-robin ${cap.label} adapter`}
						/>
						<span>Round</span>
					</label>
					<Button
						icon="add"
						variant="ghost"
						size="sm"
						onClick={() => setShowModelSelect(true)}
						disabled={!enabled}
						title={`Add ${cap.label} model`}
					>
						Add Model
					</Button>
				</div>
			</div>

			{/* Model pool list/table */}
			{models.length === 0 ? (
				<div className="mt-3 py-2 text-center text-xs text-text-muted italic">
					No models in pool (will fallback to {DEFAULT_FALLBACK_MODEL})
				</div>
			) : (
				<div className="mt-3 overflow-hidden rounded-lg border border-border/50">
					<table className="w-full text-left text-xs">
						<thead>
							<tr className="border-b border-border/40 bg-black/[0.02] text-text-muted dark:bg-white/[0.02]">
								<th className="w-12 px-3 py-1.5 font-medium text-center">#</th>
								<th className="px-3 py-1.5 font-medium">Model</th>
								<th className="w-24 px-3 py-1.5 font-medium text-center">Order</th>
								<th className="w-12 px-3 py-1.5 font-medium text-right"></th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border/30 font-mono">
							{models.map((model, index) => (
								<tr
									key={`${model}-${index}`}
									className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
								>
									<td className="px-3 py-2 text-center text-text-muted text-[11px] font-sans">
										#{index + 1}
									</td>
									<td className="px-3 py-2 text-text-main">
										<div className="flex items-center gap-1.5 flex-wrap">
											<span className="truncate">{model}</span>
											<CapacityBadges caps={getCaps?.(model)} />
											{model === DEFAULT_FALLBACK_MODEL && (
												<span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-sans text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
													free default
												</span>
											)}
										</div>
									</td>
									<td className="px-3 py-2 text-center">
										<div className="inline-flex items-center gap-1">
											<button
												type="button"
												onClick={() => handleMove(index, -1)}
												disabled={!enabled || index === 0}
												className={`p-1 rounded transition-colors ${
													!enabled || index === 0
														? "text-text-muted/20 cursor-not-allowed"
														: "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"
												}`}
												title="Move up"
											>
												<Icon name="arrow_upward" size={16} className="leading-none" />
											</button>
											<button
												type="button"
												onClick={() => handleMove(index, 1)}
												disabled={!enabled || index === models.length - 1}
												className={`p-1 rounded transition-colors ${
													!enabled || index === models.length - 1
														? "text-text-muted/20 cursor-not-allowed"
														: "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"
												}`}
												title="Move down"
											>
												<Icon name="arrow_downward" size={16} className="leading-none" />
											</button>
										</div>
									</td>
									<td className="px-3 py-2 text-right">
										<button
											type="button"
											onClick={() => handleRemove(index)}
											disabled={!enabled}
											className={`p-1 rounded transition-colors ${
												!enabled
													? "text-text-muted/20 cursor-not-allowed"
													: "text-text-muted hover:text-red-500 hover:bg-red-500/10"
											}`}
											title="Remove model"
										>
											<Icon name="close" size={16} className="leading-none" />
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{showModelSelect && (
				<ModelSelectModal
					isOpen={showModelSelect}
					onClose={() => setShowModelSelect(false)}
					onSelect={handleAdd}
					onDeselect={handleDeselect}
					activeProviders={activeProviders}
					title={`Add ${cap.label} Model`}
					addedModelValues={models}
					capFilter={cap.key}
					closeOnSelect={false}
				/>
			)}
		</Card>
	)
}
