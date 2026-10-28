import open from "open"
import type { OAuthConfig } from "open-sse/providers/schema"
import { OAUTH_TIMEOUT } from "../constants/oauth.ts"
import { generatePKCE } from "../utils/pkce.ts"
import { startLocalServer } from "../utils/server.ts"
import { spinner as createSpinner } from "../utils/ui.ts"

/** Callback query params handed back by the local loopback server. */
export interface OAuthCallbackParams {
	code?: string
	state?: string
	error?: string
	error_description?: string
	[key: string]: string | undefined
}

/** Tokens as returned by the provider's token endpoint. */
export interface OAuthTokens {
	access_token?: string
	refresh_token?: string
	id_token?: string
	expires_in?: number
	token_type?: string
	scope?: string
	[key: string]: unknown
}

/** The result of `authenticate()`: everything needed for the token exchange. */
export interface OAuthAuthorization {
	code?: string
	state?: string
	codeVerifier: string
	redirectUri: string
}

/**
 * Generic OAuth Authorization Code Flow with PKCE
 */
export class OAuthService {
	config: OAuthConfig

	constructor(config: OAuthConfig) {
		this.config = config
	}

	/**
	 * Build authorization URL
	 */
	buildAuthUrl(
		redirectUri: string,
		state: string,
		codeChallenge: string,
		extraParams: Record<string, string> = {},
	): string {
		const params = new URLSearchParams({
			client_id: this.config.clientId,
			response_type: "code",
			redirect_uri: redirectUri,
			state: state,
			code_challenge: codeChallenge,
			code_challenge_method: this.config.codeChallengeMethod,
			...extraParams,
		})

		return `${this.config.authorizeUrl}?${params.toString()}`
	}

	/**
	 * Start local server and wait for callback
	 */
	async startAuthFlow(
		_authUrl: string | null,
		providerName: string,
	): Promise<{
		redirectUri: string
		port: number
		close: () => void
		waitForCallback: () => Promise<OAuthCallbackParams>
	}> {
		const spinner = createSpinner("Starting local server...").start()

		// Start local server for callback
		let callbackParams: OAuthCallbackParams | null = null
		const { port, close } = await startLocalServer((params: OAuthCallbackParams) => {
			callbackParams = params
		})

		const redirectUri = `http://localhost:${port}/callback`
		spinner.succeed(`Local server started on port ${port}`)

		return {
			redirectUri,
			port,
			close,
			waitForCallback: async () => {
				spinner.start(`Waiting for ${providerName} authorization...`)

				await new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(() => {
						reject(new Error("Authentication timeout (5 minutes)"))
					}, OAUTH_TIMEOUT)

					const checkInterval = setInterval(() => {
						if (callbackParams) {
							clearInterval(checkInterval)
							clearTimeout(timeout)
							resolve()
						}
					}, 100)
				})

				spinner.stop()
				close()

				const params = callbackParams as OAuthCallbackParams
				if (params.error) {
					throw new Error(params.error_description || params.error)
				}

				if (!params.code) {
					throw new Error("No authorization code received")
				}

				return params
			},
		}
	}

	/**
	 * Exchange authorization code for tokens
	 */
	async exchangeCode(
		code: string,
		redirectUri: string,
		codeVerifier: string,
		contentType = "application/x-www-form-urlencoded",
	): Promise<OAuthTokens> {
		const body =
			contentType === "application/json"
				? JSON.stringify({
						grant_type: "authorization_code",
						client_id: this.config.clientId,
						code: code,
						redirect_uri: redirectUri,
						code_verifier: codeVerifier,
					})
				: new URLSearchParams({
						grant_type: "authorization_code",
						client_id: this.config.clientId,
						code: code,
						redirect_uri: redirectUri,
						code_verifier: codeVerifier,
					})

		const response = await fetch(this.config.tokenUrl, {
			method: "POST",
			headers: {
				"Content-Type": contentType,
				Accept: "application/json",
			},
			body: body,
		})

		if (!response.ok) {
			const error = await response.text()
			throw new Error(`Token exchange failed: ${error}`)
		}

		return (await response.json()) as OAuthTokens
	}

	/**
	 * Complete OAuth flow
	 */
	async authenticate(
		providerName: string,
		buildAuthUrlFn: (redirectUri: string, state: string, codeChallenge: string) => string,
	): Promise<OAuthAuthorization> {
		// Generate PKCE
		const { codeVerifier, codeChallenge, state } = generatePKCE()

		// Start local server and get redirect URI
		const { redirectUri, waitForCallback } = await this.startAuthFlow(null, providerName)

		// Build authorization URL
		const authUrl = buildAuthUrlFn(redirectUri, state, codeChallenge)

		console.log(`\nOpening browser for ${providerName} authentication...`)
		console.log(`If browser doesn't open, visit:\n${authUrl}\n`)

		// Open browser
		await open(authUrl)

		// Wait for callback
		const callbackParams = await waitForCallback()

		// Validate state
		if (callbackParams.state !== state) {
			throw new Error("Invalid state parameter")
		}

		return {
			code: callbackParams.code,
			state: callbackParams.state,
			codeVerifier,
			redirectUri,
		}
	}
}
