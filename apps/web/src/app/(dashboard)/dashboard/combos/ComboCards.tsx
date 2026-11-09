"use client"

import type { CapacityAdapter, CapEntry, ComboStrategy } from "./ComboHelpers.ts"
import { fmtK, getRouterModelStatus, STRATEGY_OPTIONS } from "./ComboHelpers.ts"

export {
	CapacityAdapterCap,
	CapacityAdapterSection,
	ComboFormModal,
	ModelItem,
} from "./ComboForm.tsx"
export type { CapacityAdapter, CapEntry, ComboStrategy } from "./ComboHelpers.ts"
export { fmtK, getRouterModelStatus, STRATEGY_OPTIONS } from "./ComboHelpers.ts"

import Link from "next/link"
import { aggregateComboCapabilities } from "open-sse/providers/capabilities"
import { useState } from "react"
import {
	Badge,
	CapacityBadges,
	Card,
	Modal,
	ModelSelectModal,
	Select,
	SmartPolicyModal,
	smartPolicyModalKey,
} from "@/shared/components"
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers"
import Icon from "../../../../shared/components/Icon"
import { getPolicyBadgeLabel } from "./capacityAdapter.ts"

export function ComboCard({
	combo,
	getCaps,
	comboByName = {},
	activeProviders = [],
	copied,
	onCopy,
	onDuplicate,
	onEdit,
	onDelete,
	strategy = {} as ComboStrategy,
	onSetStrategy,
	selected = false,
	onToggleSelect,
}) {
	const [showJudgeSelect, setShowJudgeSelect] = useState(false)
	const [showRouterSelect, setShowRouterSelect] = useState(false)
	const [showPolicyModal, setShowPolicyModal] = useState(false)
	const current = strategy.fallbackStrategy || "fallback"
	const judge = strategy.judgeModel || ""
	const routerModel = strategy.routerModel || ""
	const isFusion = current === "fusion"
	const isSmart = current === "smart"
	const comboCaps = aggregateComboCapabilities(combo.models, comboByName, getCaps)

	return (
		<Card
			padding="sm"
			className={`group ${selected ? "ring-1 ring-primary/40 bg-primary/[0.03]" : ""}`}
		>
			<div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
					<label className="flex shrink-0 items-center pt-1 sm:pt-0 cursor-pointer" title="Select combo">
						<input
							type="checkbox"
							checked={selected}
							onChange={onToggleSelect}
							onClick={(e) => e.stopPropagation()}
							className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
							aria-label={`Select ${combo.name}`}
						/>
					</label>
					<div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
						<Icon name="layers" size={18} className="text-primary" />
					</div>
					<div className="min-w-0 flex-1">
						<code className="block truncate font-mono text-sm font-medium">{combo.name}</code>
						<div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
							{combo.models.length === 0 ? (
								<span className="text-xs text-text-muted italic">No models</span>
							) : (
								combo.models.slice(0, 3).map((model, index) => {
									const memberCaps = comboByName[model]
										? aggregateComboCapabilities(comboByName[model], comboByName, getCaps)
										: getCaps?.(model)
									return (
										<code
											key={index}
											className="inline-flex items-center gap-1 rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs text-text-muted dark:bg-white/5"
										>
											<span>{model}</span>
											<span
												className="opacity-70"
												title={`${Number(memberCaps?.contextWindow || 0).toLocaleString()} tokens`}
											>
												{fmtK(memberCaps?.contextWindow)}
											</span>
											<CapacityBadges caps={memberCaps} />
										</code>
									)
								})
							)}
							{combo.models.length > 3 && (
								<span className="text-[10px] text-text-muted">+{combo.models.length - 3} more</span>
							)}
						</div>
						{comboCaps && (
							<div className="mt-1 flex items-center gap-2 text-[10px] text-text-muted">
								<span title="Context window: the largest member model, or the custom value set on this combo">
									ctx {fmtK(comboCaps.contextWindow)}
								</span>
								<span className="opacity-40">·</span>
								<span>max {fmtK(comboCaps.maxOutput)}</span>
								{combo.contextWindow > 0 && (
									<span className="rounded bg-primary/10 px-1 py-0.5 text-[9px] font-medium text-primary">
										custom
									</span>
								)}
							</div>
						)}
						{/* Fusion: judge picker (Auto = first model) */}
						{isFusion && (
							<div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
								<span className="text-[11px] font-medium text-text-muted">Judge</span>
								<button
									onClick={() => setShowJudgeSelect(true)}
									className="inline-flex max-w-full items-center gap-1 rounded border border-dashed border-primary/40 px-1.5 py-0.5 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/5 transition-colors"
									title="Pick the model that fuses panel answers"
								>
									<Icon name="gavel" size={13} />
									<span className="truncate">{judge || `Auto - ${combo.models[0] || "first model"}`}</span>
								</button>
								{judge && (
									<button
										onClick={() => onSetStrategy({ judgeModel: "" })}
										className="p-0.5 rounded text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
										title="Reset judge to Auto"
									>
										<Icon name="close" size={13} />
									</button>
								)}
							</div>
						)}
						{/* Smart: System One router picker and policy modal trigger */}
						{isSmart &&
							(() => {
								const routerStatus = getRouterModelStatus(routerModel, activeProviders)
								const policyLabel = getPolicyBadgeLabel(strategy)
								return (
									<div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
										<span className="text-[11px] font-medium text-text-muted">Router</span>
										<button
											onClick={() => setShowRouterSelect(true)}
											className="inline-flex max-w-full items-center gap-1 rounded border border-dashed border-primary/40 px-1.5 py-0.5 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/5 transition-colors"
											title="Pick the System One model that decides model routing"
										>
											<Icon name="psychology" size={13} />
											<span className="truncate">{routerModel || "Auto — oc/jev-1.13-free"}</span>
										</button>
										{routerStatus.ready ? (
											<Badge variant="success" size="sm" dot>
												{routerStatus.label}
											</Badge>
										) : (
											<span className="inline-flex items-center gap-1">
												<Badge variant="error" size="sm" dot>
													{routerStatus.label}
												</Badge>
												<Link
													href={`/dashboard/media-providers/systemone/${routerStatus.providerId}`}
													className="text-[10px] text-primary hover:underline font-medium"
													title="Configure in Media Providers"
												>
													Configure
												</Link>
											</span>
										)}
										<button
											onClick={() => setShowPolicyModal(true)}
											className="inline-flex items-center gap-1 rounded border border-border/70 bg-black/[0.02] dark:bg-white/[0.02] px-2 py-0.5 text-[11px] text-text-main hover:border-primary/50 hover:bg-primary/5 transition-colors"
											title="Configure routing policy and prompt cache retention"
										>
											<Icon name="tune" size={13} className="text-text-muted" />
											<span className="font-medium">{policyLabel}</span>
										</button>
										{routerModel && (
											<button
												onClick={() => onSetStrategy({ routerModel: "" })}
												className="p-0.5 rounded text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
												title="Reset router to Auto"
											>
												<Icon name="close" size={13} />
											</button>
										)}
									</div>
								)
							})()}
					</div>
				</div>

				{/* Actions */}
				<div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3 sm:shrink-0">
					{/* Strategy selector - always visible */}
					<div className="w-full sm:w-[200px]">
						<Select
							options={STRATEGY_OPTIONS}
							value={current}
							onChange={(e) => onSetStrategy({ fallbackStrategy: e.target.value })}
							selectClassName="py-1.5 text-xs"
						/>
					</div>

					<div className="grid grid-cols-4 gap-1 sm:flex">
						<button
							onClick={(e) => {
								e.stopPropagation()
								onCopy(combo.name, `combo-${combo.id}`)
							}}
							className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
							title="Copy combo name"
						>
							<Icon name={copied === `combo-${combo.id}` ? "check" : "content_copy"} size={18} />
							<span className="text-[10px] leading-tight">Copy</span>
						</button>
						<button
							onClick={(e) => {
								e.stopPropagation()
								onDuplicate()
							}}
							className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
							title={`Copy full combo (same models and strategy) as ${combo.name}-1`}
						>
							<Icon name="library_add" size={18} />
							<span className="text-[10px] leading-tight">Copy Full</span>
						</button>
						<button
							onClick={onEdit}
							className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
							title="Edit"
						>
							<Icon name="edit" size={18} />
							<span className="text-[10px] leading-tight">Edit</span>
						</button>
						<button
							onClick={onDelete}
							className="flex flex-col items-center rounded px-2 py-1 text-red-500 transition-colors hover:bg-red-500/10"
							title="Delete"
						>
							<Icon name="delete" size={18} />
							<span className="text-[10px] leading-tight">Delete</span>
						</button>
					</div>
				</div>
			</div>

			{/* Judge model picker (single-select; combo members make natural judges too) */}
			{showJudgeSelect && (
				<ModelSelectModal
					isOpen={showJudgeSelect}
					onClose={() => setShowJudgeSelect(false)}
					onSelect={(m) => {
						onSetStrategy({ judgeModel: m?.value || "" })
						setShowJudgeSelect(false)
					}}
					activeProviders={activeProviders}
					title="Select Judge Model"
					addedModelValues={judge ? [judge] : []}
					closeOnSelect={true}
				/>
			)}

			{/* System One Router model picker (single-select from systemone kind) */}
			{showRouterSelect && (
				<ModelSelectModal
					isOpen={showRouterSelect}
					onClose={() => setShowRouterSelect(false)}
					onSelect={(m) => {
						onSetStrategy({ routerModel: m?.value || "" })
						setShowRouterSelect(false)
					}}
					activeProviders={activeProviders}
					title="Select System One Router Model"
					kindFilter="systemone"
					addedModelValues={routerModel ? [routerModel] : []}
					closeOnSelect={true}
				/>
			)}

			{/* Smart Router Policy Settings Modal */}
			{showPolicyModal && (
				<SmartPolicyModal
					key={smartPolicyModalKey(showPolicyModal, combo.name)}
					isOpen={showPolicyModal}
					onClose={() => setShowPolicyModal(false)}
					comboName={combo.name}
					currentPolicy={
						strategy.smartPolicy || (strategy.sessionSticky === false ? "per-turn" : "smart")
					}
					currentThreshold={strategy.confidenceThreshold ?? 80}
					onSave={onSetStrategy}
				/>
			)}
		</Card>
	)
}
