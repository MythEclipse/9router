"use client"

import { useEffect } from "react"
import { invalidateModelCaps } from "@/shared/hooks/useModelCaps"
import type { CapacityAdapter } from "./ComboCards.tsx"
import {
	persistComboStrategies as persistStrategies,
	pruneStrategiesForNames,
} from "./ComboHelpers.ts"
import { CAPACITY_ADAPTER_CAPS, normalizeCapEntry } from "./capacityAdapter.ts"

export function useCombosActions(deps) {
	const {
		combos,
		setCombos,
		setActiveProviders,
		setComboStrategies,
		setCapacityAdapter,
		setPresetLoading,
		setConfirmState,
		setBulkBusy,
		selectedCombos,
		comboStrategies,
		setSelectedIds,
		clearSelection,
		setShowCreateModal,
		setEditingCombo,
		setLoading,
	} = deps
	const handleGeneratePresets = async (source) => {
		const label = source === "cursor" ? "Cursor Default" : "Claude Default"
		setPresetLoading(source)
		try {
			const previewRes = await fetch(`/api/combos/presets?source=${source}`)
			const preview = await previewRes.json()
			if (!previewRes.ok) {
				alert(preview.error || `Failed to preview ${label}`)
				return
			}

			const toCreate = preview.toCreate ?? (preview.items || []).filter((i) => !i.exists).length
			const toSkip = preview.toSkip ?? (preview.items || []).filter((i) => i.exists).length
			const total = (preview.items || []).length

			if (total === 0) {
				alert(`No ${label} models available to generate.`)
				return
			}

			if (toCreate === 0) {
				alert(`All ${total} ${label} combos already exist. Nothing to create.`)
				return
			}

			setConfirmState({
				title: `Generate ${label}`,
				message: `Create ${toCreate} combo${toCreate === 1 ? "" : "s"} named like ${source === "cursor" ? "Cursor" : "Claude"} model IDs (seeded with cu/… or cc/…). ${toSkip} already exist and will be skipped. You can edit any combo afterward to add fallbacks.`,
				confirmText: "Generate",
				variant: "primary",
				onConfirm: async () => {
					setConfirmState((prev) => (prev ? { ...prev, loading: true } : null))
					try {
						const res = await fetch("/api/combos/presets", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ source }),
						})
						const data = await res.json()
						if (!res.ok) {
							alert(data.error || `Failed to generate ${label}`)
							return
						}
						await fetchData()
						setConfirmState(null)
					} catch (error) {
						console.log(`Error generating ${label}:`, error)
						alert(`Failed to generate ${label}`)
						setConfirmState((prev) => (prev ? { ...prev, loading: false } : null))
					}
				},
			})
		} catch (error) {
			console.log(`Error previewing ${label}:`, error)
			alert(`Failed to preview ${label}`)
		} finally {
			setPresetLoading(null)
		}
	}

	const fetchData = async () => {
		try {
			const [combosRes, providersRes, settingsRes] = await Promise.all([
				fetch("/api/combos"),
				fetch("/api/providers"),
				fetch("/api/settings"),
			])
			const combosData = await combosRes.json()
			const providersData = await providersRes.json()
			const settingsData = settingsRes.ok ? await settingsRes.json() : {}

			// Only LLM combos here - webSearch/webFetch combos belong to media-providers/web
			if (combosRes.ok) setCombos((combosData.combos || []).filter((c) => !c.kind || c.kind === "llm"))
			if (providersRes.ok) {
				setActiveProviders((providersData.connections || []).filter((c) => c.isActive !== false))
			}
			setComboStrategies(settingsData.comboStrategies || {})
			const rawAdapter = (settingsData.capacityAdapter || {}) as Record<string, unknown>
			const normalized: CapacityAdapter = {} as CapacityAdapter
			for (const cap of CAPACITY_ADAPTER_CAPS) {
				normalized[cap.key] = normalizeCapEntry(rawAdapter[cap.key])
			}
			setCapacityAdapter(normalized)
		} catch (error) {
			console.log("Error fetching data:", error)
		} finally {
			setLoading(false)
		}
	}

	useEffect(() => {
		// `fetchData` only publishes into state from its awaited responses.
		function subscribe() {
			void fetchData()
			return () => {
				// The request settles into its own callback; nothing to tear down.
			}
		}
		subscribe()
	}, [])

	const handleSetCapacityAdapter = async (next) => {
		setCapacityAdapter(next)
		try {
			await fetch("/api/settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ capacityAdapter: next }),
			})
		} catch (error) {
			console.log("Error updating capacity adapter:", error)
		}
	}

	const handleCreate = async (data) => {
		try {
			const res = await fetch("/api/combos", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(data),
			})
			if (res.ok) {
				invalidateModelCaps()
				await fetchData()
				setShowCreateModal(false)
			} else {
				const err = await res.json()
				alert(err.error || "Failed to create combo")
			}
		} catch (error) {
			console.log("Error creating combo:", error)
		}
	}

	const handleUpdate = async (id, data) => {
		try {
			const res = await fetch(`/api/combos/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(data),
			})
			if (res.ok) {
				invalidateModelCaps()
				await fetchData()
				setEditingCombo(null)
			} else {
				const err = await res.json()
				alert(err.error || "Failed to update combo")
			}
		} catch (error) {
			console.log("Error updating combo:", error)
		}
	}

	// "Copy Full": duplicates the combo (same models, kind, context window and
	// routing strategy) under the first free "<name>-N" name. The name is picked
	// server-side so a combo the page has filtered out (non-LLM kinds) still
	// counts as taken.
	const handleDuplicate = async (combo) => {
		try {
			const res = await fetch(`/api/combos/${combo.id}/duplicate`, { method: "POST" })
			if (!res.ok) {
				const err = await res.json().catch(() => ({}))
				alert(err.error || "Failed to copy combo")
				return
			}
			invalidateModelCaps()
			await fetchData()
		} catch (error) {
			console.log("Error copying combo:", error)
			alert("Failed to copy combo")
		}
	}

	const persistComboStrategies = (updated) => persistStrategies(updated, setComboStrategies)

	const handleDelete = async (id) => {
		const combo = combos.find((c) => c.id === id)
		setConfirmState({
			title: "Delete Combo",
			message: combo ? `Delete combo "${combo.name}"?` : "Delete this combo?",
			onConfirm: async () => {
				setConfirmState((prev) => (prev ? { ...prev, loading: true } : null))
				try {
					const res = await fetch(`/api/combos/${id}`, { method: "DELETE" })
					if (res.ok) {
						if (combo?.name) {
							await persistComboStrategies(pruneStrategiesForNames([combo.name], comboStrategies))
						}
						setCombos((prev) => prev.filter((c) => c.id !== id))
						setSelectedIds((prev) => prev.filter((x) => x !== id))
						invalidateModelCaps()
					}
					setConfirmState(null)
				} catch (error) {
					console.log("Error deleting combo:", error)
					setConfirmState((prev) => (prev ? { ...prev, loading: false } : null))
				}
			},
		})
	}

	const handleBulkDelete = () => {
		if (selectedCombos.length === 0) return
		const count = selectedCombos.length
		setConfirmState({
			title: "Delete Selected Combos",
			message: `Delete ${count} selected combo${count === 1 ? "" : "s"}? This cannot be undone.`,
			confirmText: "Delete",
			variant: "danger",
			onConfirm: async () => {
				setConfirmState((prev) => (prev ? { ...prev, loading: true } : null))
				setBulkBusy(true)
				try {
					const ids = selectedCombos.map((c) => c.id)
					const names = selectedCombos.map((c) => c.name)
					const results = await Promise.all(
						ids.map((id) => fetch(`/api/combos/${id}`, { method: "DELETE" })),
					)
					const failed = results.filter((r) => !r.ok).length
					await persistComboStrategies(pruneStrategiesForNames(names, comboStrategies))
					setCombos((prev) => prev.filter((c) => !ids.includes(c.id)))
					clearSelection()
					setConfirmState(null)
					invalidateModelCaps()
					if (failed > 0) alert(`Deleted with ${failed} failure${failed === 1 ? "" : "s"}.`)
				} catch (error) {
					console.log("Error bulk deleting combos:", error)
					alert("Failed to delete selected combos")
					setConfirmState((prev) => (prev ? { ...prev, loading: false } : null))
				} finally {
					setBulkBusy(false)
				}
			},
		})
	}

	// Merge a per-combo strategy patch into settings.comboStrategies. Passing an empty
	// patch (strategy back to default "fallback") drops the entry entirely.
	const handleSetComboStrategy = async (comboName, patch) => {
		try {
			const updated = { ...comboStrategies }
			const next = { ...(updated[comboName] || {}), ...patch }
			// Prune to keep settings clean: default fallback with no extras = no entry.
			if (!next.fallbackStrategy || next.fallbackStrategy === "fallback") {
				delete updated[comboName]
			} else {
				updated[comboName] = next
			}

			await persistComboStrategies(updated)
		} catch (error) {
			console.log("Error updating combo strategy:", error)
		}
	}

	const handleBulkSetStrategy = async (strategy) => {
		if (selectedCombos.length === 0 || !strategy) return
		setBulkBusy(true)
		try {
			const updated = { ...comboStrategies }
			for (const combo of selectedCombos) {
				if (!strategy || strategy === "fallback") {
					delete updated[combo.name]
				} else {
					updated[combo.name] = {
						...(updated[combo.name] || {}),
						fallbackStrategy: strategy,
					}
				}
			}
			await persistComboStrategies(updated)
		} catch (error) {
			console.log("Error bulk updating combo strategy:", error)
			alert("Failed to update strategy for selected combos")
		} finally {
			setBulkBusy(false)
		}
	}

	return {
		handleGeneratePresets,
		fetchData,
		handleSetCapacityAdapter,
		handleCreate,
		handleUpdate,
		handleDuplicate,
		persistComboStrategies,
		handleDelete,
		handleBulkDelete,
		handleSetComboStrategy,
		handleBulkSetStrategy,
	}
}
