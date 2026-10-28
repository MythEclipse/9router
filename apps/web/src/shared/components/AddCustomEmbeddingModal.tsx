"use client"

import { useState } from "react"
import { Badge, Button, Input, Modal } from "@/shared/components"
import ProviderLogoField from "@/shared/components/ProviderLogoField"

const DEFAULT_BASE_URL = "https://api.openai.com/v1"

// Dual-mode modal: edit when `node` provided, add otherwise
//
// The form is seeded from `node` once, as the state's initial value, and the
// caller mounts it under a key that names that identity (node id, or "new" for
// the add form). The dialog therefore never has to copy its own props into
// state after the fact: picking another node mounts a new dialog with a form
// already built from it, and closing/reopening the "add" form remounts it
// blank instead of showing the last edit.
export function addCustomEmbeddingModalKey(node) {
	return node?.id ? `custom-embedding:${node.id}` : "custom-embedding:new"
}

interface AddCustomEmbeddingModalProps {
	isOpen: boolean
	onClose(...args: unknown[]): unknown
	onCreated?(...args: unknown[]): unknown
	onSaved?(...args: unknown[]): unknown
	node?: {
		id?: string
		name?: string
		prefix?: string
		baseUrl?: string
		logo?: string
	}
}

export default function AddCustomEmbeddingModal({
	isOpen,
	onClose,
	onCreated,
	onSaved,
	node,
}: AddCustomEmbeddingModalProps) {
	const isEdit = !!node
	const [formData, setFormData] = useState(() => ({
		name: node?.name || "",
		prefix: node?.prefix || "",
		baseUrl: node?.baseUrl || DEFAULT_BASE_URL,
		logo: node?.logo || "",
	}))
	const [submitting, setSubmitting] = useState(false)
	const [checkKey, setCheckKey] = useState("")
	const [checkModelId, setCheckModelId] = useState("")
	const [validating, setValidating] = useState(false)
	const [validationResult, setValidationResult] = useState(null)

	const handleSubmit = async () => {
		if (!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim()) return
		setSubmitting(true)
		try {
			const url = isEdit ? `/api/provider-nodes/${node.id}` : "/api/provider-nodes"
			const method = isEdit ? "PUT" : "POST"
			const payload: {
				name: string
				prefix: string
				baseUrl: string
				logo: string
				type?: string
			} = {
				name: formData.name,
				prefix: formData.prefix,
				baseUrl: formData.baseUrl,
				logo: formData.logo,
			}
			if (!isEdit) payload.type = "custom-embedding"

			const res = await fetch(url, {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			})
			const data = await res.json()
			if (res.ok) {
				if (isEdit) onSaved?.(data.node)
				else onCreated?.(data.node)
			}
		} catch (error) {
			console.log("Error saving custom embedding node:", error)
		} finally {
			setSubmitting(false)
		}
	}

	const handleValidate = async () => {
		setValidating(true)
		try {
			const res = await fetch("/api/provider-nodes/validate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					baseUrl: formData.baseUrl,
					apiKey: checkKey,
					type: "custom-embedding",
					modelId: checkModelId.trim() || undefined,
				}),
			})
			const data = await res.json()
			setValidationResult(data)
		} catch {
			setValidationResult({ valid: false, error: "Network error" })
		} finally {
			setValidating(false)
		}
	}

	const renderValidationResult = () => {
		if (!validationResult) return null
		const { valid, error, dimensions } = validationResult
		if (valid) {
			return (
				<>
					<Badge variant="success">Valid</Badge>
					{dimensions && <span className="text-sm text-text-muted">{dimensions} dims</span>}
				</>
			)
		}
		return (
			<div className="flex flex-col gap-1">
				<Badge variant="error">Invalid</Badge>
				{error && <span className="text-sm text-red-500">{error}</span>}
			</div>
		)
	}

	return (
		<Modal
			isOpen={isOpen}
			title={isEdit ? "Edit Custom Embedding" : "Add Custom Embedding"}
			onClose={onClose}
		>
			<div className="flex flex-col gap-4">
				<ProviderLogoField
					logo={formData.logo}
					onChange={(next) => setFormData({ ...formData, logo: next })}
				/>
				<Input
					label="Name"
					value={formData.name}
					onChange={(e) => setFormData({ ...formData, name: e.target.value })}
					placeholder="Voyage AI"
					hint="A friendly label for this embedding provider"
				/>
				<Input
					label="Prefix"
					value={formData.prefix}
					onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
					placeholder="voyage"
					hint="The provider prefix used in model IDs (e.g. voyage/voyage-3)"
				/>
				<Input
					label="Base URL"
					value={formData.baseUrl}
					onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
					placeholder="https://api.voyageai.com/v1"
					hint="Most embedding APIs are OpenAI-compatible: Voyage, Cohere, Jina, Mistral, Together..."
				/>
				<Input
					label="API Key (for Check)"
					type="password"
					value={checkKey}
					onChange={(e) => setCheckKey(e.target.value)}
				/>
				<Input
					label="Model ID (for Check)"
					value={checkModelId}
					onChange={(e) => setCheckModelId(e.target.value)}
					placeholder="e.g. voyage-3, embed-english-v3.0, text-embedding-3-small"
					hint="Used to send a validation test request"
				/>
				<div className="flex items-center gap-3">
					<Button
						onClick={handleValidate}
						disabled={!checkKey || !checkModelId.trim() || validating || !formData.baseUrl.trim()}
						variant="secondary"
					>
						{validating ? "Checking..." : "Check"}
					</Button>
					{renderValidationResult()}
				</div>
				<div className="flex gap-2">
					<Button
						onClick={handleSubmit}
						fullWidth
						disabled={
							!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim() || submitting
						}
					>
						{submitting ? (isEdit ? "Saving..." : "Creating...") : isEdit ? "Save" : "Create"}
					</Button>
					<Button onClick={onClose} variant="ghost" fullWidth>
						Cancel
					</Button>
				</div>
			</div>
		</Modal>
	)
}
