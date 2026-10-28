import pkg from "../../../package.json" with { type: "json" };

// App configuration
export const APP_CONFIG = {
  name: "9Router Proxy",
  description: "AI Infrastructure Management",
  version: pkg.version,
  // Build identity = git short SHA, injected at build time by the Nix flake
  // (NEXT_PUBLIC_GIT_SHA). Falls back to null in dev where the env var is
  // absent, so the dashboard shows just the semver.
  gitSha: process.env.NEXT_PUBLIC_GIT_SHA || null,
};

// GitHub configuration
export const GITHUB_CONFIG = {
  donateUrl: "https://9router.com/api/donate",
  repoUrl: "https://github.com/asepharyana/9router",
};

export const SERVER_CONFIG = {
  port: 20128,
};

/**
 * Key written into CLI tool configs when no user API key is available yet.
 * It is a placeholder the gateway accepts locally, not a real credential.
 */
export const DEFAULT_LOCAL_API_KEY = "sk_9router";

// Post-login thank-you dialog: shown once per login, skippable forever.
export const WELCOME_CONFIG = {
  shownKey: "9router:welcomeAfterLogin",
  hideKey: "9router:welcomeNeverShow",
};

// Theme configuration
export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "dark", // "light" | "dark" | "system"
};

// Subscription
export const SUBSCRIPTION_CONFIG = {
  price: 1.0,
  currency: "USD",
  interval: "month",
  planName: "Pro Plan",
};

// API endpoints
export const API_ENDPOINTS = {
  users: "/api/users",
  providers: "/api/providers",
  payments: "/api/payments",
  auth: "/api/auth",
};

export const CONSOLE_LOG_CONFIG = {
  maxLines: 200,
  pollIntervalMs: 1000,
};

// Client-side store TTL: how long fetched data stays fresh before re-fetching
export const CLIENT_STORE_TTL_MS = 60000;

// Quota auto-ping: keep 5h windows warm by sending a tiny request right after reset.
export const QUOTA_AUTOPING_CONFIG = {
  tickIntervalMs: 60000,                // scheduler tick
  pingLeadMs: 5000,                     // fire once reset passes (within tolerance)
  refreshAheadMs: 300000,               // refetch usage when within 5min of reset
  failureCooldownMs: 900000,            // avoid failed ping spam while upstream/auth is unhealthy
  providers: {
    claude: {
      settingsKey: "claudeAutoPing",    // preserve existing settings contract
      quotaKey: "session (5h)",         // quota key returned by usage handler
      pingModel: "claude-haiku-4-5-20251001",
      pingText: "hi",
      pingMaxTokens: 1,
    },
    codex: {
      settingsKey: "codexAutoPing",
      quotaKey: "session",
      pingWhenResetAtSlides: true,
      resetAtDriftMs: 30000,
      minPingIntervalMs: 600000,
      skipWhenBlockingQuotaExhausted: true,
      // gpt-5.6-terra is the lightweight model for auto-pinging Codex 5h reset window.
      pingModel: "gpt-5.6-terra",
      pingText: "hi",
      pingInstructions: "Reply with OK.",
      pingReasoningEffort: "none",
    },
  },
};

// Telegram auto-backup: send the full DB export (same payload as the manual
// Download Backup) to the owner chat on an interval.
export const AUTO_BACKUP_CONFIG = {
  minIntervalHours: 1, // refuse schedules tighter than hourly
  retryDelayMs: 1800000, // retry after a failed send (30min)
  maxBytes: 45 * 1024 * 1024, // Telegram bot upload cap is 50MB. stay under it
};

// Re-export from providers.js for backward compatibility
export {
  FREE_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  AI_PROVIDERS,
  AUTH_METHODS,
} from "./providers.ts";

// Re-export from models.js for backward compatibility
export {
  PROVIDER_MODELS,
  AI_MODELS,
} from "./models.ts";
