"use client"

import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import Card from "@/shared/components/Card"
import { TableScroll } from "@/shared/components/PageShell"
import { formatCostCents, formatCount } from "@/shared/utils/chartFormat"

const fmt = formatCount
const fmtCost = formatCostCents

/** One group produced by `groupDataByKey`: a key plus its rows. */
interface UsageGroup {
	groupKey: string
	items: UsageItem[]
	summary: UsageItem & {
		pending?: number
		provider?: string
		resolvedModel?: string
	}
}

/** One row of usage data, as aggregated by the usage API. */
interface UsageItem {
	key?: string
	promptTokens?: number
	cachedTokens?: number
	completionTokens?: number
	totalTokens?: number
	cost?: number
	inputCost?: number
	outputCost?: number
	cachedCost?: number
	totalCost?: number
}

function fmtTime(iso: string) {
	if (!iso) return "Never"
	const diffMins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
	if (diffMins < 1) return "Just now"
	if (diffMins < 60) return `${diffMins}m ago`
	if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`
	return new Date(iso).toLocaleDateString()
}

interface SortIconProps {
	field: string
	currentSort: string
	currentOrder: string
}

function SortIcon({ field, currentSort, currentOrder }: SortIconProps) {
	if (currentSort !== field) return <span className="ml-1 opacity-20">↕</span>
	return <span className="ml-1">{currentOrder === "asc" ? "↑" : "↓"}</span>
}

/**
 * Render 3 token or cost cells based on viewMode
 */
interface ValueCellsProps {
	item: UsageItem
	viewMode: string
	isSummary?: boolean
}

function ValueCells({ item, viewMode, isSummary = false }: ValueCellsProps) {
	if (viewMode === "tokens") {
		return (
			<>
				<td className="px-6 py-3 text-right text-text-muted">
					{isSummary && item.promptTokens === undefined ? "-" : fmt(item.promptTokens)}
				</td>
				<td className="px-6 py-3 text-right text-text-muted">
					{item.cachedTokens ? fmt(item.cachedTokens) : "-"}
				</td>
				<td className="px-6 py-3 text-right text-text-muted">
					{isSummary && item.completionTokens === undefined ? "-" : fmt(item.completionTokens)}
				</td>
				<td className="px-6 py-3 text-right font-medium">{fmt(item.totalTokens)}</td>
			</>
		)
	}
	return (
		<>
			<td className="px-6 py-3 text-right text-text-muted">
				{isSummary && item.inputCost === undefined ? "-" : fmtCost(item.inputCost)}
			</td>
			<td className="px-6 py-3 text-right text-text-muted">
				{item.cachedCost ? fmtCost(item.cachedCost) : "-"}
			</td>
			<td className="px-6 py-3 text-right text-text-muted">
				{isSummary && item.outputCost === undefined ? "-" : fmtCost(item.outputCost)}
			</td>
			<td className="px-6 py-3 text-right font-medium text-warning">
				{fmtCost(item.totalCost || item.cost)}
			</td>
		</>
	)
}

/**
 * Restore the persisted expanded-group set for one usage table. localStorage is
 * synchronous, so this can run during render; an unreadable value degrades to
 * "everything collapsed" rather than blocking the table.
 */
function readExpandedGroups(storageKey: string): Set<string> {
	try {
		const saved = localStorage.getItem(storageKey)
		if (saved) return new Set(JSON.parse(saved))
	} catch (e) {
		console.error(`Failed to load ${storageKey}:`, e)
	}
	return new Set()
}

/**
 * Reusable sortable usage table with expandable group rows.
 *
 * @param {object} props
 * @param {string} props.title - Table title
 * @param {Array} props.columns - Column definitions [{field, label}]
 * @param {Array} props.groupedData - Grouped data from groupDataByKey
 * @param {string} props.tableType - Table type key for sort URL params
 * @param {string} props.sortBy - Current sort field
 * @param {string} props.sortOrder - Current sort order
 * @param {function} props.onToggleSort - Sort toggle handler
 * @param {string} props.viewMode - "tokens" or "costs"
 * @param {string} props.storageKey - localStorage key for expanded state
 * @param {function} props.renderGroupLabel - Render group summary first cell content
 * @param {function} props.renderDetailCells - Render detail row custom cells (before value cells)
 * @param {function} props.renderSummaryCells - Render summary row cells after group label (placeholder cols)
 * @param {string} props.emptyMessage - Empty state message
 */
interface UsageTableProps {
	title: string
	columns: {
		field: string
		label: string
		align?: string
	}[]
	groupedData: UsageGroup[]
	tableType: string
	sortBy: string
	sortOrder: string
	onToggleSort(...args: unknown[]): unknown
	viewMode: string
	storageKey: string
	renderDetailCells(item: UsageItem): ReactNode
	renderSummaryCells(group: UsageGroup): ReactNode
	emptyMessage: string
}

export default function UsageTable({
	title,
	columns,
	groupedData,
	tableType,
	sortBy,
	sortOrder,
	onToggleSort,
	viewMode,
	storageKey,
	renderDetailCells,
	renderSummaryCells,
	emptyMessage,
}: UsageTableProps) {
	// Expanded groups are persisted per table, keyed by `storageKey`. The stored
	// set is read *during render* (localStorage is synchronous), so the first
	// paint already shows the restored groups - restoring it from an effect cost
	// an extra render and flashed every group collapsed.
	const [storedExpanded, setStoredExpanded] = useState(() => ({
		key: storageKey,
		groups: readExpandedGroups(storageKey),
	}))
	// A new table identity invalidates the cached set immediately during render,
	// instead of waiting for an effect to re-apply it one paint later.
	if (storedExpanded.key !== storageKey) {
		setStoredExpanded({ key: storageKey, groups: readExpandedGroups(storageKey) })
	}

	// Keys toggled since the last commit; persisted by the effect below.
	const [toggledGroups, setToggledGroups] = useState(() => new Set<string>())
	const expanded = useMemo(() => {
		if (toggledGroups.size === 0) return storedExpanded.groups
		const next = new Set(storedExpanded.groups)
		for (const groupKey of toggledGroups) {
			if (!next.delete(groupKey)) next.add(groupKey)
		}
		return next
	}, [storedExpanded, toggledGroups])

	// Save expanded state to localStorage. Only the groups toggled by the user
	// are flushed, so a fresh mount never rewrites the stored set with itself.
	useEffect(() => {
		if (toggledGroups.size === 0) return
		try {
			localStorage.setItem(storageKey, JSON.stringify([...expanded]))
		} catch (e) {
			console.error(`Failed to save ${storageKey}:`, e)
		}
	}, [expanded, storageKey, toggledGroups])

	const toggleGroup = useCallback((groupKey) => {
		setToggledGroups((prev) => {
			const next = new Set(prev)
			next.has(groupKey) ? next.delete(groupKey) : next.add(groupKey)
			return next
		})
	}, [])

	const valueColumns = useMemo(() => {
		if (viewMode === "tokens") {
			return [
				{ field: "promptTokens", label: "Input Tokens" },
				{ field: "cachedTokens", label: "Cached" },
				{ field: "completionTokens", label: "Output Tokens" },
				{ field: "totalTokens", label: "Total Tokens" },
			]
		}
		return [
			{ field: "promptTokens", label: "Input Cost" },
			{ field: "cachedCost", label: "Cached Cost" },
			{ field: "completionTokens", label: "Output Cost" },
			{ field: "cost", label: "Total Cost" },
		]
	}, [viewMode])

	const totalColSpan = columns.length + valueColumns.length

	return (
		<Card className="overflow-hidden">
			<div className="p-4 border-b border-border bg-bg-alt/50">
				<h3 className="font-semibold">{title}</h3>
			</div>
			<TableScroll minWidth="min-w-[720px]">
				<table className="w-full text-sm text-left">
					<thead className="bg-bg-alt/30 text-text-muted uppercase text-xs">
						<tr>
							{columns.map((col) => (
								<th
									key={col.field}
									className={`px-6 py-3 cursor-pointer hover:bg-bg-alt/50 ${col.align === "right" ? "text-right" : ""}`}
									onClick={() => onToggleSort(tableType, col.field)}
								>
									{col.label} <SortIcon field={col.field} currentSort={sortBy} currentOrder={sortOrder} />
								</th>
							))}
							{valueColumns.map((col) => (
								<th
									key={col.field}
									className="px-6 py-3 text-right cursor-pointer hover:bg-bg-alt/50"
									onClick={() => onToggleSort(tableType, col.field)}
								>
									{col.label} <SortIcon field={col.field} currentSort={sortBy} currentOrder={sortOrder} />
								</th>
							))}
						</tr>
					</thead>
					<tbody className="divide-y divide-border">
						{groupedData.map((group) => (
							<Fragment key={group.groupKey}>
								{/* Group summary row */}
								<tr
									className="group-summary cursor-pointer hover:bg-bg-alt/50 transition-colors"
									onClick={() => toggleGroup(group.groupKey)}
								>
									<td className="px-6 py-3">
										<div className="flex items-center gap-2">
											<span
												className={`material-symbols-outlined text-[18px] text-text-muted transition-transform ${expanded.has(group.groupKey) ? "rotate-90" : ""}`}
											>
												chevron_right
											</span>
											<span
												className={`font-medium transition-colors ${group.summary.pending > 0 ? "text-primary" : ""}`}
											>
												{group.summary.resolvedModel && group.summary.resolvedModel !== group.groupKey ? (
													<>
														<span className="block truncate" title={group.groupKey}>
															{group.groupKey}
														</span>
														<span
															className="block truncate text-xs font-normal text-text-muted"
															title={`${group.summary.provider}/${group.summary.resolvedModel}`}
														>
															→ {group.summary.provider}/{group.summary.resolvedModel}
														</span>
													</>
												) : (
													group.groupKey
												)}
											</span>
										</div>
									</td>
									{renderSummaryCells(group)}
									<ValueCells item={group.summary} viewMode={viewMode} isSummary />
								</tr>
								{/* Detail rows */}
								{expanded.has(group.groupKey) &&
									group.items.map((item) => (
										<tr
											key={`detail-${item.key}`}
											className="group-detail hover:bg-bg-alt/20 transition-colors"
										>
											{renderDetailCells(item)}
											<ValueCells item={item} viewMode={viewMode} />
										</tr>
									))}
							</Fragment>
						))}
						{groupedData.length === 0 && (
							<tr>
								<td colSpan={totalColSpan} className="px-6 py-8 text-center text-text-muted">
									{emptyMessage}
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</TableScroll>
		</Card>
	)
}

// Re-export utilities for use in UsageStats orchestrator
export { fmt, fmtCost, fmtTime }
