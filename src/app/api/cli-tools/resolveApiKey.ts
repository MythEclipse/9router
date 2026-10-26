/**
 * Resolves the API key to write into a CLI tool config.
 *
 * CLI tool cards send an empty string when no key is explicitly selected
 * (e.g. the existing config already has a provider block but the frontend
 * can't read the stored Authorization header back). The routes previously
 * fell back to the literal placeholder DEFAULT_LOCAL_API_KEY, which causes 401
 * "Invalid API key" for any deployment with requireApiKey=true (#4399).
 *
 * Resolution order:
 *   1. The key supplied by the caller (non-empty string).
 *   2. The first active key in the dashboard's apiKeys table.
 *   3. Empty string — the route writes no Authorization header value,
 *      which is fine for requireApiKey=false deployments.
 *
 * The placeholder DEFAULT_LOCAL_API_KEY is NEVER written; it was never a real key.
 */

import { getApiKeys } from "@/lib/db";
import { DEFAULT_LOCAL_API_KEY } from "@/shared/constants/config";

/**
 * @param {string|null|undefined} callerKey  Key sent by the frontend.
 * @returns {Promise<string>}
 */
export async function resolveCliApiKey(callerKey) {
  if (callerKey && callerKey.trim() && callerKey.trim() !== DEFAULT_LOCAL_API_KEY) {
    return callerKey.trim();
  }
  try {
    const keys = await getApiKeys();
    const active = keys.find((k) => k.isActive);
    return active?.key || "";
  } catch {
    return "";
  }
}