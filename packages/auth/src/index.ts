/**
 * Barrel for the auth package.
 *
 * Callers import from `@9router/auth` for the common surface and from
 * `@9router/auth/<module>` when they need one specific flow.
 */
export { getDashboardAuthSession } from "./dashboardSession.ts"
