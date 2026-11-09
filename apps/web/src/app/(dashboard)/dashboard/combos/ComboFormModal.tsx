"use client"

import { fmtK } from "./ComboHelpers.ts"
import { ModelItem } from "./ModelItem.tsx"

export const VALID_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/
export { ModelItem } from "./ModelItem.tsx"

import {
	closestCenter,
	DndContext,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core"
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers"
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical } from "lucide-react"
import { useEffect, useState } from "react"
import { Button, Input, Modal, ModelSelectModal, Select } from "@/shared/components"
import Icon from "../../../../shared/components/Icon"

export function ComboFormModal({
	isOpen,
	combo,
	onClose,
	onSave,
	activeProviders,
	kindFilter = null,
	getCaps = null,
}) {
	// Initialize state with combo values - key prop on parent handles reset on remount
	const [name, setName] = useState(combo?.name || "")
	const [models, setModels] = useState(combo?.models || [])
	const [showModelSelect, setShowModelSelect] = useState(false)
	const [saving, setSaving] = useState(false)
	const [nameError, setNameError] = useState("")
	const [modelAliases, setModelAliases] = useState({})
	// 0 keeps the window on auto: the combo reports the largest member.
	const [contextMode, setContextMode] = useState(combo?.contextWindow > 0 ? "custom" : "auto")
	const [contextInput, setContextInput] = useState(
		combo?.contextWindow > 0 ? String(combo.contextWindow) : "",
	)

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	)

	// Use stable index-based IDs so duplicates and similar names are handled correctly
	const modelItems = models.map((model, i) => ({ uid: `item-${i}`, model }))

	const handleDragEnd = (event) => {
		const { active, over } = event
		if (over && active.id !== over.id) {
			const oldIndex = modelItems.findIndex((m) => m.uid === active.id)
			const newIndex = modelItems.findIndex((m) => m.uid === over.id)
			if (oldIndex !== -1 && newIndex !== -1) {
				setModels((prev) => arrayMove(prev, oldIndex, newIndex))
			}
		}
	}

	const fetchModalData = async () => {
		try {
			const aliasesRes = await fetch("/api/models/alias")
			if (!aliasesRes.ok) return
			const aliasesData = await aliasesRes.json()
			setModelAliases(aliasesData.aliases || {})
		} catch (error) {
			console.error("Error fetching modal data:", error)
		}
	}

	useEffect(() => {
		// Alias map for the model picker. `fetchModalData` only sets state from its
		// awaited response, so opening the dialog never renders before it lands.
		function subscribe() {
			if (!isOpen) return () => {}
			void fetchModalData()
			return () => {}
		}
		return subscribe()
	}, [isOpen])

	const validateName = (value) => {
		if (!value.trim()) {
			setNameError("Name is required")
			return false
		}
		if (!VALID_NAME_REGEX.test(value)) {
			setNameError("Only letters, numbers, -, _ and . allowed")
			return false
		}
		setNameError("")
		return true
	}

	const handleNameChange = (e) => {
		const value = e.target.value
		setName(value)
		if (value) validateName(value)
		else setNameError("")
	}

	const handleAddModel = (model) => {
		if (!models.includes(model.value)) {
			setModels([...models, model.value])
		}
	}

	const handleDeselectModel = (model) => {
		setModels(models.filter((m) => m !== model.value))
	}

	const handleRemoveModel = (index) => {
		setModels(models.filter((_, i) => i !== index))
	}

	const handleMoveUp = (index) => {
		if (index === 0) return
		const newModels = [...models]
		;[newModels[index - 1], newModels[index]] = [newModels[index], newModels[index - 1]]
		setModels(newModels)
	}

	const handleMoveDown = (index) => {
		if (index === models.length - 1) return
		const newModels = [...models]
		;[newModels[index], newModels[index + 1]] = [newModels[index + 1], newModels[index]]
		setModels(newModels)
	}

	const handleSave = async () => {
		if (!validateName(name)) return
		setSaving(true)
		const customContext = Math.floor(Number(contextInput))
		await onSave({
			name: name.trim(),
			models,
			contextWindow:
				contextMode === "custom" && Number.isFinite(customContext) && customContext > 0
					? customContext
					: 0,
		})
		setSaving(false)
	}

	// What the combo publishes when left on auto.
	const autoContext = models.reduce((largest, m) => {
		const value = getCaps?.(m)?.contextWindow
		return Number.isFinite(value) && value > largest ? value : largest
	}, 0)

	const isEdit = !!combo

	return (
		<>
			<Modal isOpen={isOpen} onClose={onClose} title={isEdit ? "Edit Combo" : "Create Combo"}>
				<div className="flex flex-col gap-3">
					{/* Name */}
					<div>
						<Input
							label="Combo Name"
							value={name}
							onChange={handleNameChange}
							placeholder="my-combo"
							error={nameError}
						/>
						<p className="text-[10px] text-text-muted mt-0.5">
							Only letters, numbers, -, _ and . allowed
						</p>
					</div>

					{/* Models */}
					<div>
						<label className="text-sm font-medium mb-1.5 block">Models</label>

						{models.length === 0 ? (
							<div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
								<Icon name="layers" size={20} className="text-text-muted mb-1" />
								<p className="text-xs text-text-muted">No models added yet</p>
							</div>
						) : (
							<DndContext
								sensors={sensors}
								collisionDetection={closestCenter}
								onDragEnd={handleDragEnd}
								modifiers={[restrictToVerticalAxis, restrictToParentElement]}
							>
								<SortableContext
									items={modelItems.map((m) => m.uid)}
									strategy={verticalListSortingStrategy}
								>
									<div className="flex max-h-[55vh] min-w-0 flex-col gap-1 overflow-y-auto sm:max-h-[350px]">
										{modelItems.map(({ uid, model }, index) => (
											<ModelItem
												key={uid}
												id={uid}
												index={index}
												model={model}
												isFirst={index === 0}
												isLast={index === modelItems.length - 1}
												context={getCaps?.(model)?.contextWindow}
												onEdit={(newVal) => {
													const updated = [...models]
													updated[index] = newVal
													setModels(updated)
												}}
												onMoveUp={() => handleMoveUp(index)}
												onMoveDown={() => handleMoveDown(index)}
												onRemove={() => handleRemoveModel(index)}
											/>
										))}
									</div>
								</SortableContext>
							</DndContext>
						)}

						{/* Add Model button */}
						<button
							onClick={() => setShowModelSelect(true)}
							className="w-full mt-2 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
						>
							<Icon name="add" size={16} />
							Add Model
						</button>
					</div>

					{/* Context window */}
					<div>
						<label className="text-sm font-medium mb-1.5 block">Context Window</label>
						<div className="flex rounded-lg border border-black/10 bg-black/[0.02] p-1 dark:border-white/10 dark:bg-white/[0.02]">
							<button
								type="button"
								onClick={() => setContextMode("auto")}
								className={`flex-1 rounded-md py-1 text-xs font-medium transition-colors ${contextMode === "auto" ? "bg-primary text-white shadow-xs" : "text-text-muted hover:text-text-main"}`}
							>
								Auto
							</button>
							<button
								type="button"
								onClick={() => setContextMode("custom")}
								className={`flex-1 rounded-md py-1 text-xs font-medium transition-colors ${contextMode === "custom" ? "bg-primary text-white shadow-xs" : "text-text-muted hover:text-text-main"}`}
							>
								Custom
							</button>
						</div>
						{contextMode === "auto" ? (
							<p className="text-[10px] text-text-muted mt-1">
								Follows the largest member, currently {fmtK(autoContext)} ({autoContext.toLocaleString()}{" "}
								tokens).
							</p>
						) : (
							<>
								<input
									value={contextInput}
									onChange={(e) => setContextInput(e.target.value.replace(/[^\d]/g, ""))}
									inputMode="numeric"
									placeholder={String(autoContext || 200000)}
									className="mt-1.5 w-full rounded border border-black/10 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-primary dark:border-white/10 dark:bg-black/20"
								/>
								<p className="text-[10px] text-text-muted mt-0.5">
									Tokens clients may send before compaction. Leave empty to fall back to {fmtK(autoContext)}.
								</p>
							</>
						)}
					</div>

					{/* Actions */}
					<div className="flex flex-col gap-2 pt-1 sm:flex-row">
						<Button onClick={onClose} variant="ghost" fullWidth size="sm">
							Cancel
						</Button>
						<Button
							onClick={handleSave}
							fullWidth
							size="sm"
							disabled={!name.trim() || !!nameError || saving}
						>
							{saving ? "Saving..." : isEdit ? "Save" : "Create"}
						</Button>
					</div>
				</div>
			</Modal>

			{/* Model Select Modal */}
			{showModelSelect && (
				<ModelSelectModal
					isOpen={showModelSelect}
					onClose={() => setShowModelSelect(false)}
					onSelect={handleAddModel}
					onDeselect={handleDeselectModel}
					activeProviders={activeProviders}
					modelAliases={modelAliases}
					title="Add Model to Combo"
					kindFilter={kindFilter}
					addedModelValues={models}
					closeOnSelect={false}
				/>
			)}
		</>
	)
}
