"use client"

import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical } from "lucide-react"
import { useState } from "react"
import Icon from "../../../../shared/components/Icon"
import { fmtK } from "./ComboHelpers.ts"

export function ModelItem({
	id,
	index,
	model,
	isFirst,
	isLast,
	context,
	onEdit,
	onMoveUp,
	onMoveDown,
	onRemove,
}) {
	const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id })
	const style = {
		transform: CSS.Transform.toString(transform),
		// no transition - prevents the CSS settle animation fighting React's re-render on drop
		opacity: isDragging ? 0.4 : 1,
		zIndex: isDragging ? 999 : undefined,
	}
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(model)
	const commit = () => {
		const trimmed = draft.trim()
		if (trimmed && trimmed !== model) onEdit(trimmed)
		else setDraft(model)
		setEditing(false)
	}

	const handleKeyDown = (e) => {
		if (e.key === "Enter") commit()
		if (e.key === "Escape") {
			setDraft(model)
			setEditing(false)
		}
	}

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={`group flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 bg-black/[0.02] hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04] transition-colors ${isDragging ? "shadow-md ring-1 ring-primary/30" : ""}`}
		>
			{/* Drag handle */}
			<button
				{...attributes}
				{...listeners}
				type="button"
				className="cursor-grab touch-none p-0.5 rounded text-text-muted hover:text-primary active:cursor-grabbing shrink-0"
				title="Drag to reorder"
			>
				<GripVertical size={16} className="fill-current" aria-hidden="true" />
			</button>

			{/* Index badge */}
			<span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">
				{index + 1}
			</span>

			{/* Inline editable model value */}
			{editing ? (
				<input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commit}
					onKeyDown={handleKeyDown}
					className="min-w-0 flex-1 rounded border border-primary/40 bg-white px-1.5 py-0.5 font-mono text-xs text-text-main outline-none dark:bg-black/20"
				/>
			) : (
				<div
					className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5"
					onClick={() => setEditing(true)}
					title="Click to edit"
				>
					{model}
				</div>
			)}

			{/* Priority arrows */}
			<div className="flex shrink-0 items-center gap-0.5">
				<span
					className="mr-1 shrink-0 rounded bg-black/[0.04] px-1 py-0.5 font-mono text-[10px] text-text-muted dark:bg-white/[0.04]"
					title={context ? `${Number(context).toLocaleString()} tokens` : "Context window unknown"}
				>
					{fmtK(context)}
				</span>
				<button
					onClick={onMoveUp}
					disabled={isFirst}
					className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
					title="Move up"
				>
					<Icon name="arrow_upward" size={12} />
				</button>
				<button
					onClick={onMoveDown}
					disabled={isLast}
					className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
					title="Move down"
				>
					<Icon name="arrow_downward" size={12} />
				</button>
			</div>

			{/* Remove */}
			<button
				onClick={onRemove}
				className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all"
				title="Remove"
			>
				<Icon name="close" size={12} />
			</button>
		</div>
	)
}
