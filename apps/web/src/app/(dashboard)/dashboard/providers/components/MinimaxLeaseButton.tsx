"use client"

import { useState } from "react"
import { translate } from "@/i18n/runtime"
import { Button } from "@/shared/components"

interface MinimaxLeaseButtonProps {
	providerId: string
	onConnected?: () => void
	size?: "sm" | "md" | "lg"
}

/**
 * "Use Desktop App" for MiniMax Code.
 *
 * Creates a lease connection that borrows the signed-in MiniMax Code desktop
 * app's credentials over its local named-pipe broker. No browser login and no
 * stored refresh token: the desktop app keeps owning refresh, so the official
 * CLI and this router can share one subscription without their single-use
 * refresh tokens invalidating each other.
 */
export default function MinimaxLeaseButton({
	providerId,
	onConnected,
	size = "sm",
}: MinimaxLeaseButtonProps) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")

	const handleConnect = async () => {
		setBusy(true)
		setError("")
		try {
			const response = await fetch(`/api/oauth/${providerId}/lease-connect`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			})
			const data = await response.json().catch(() => ({}))
			if (!response.ok) {
				setError(data.error || "Could not reach the MiniMax Code desktop app")
				return
			}
			onConnected?.()
		} catch (cause) {
			setError(cause?.message || "Could not reach the MiniMax Code desktop app")
		} finally {
			setBusy(false)
		}
	}

	return (
		<>
			<Button
				size={size}
				icon="desktop_windows"
				variant="secondary"
				disabled={busy}
				onClick={handleConnect}
				title={translate(
					"Borrow the signed-in MiniMax Code desktop app's login — no second sign-in, refresh stays with the desktop app",
				)}
			>
				{busy ? translate("Connecting...") : translate("Use Desktop App")}
			</Button>
			{error && <p className="w-full text-xs text-red-500 break-words">{error}</p>}
		</>
	)
}
