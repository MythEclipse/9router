"use client"

import useThemeStore from "@/store/themeStore"

// Subscribe to system theme changes
function _subscribeToSystemTheme(callback) {
	if (typeof window === "undefined") return () => {}
	const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
	mediaQuery.addEventListener("change", callback)
	return () => mediaQuery.removeEventListener("change", callback)
}

// Get current system theme preference
function _getSystemThemeSnapshot() {
	if (typeof window === "undefined") return false
	return window.matchMedia("(prefers-color-scheme: dark)").matches
}

// Server snapshot always returns false
function _getServerSnapshot() {
	return false
}

export function useTheme() {
	const { theme, setTheme, toggleTheme, canChangeTheme } = useThemeStore()

	return {
		theme,
		setTheme,
		toggleTheme,
		canChangeTheme,
		isDark: true,
	}
}
