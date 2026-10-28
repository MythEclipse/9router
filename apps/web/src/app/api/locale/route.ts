import { cookies } from "next/headers"
import { NextResponse } from "next/server"

import { isSupportedLocale, LOCALE_COOKIE, normalizeLocale } from "@/i18n/config"

export const dynamic = "force-dynamic"

export async function POST(request) {
	try {
		const { locale } = await request.json()

		if (!locale || !isSupportedLocale(locale)) {
			return NextResponse.json({ error: "Invalid locale" }, { status: 400 })
		}

		const normalized = normalizeLocale(locale)
		const cookieStore = await cookies()
		cookieStore.set(LOCALE_COOKIE, normalized, {
			path: "/",
			maxAge: 60 * 60 * 24 * 365, // 1 year
		})

		return NextResponse.json({ success: true, locale: normalized })
	} catch (_error) {
		return NextResponse.json({ error: "Failed to set locale" }, { status: 500 })
	}
}
