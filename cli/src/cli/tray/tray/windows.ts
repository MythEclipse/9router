import path from "node:path"
import { fileURLToPath } from "node:url"
import { initWinTray } from "../trayWin.js"
import { buildMenuItems, getAutostartEnabled, handleClick, MENU_INDEX, trayState } from "./state.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Windows tray via PowerShell NotifyIcon
 */
function initWindowsTray(options) {
	const { port } = options
	try {
		const iconPath = path.join(__dirname, "icon.ico")
		const autostartEnabled = getAutostartEnabled()
		const items = buildMenuItems(port, autostartEnabled)

		trayState.instance = initWinTray({
			iconPath,
			tooltip: `9Router - Port ${port}`,
			items,
			onClick: (index) => {
				handleClick(index, options, (newEnabled) => {
					const newTitle = newEnabled ? "✓ Auto-start Enabled" : "Enable Auto-start"
					trayState.instance.updateItem(MENU_INDEX.AUTOSTART, newTitle, true)
				})
			},
		})

		trayState.isWin = true
		options.onReady?.()
		return trayState.instance
	} catch (err) {
		options.onError?.(err)
		return null
	}
}

export { initWindowsTray }
