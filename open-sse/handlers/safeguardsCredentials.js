/**
 * Credential lookup for the safeguard review's decision engine.
 *
 * The review runs on a DIFFERENT provider than the chat request it reviews, so
 * it needs its own credential lookup. Reusing the chat lane's credentials would
 * send a System One request with, say, a Claude OAuth token.
 *
 * The lookup is injectable so open-sse/handlers stays testable without the
 * app's auth layer.
 */

import { getProviderCredentials } from "@/sse/services/auth.js";

/**
 * Resolve credentials for a decision-model review.
 *
 * @param {object} params
 * @param {string} params.provider - decision provider id
 * @param {string} params.model - decision model id
 * @param {Function} [params.credentialResolver] - override for tests
 * @returns {Promise<object|null>} credentials, or null when unavailable
 */
export async function resolveDecisionCredentials({ provider, model, credentialResolver }) {
  if (!provider) return null;
  const resolve = credentialResolver || getProviderCredentials;
  try {
    const credentials = await resolve(provider, new Set(), model, {});
    if (!credentials || credentials.allRateLimited) return null;
    return credentials;
  } catch {
    return null;
  }
}