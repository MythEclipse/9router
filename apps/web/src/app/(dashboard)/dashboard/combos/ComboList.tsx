"use client"

import { Button, Card, Select } from "@/shared/components"
import Icon from "../../../../shared/components/Icon"
import { ComboCard } from "./ComboCards.tsx"
import { STRATEGY_OPTIONS } from "./ComboHelpers.ts"

export function ComboList(props) {
	const {
		combos,
		filteredCombos,
		normalizedQuery,
		searchQuery,
		setSearchQuery,
		setShowCreateModal,
		someSelected,
		selectedIds,
		bulkBusy,
		handleBulkSetStrategy,
		handleBulkDelete,
		clearSelection,
		getCaps,
		activeProviders,
		copied,
		copy,
		handleDuplicate,
		setEditingCombo,
		handleDelete,
		comboStrategies,
		handleSetComboStrategy,
		toggleSelect,
	} = props
	{
		/* Combos List */
	}
	combos.length === 0 ? (
		<Card>
			<div className="text-center py-12">
				<div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
					<Icon name="layers" size={32} />
				</div>
				<p className="text-text-main font-medium mb-1">No combos yet</p>
				<p className="text-sm text-text-muted mb-4">Create model combos with fallback support</p>
				<Button icon="add" onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto">
					Create Combo
				</Button>
			</div>
		</Card>
	) : (
		<div className="flex flex-col gap-3">
			{/* Search match counter */}
			{normalizedQuery && (
				<span className="text-xs text-text-muted select-none">
					{filteredCombos.length} of {combos.length} shown
				</span>
			)}
			{/* Selection toolbar */}
			{someSelected && (
				<div className="flex min-w-0 flex-col gap-2 rounded-lg border border-black/5 bg-black/[0.015] px-3 py-2 dark:border-white/5 dark:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between">
					<span className="text-xs text-text-muted select-none">{selectedIds.length} selected</span>

					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<div className="w-full min-w-[160px] sm:w-[200px]">
							<Select
								options={STRATEGY_OPTIONS}
								value=""
								placeholder="Set strategy…"
								disabled={bulkBusy}
								onChange={(e) => {
									const v = e.target.value
									if (v) handleBulkSetStrategy(v)
								}}
								selectClassName="py-1.5 text-xs"
							/>
						</div>
						<Button
							size="sm"
							variant="danger"
							icon="delete"
							disabled={bulkBusy}
							loading={bulkBusy}
							onClick={handleBulkDelete}
							className="whitespace-nowrap"
						>
							Delete ({selectedIds.length})
						</Button>
						<Button size="sm" variant="ghost" onClick={clearSelection} disabled={bulkBusy}>
							Clear
						</Button>
					</div>
				</div>
			)}

			<div className="flex flex-col gap-3">
				{(() => {
					const comboByName = Object.fromEntries(combos.map((c) => [c.name, c.models]))
					if (filteredCombos.length === 0) {
						return (
							<Card>
								<div className="text-center py-10">
									<p className="text-text-main font-medium mb-1">
										No combos match &ldquo;{searchQuery.trim()}&rdquo;
									</p>
									<p className="text-sm text-text-muted mb-4">
										Try a shorter query, or clear the search to see all {combos.length} combos.
									</p>
									<Button variant="secondary" onClick={() => setSearchQuery("")}>
										Clear search
									</Button>
								</div>
							</Card>
						)
					}
					return filteredCombos.map((combo) => (
						<ComboCard
							key={combo.id}
							combo={combo}
							getCaps={getCaps}
							comboByName={comboByName}
							activeProviders={activeProviders}
							copied={copied}
							onCopy={copy}
							onDuplicate={() => handleDuplicate(combo)}
							onEdit={() => setEditingCombo(combo)}
							onDelete={() => handleDelete(combo.id)}
							strategy={comboStrategies[combo.name] || {}}
							onSetStrategy={(patch) => handleSetComboStrategy(combo.name, patch)}
							selected={selectedIds.includes(combo.id)}
							onToggleSelect={() => toggleSelect(combo.id)}
						/>
					))
				})()}
			</div>
		</div>
	)
}
