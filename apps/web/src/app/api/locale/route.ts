/**
 * Apply the dashboard language.
 *
 * Delegates: what counts as a valid locale is a rule, so it lives in
 * `9router-api`. The supported list still comes from `@/i18n/config` — that is
 * where the translations are, and a copy in the API package would drift.
 */

import { LOCALE_COOKIE_MAX_AGE_SEC } from "9router-api/domain/locale"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { LOCALE_COOKIE, LOCALES } from "@/i18n/config"
import { getUseCases } from "@/lib/useCases"
import { toResponse } from "../response"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
	try {
		const body = await request.json().catch(() => ({}))
		const locale = getUseCases().assertLocale(body?.locale, LOCALES)

		const cookieStore = await cookies()
		cookieStore.set(LOCALE_COOKIE, locale, {
			path: "/",
			maxAge: LOCALE_COOKIE_MAX_AGE_SEC,
		})

		return NextResponse.json({ success: true, locale })
	} catch (error) {
		return toResponse(error)
	}
}
