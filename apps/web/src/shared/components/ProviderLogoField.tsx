"use client"

import Image from "next/image"
import { useRef, useState } from "react"
import { Button } from "@/shared/components"
import { isCustomLogo, readLogoFile } from "@/shared/utils/providerLogo"

const DEFAULT_HINT =
	"Optional. PNG, JPEG, WebP or GIF, up to 2 MB. Leave it empty to keep the default icon."

// Logo picker for a provider node. The picked image is downscaled to a small
// square data URL and handed back through onChange(""); that clears it again.
interface ProviderLogoFieldProps {
	logo?: string
	onChange(value: string): void
	hint?: string
}

export default function ProviderLogoField({
	logo,
	onChange,
	hint = DEFAULT_HINT,
}: ProviderLogoFieldProps) {
	const fileRef = useRef(null)
	const [error, setError] = useState("")
	const [reading, setReading] = useState(false)
	const preview = isCustomLogo(logo)

	const handleFile = async (event) => {
		const file = event.target.files?.[0]
		event.target.value = "" // allow picking the same file again after a reject
		if (!file) return
		setReading(true)
		setError("")
		try {
			onChange(await readLogoFile(file))
		} catch (err) {
			setError(err?.message || "Failed to read that image")
		} finally {
			setReading(false)
		}
	}

	return (
		<div className="flex flex-col gap-1.5">
			<label className="text-sm font-medium text-text-main">Logo</label>
			<div className="flex items-center gap-3">
				<span className="size-10 shrink-0 rounded-[10px] border border-border/50 bg-surface-2 flex items-center justify-center overflow-hidden">
					{preview ? (
						<Image
							src={preview}
							alt=""
							width={40}
							height={40}
							unoptimized
							className="size-full object-contain"
						/>
					) : (
						<span className="material-symbols-outlined text-[18px] text-text-muted">image</span>
					)}
				</span>
				<Button
					type="button"
					variant="outline"
					icon="upload"
					loading={reading}
					onClick={() => fileRef.current?.click()}
					className="w-full sm:w-auto"
				>
					{preview ? "Change Logo" : "Upload Logo"}
				</Button>
				{preview && (
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							setError("")
							onChange("")
						}}
					>
						Remove
					</Button>
				)}
			</div>
			<input
				ref={fileRef}
				type="file"
				accept="image/png,image/jpeg,image/webp,image/gif"
				className="hidden"
				onChange={handleFile}
			/>
			<p className={`text-xs ${error ? "text-red-500" : "text-text-muted"}`}>{error || hint}</p>
		</div>
	)
}
