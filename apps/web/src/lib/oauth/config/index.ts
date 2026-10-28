/**
 * OAuth Server Configuration
 *
 * The OAuth CLI flows save tokens by calling back into the running 9Router
 * server, so they need the server's own base URL plus an admin token. Both are
 * read from the environment at call time (not module scope) so a dev server
 * restarted with a different `BASE_URL` is picked up without a rebuild.
 */

export interface ServerCredentials {
	/** Base URL of the local 9Router server, e.g. `http://localhost:20128`. */
	server: string
	/** Admin bearer token used by the CLI-facing provider endpoints. */
	token: string
	/** User id the saved connection is attributed to. */
	userId: string
}

export function getServerCredentials(): ServerCredentials {
	return {
		server: process.env.BASE_URL || "http://localhost:20128",
		token: process.env.AUTH_TOKEN || "sk_8router",
		userId: "admin",
	}
}
