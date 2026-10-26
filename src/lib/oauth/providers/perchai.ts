import { PERCHAI_CONFIG } from "../constants/oauth";

const provider = {
  config: PERCHAI_CONFIG,
  flowType: "authorization_code_pkce",
  callbackPath: PERCHAI_CONFIG.callbackPath,
  buildAuthUrl: (config, redirectUri, state, codeChallenge, meta: Record<string, string> = {}) => {
    const socialProvider = meta.socialProvider || meta.provider || "google";
    const params = new URLSearchParams({ provider: socialProvider, redirect_to: redirectUri });
    if (codeChallenge) {
      params.set("code_challenge", codeChallenge);
      params.set("code_challenge_method", "s256");
    }
    if (state) params.set("state", state);
    if (socialProvider === "google") params.set("prompt", "select_account");
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, _redirectUri, codeVerifier) => {
    const raw = typeof code === "string" ? code.trim() : "";
    if (!raw) throw new Error("Missing Perch AI authorization code or access token");
    const publishableKey = process.env.PERCHAI_SUPABASE_ANON_KEY;
    if (!publishableKey) throw new Error("PERCHAI_SUPABASE_ANON_KEY is required for Perch AI OAuth");

    if (raw.startsWith("{")) {
      const session = JSON.parse(raw);
      if (session.accessToken || session.access_token) return session;
    }
    if (raw.startsWith("eyJ") && raw.includes(".")) return { access_token: raw };

    let authorizationCode = raw;
    if (raw.includes("://") || raw.includes("code=")) {
      try {
        const callback = new URL(raw.startsWith("http") ? raw : `http://localhost/${raw.replace(/^\/+/, "")}`);
        authorizationCode = callback.searchParams.get("code") || raw;
      } catch {
        throw new Error("The Perch AI callback URL is invalid");
      }
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`,
      },
      body: JSON.stringify({ auth_code: authorizationCode, code_verifier: codeVerifier }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Perch AI token exchange failed (${response.status}): ${text.slice(0, 400)}`);
    }
    return response.json();
  },
  mapTokens: (tokens) => {
    const accessToken = tokens.access_token || tokens.accessToken;
    if (typeof accessToken !== "string" || !accessToken) {
      throw new Error("Perch AI token response did not contain an access token");
    }
    const refreshToken = tokens.refresh_token || tokens.refreshToken || null;
    let email = tokens.user?.email || tokens.email || "";
    let userId = tokens.user?.id || tokens.userId || "";
    if (!email && accessToken.startsWith("eyJ")) {
      try {
        const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
        email = payload.email || "";
        userId ||= payload.sub || "";
      } catch {
        // Identity claims are optional; the access token remains usable.
      }
    }
    const expiresIn = Number(tokens.expires_in) ||
      (Number(tokens.expiresAt) ? Math.max(0, Number(tokens.expiresAt) - Math.floor(Date.now() / 1000)) : 3600);
    return {
      accessToken,
      refreshToken,
      expiresIn,
      email,
      providerSpecificData: {
        userId,
        appUrl: tokens.appUrl || PERCHAI_CONFIG.appBaseUrl,
        authMethod: refreshToken ? "oauth" : "access_token",
      },
    };
  },
};

export default provider;
