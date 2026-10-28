"use client"

import { useState } from "react"
import { LOCALE_FLAGS } from "@/shared/constants/locales"
import { notifyLocaleChanged, useLocale } from "@/shared/hooks/useLocale"
import LanguageSwitcher from "./LanguageSwitcher.tsx"

export default function HeaderLanguage() {
	const [open, setOpen] = useState(false)
	const locale = useLocale()

	return (
		<>
			<button
				onClick={() => setOpen(true)}
				className="flex items-center justify-center p-2 rounded-lg text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5 transition-all"
				title="Language"
				data-i18n-skip="true"
			>
				<span className="text-lg leading-none">{LOCALE_FLAGS[locale] || "🌐"}</span>
			</button>

			<LanguageSwitcher
				hideTrigger
				isOpen={open}
				onClose={(next) => {
					setOpen(false)
					// The switcher already wrote the cookie; the locale readers just need
					// to be told, so the flag can follow immediately.
					if (next) notifyLocaleChanged()
				}}
			/>
		</>
	)
}
