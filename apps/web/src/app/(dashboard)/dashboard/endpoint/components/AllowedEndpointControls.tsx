"use client"

import { API_KEY_ENDPOINT_KINDS, type ApiKeyEndpointKind } from "@9router/db/shared/keyEndpoints"

const LABELS: Record<ApiKeyEndpointKind, string> = {
	chat: "Chat / Messages",
	responses: "Responses",
	models: "Model listing",
	embeddings: "Embeddings",
	images: "Images",
	audio: "Audio",
	search: "Search",
	web: "Web fetch",
	videos: "Videos",
	systemone: "System One",
	other: "Other API routes",
}

interface AllowedEndpointControlsProps {
	value: string[]
	onChange(value: string[]): void
}

export default function AllowedEndpointControls({ value, onChange }: AllowedEndpointControlsProps) {
	const toggle = (kind: ApiKeyEndpointKind, checked: boolean) => {
		onChange(checked ? [...new Set([...value, kind])] : value.filter((entry) => entry !== kind))
	}

	return (
		<fieldset className="space-y-2">
			<legend className="text-sm font-medium text-text-main">Allowed API endpoints</legend>
			<p className="text-xs text-text-muted">
				No selections means all endpoint types are allowed. Selecting any type restricts this key to the
				selected types.
			</p>
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				{API_KEY_ENDPOINT_KINDS.map((kind) => (
					<label key={kind} className="flex items-center gap-2 text-sm text-text-main">
						<input
							type="checkbox"
							checked={value.includes(kind)}
							onChange={(event) => toggle(kind, event.target.checked)}
							className="accent-primary"
						/>
						{LABELS[kind]}
					</label>
				))}
			</div>
		</fieldset>
	)
}
