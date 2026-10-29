import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { cookies } from "next/headers"

/**
 * The role on the current dashboard session, or null when there is none.
 *
 * Read here rather than inside a use-case because the session lives in a cookie,
 * and because the *rule* about what a role may do is not this: it belongs in
 * `domain/`, where it can be tested without a request.
 */
export async function sessionRole(): Promise<string | null> {
	const cookieStore = await cookies()
	const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
	return typeof session?.role === "string" ? session.role : null
}
