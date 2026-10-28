// Patch global fetch with proxy support (must be first)
import "./utils/proxyFetch.ts";

// Config
export { PROVIDERS } from "./config/providers.ts";
export { OAUTH_ENDPOINTS, CLAUDE_SYSTEM_PROMPT } from "./config/appConstants.ts";
export { CACHE_TTL, DEFAULT_MAX_TOKENS, COOLDOWN_MS, BACKOFF_CONFIG } from "./config/runtimeConfig.ts";
export { 
  PROVIDER_MODELS, 
  getProviderModels,
  getDefaultModel, 
  isValidModel,
  findModelName,
  getModelTargetFormat,
  PROVIDER_ID_TO_ALIAS,
  getModelsByProviderId
} from "./config/providerModels.ts";

// Translator
export { FORMATS } from "./translator/formats.ts";
export { 
  register, 
  translateRequest, 
  translateResponse, 
  needsTranslation, 
  initState, 
  initTranslators 
} from "./translator/index.ts";

// Services
export { 
  detectFormat, 
  getTargetFormat 
} from "./services/provider.ts";

export { parseModel, resolveModelAliasFromMap, getModelInfoCore } from "./services/model.ts";

export {
  checkFallbackError,
  isAccountUnavailable,
  getUnavailableUntil
} from "./services/accountFallback.ts";

export {
  TOKEN_EXPIRY_BUFFER_MS,
  refreshAccessToken,
  refreshClaudeOAuthToken,
  refreshGoogleToken,
  refreshCodexToken,
  refreshIflowToken,
  refreshGitHubToken,
  refreshCopilotToken,
  getAccessToken,
  refreshTokenByProvider
} from "./services/tokenRefresh.ts";

export {
  CODEX_MAX_REFRESH_AGE_MS,
  shouldRefreshCredentials,
  refreshProviderCredentials,
  mergeRefreshedCredentials,
  mergeProviderSpecificData,
} from "./services/oauthCredentialManager.ts";

// Handlers
export { handleChatCore, isTokenExpiringSoon } from "./handlers/chatCore.ts";
export { createStreamController, pipeWithDisconnect, createDisconnectAwareStream } from "./utils/streamHandler.ts";

// Executors
export { getExecutor, hasSpecializedExecutor } from "./executors/index.ts";

// Utils
export { errorResponse, formatProviderError } from "./utils/error.ts";
export { 
  createSSETransformStreamWithLogger, 
  createPassthroughStreamWithLogger 
} from "./utils/stream.ts";
