import { NextResponse } from "next/server";
import {
  getProviderConnections,
  createProviderConnection,
  getProviderNodeById,
  getProviderNodes,
  getProxyPoolById,
} from "@/models";
import { APIKEY_PROVIDERS } from "@/shared/constants/config";
import { AI_PROVIDERS, FREE_TIER_PROVIDERS, WEB_COOKIE_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider } from "@/shared/constants/providers";
import { normalizeProviderId, normalizeProviderSpecificData } from "@/lib/providerNormalization";
import { toProviderConnectionResponse } from "@/lib/providerConnectionResponse";

export const dynamic = "force-dynamic";

function normalizeProxyConfig(body = {}) {
  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return { error: "Connection proxy URL is required when connection proxy is enabled" };
  }

  return {
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

async function normalizeProxyPoolId(proxyPoolId) {
  if (proxyPoolId === undefined || proxyPoolId === null || proxyPoolId === "" || proxyPoolId === "__none__") {
    return { proxyPoolId: null };
  }

  const normalizedId = String(proxyPoolId).trim();
  if (!normalizedId) {
    return { proxyPoolId: null };
  }

  const proxyPool = await getProxyPoolById(normalizedId);
  if (!proxyPool) {
    return { error: "Proxy pool not found" };
  }

  return { proxyPoolId: normalizedId };
}

/**
 * Next free ordinal for an unnamed API key on this provider, so repeated adds
 * produce distinct, human-readable identities ("Gemini #1", "Gemini #2", …)
 * instead of colliding on the provider label.
 *
 * Reuses the exact key when it is already stored: re-adding an existing key is an
 * edit of that entry, not the arrival of a new one, and must keep its name.
 */
async function nextKeyOrdinal(provider, apiKey) {
  const existing = await getProviderConnections({ provider });
  const sameKey = apiKey ? existing.find((c) => c.apiKey === apiKey) : null;
  if (sameKey?.name) {
    const match = / #(\d+)$/.exec(sameKey.name);
    if (match) return Number(match[1]);
  }
  const taken = new Set(
    existing
      .map((c) => {
        const match = / #(\d+)$/.exec(c.name || "");
        return match ? Number(match[1]) : null;
      })
      .filter((n) => Number.isInteger(n))
  );
  let ordinal = 1;
  while (taken.has(ordinal)) ordinal++;
  return ordinal;
}

// GET /api/providers - List all connections
export async function GET() {
  try {
    const connections = await getProviderConnections();

    // Build nodeNameMap for compatible providers (id → name)
    let nodeNameMap = {};
    try {
      const nodes = await getProviderNodes();
      for (const node of nodes) {
        if (node.id && node.name) nodeNameMap[node.id] = node.name;
      }
    } catch { }

    // Hide sensitive fields, enrich name for compatible providers
    const safeConnections = connections.map(c => {
      const isCompatible = isOpenAICompatibleProvider(c.provider) || isAnthropicCompatibleProvider(c.provider);
      const name = isCompatible
        ? (c.name || nodeNameMap[c.provider] || c.providerSpecificData?.nodeName || c.provider)
        : c.name;
      return {
        ...toProviderConnectionResponse(c),
        name,
      };
    });

    return NextResponse.json({ connections: safeConnections });
  } catch (error) {
    console.log("Error fetching providers:", error);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}

// POST /api/providers - Create new connection (API Key only, OAuth via separate flow)
export async function POST(request) {
  try {
    const body = await request.json();
    const provider = normalizeProviderId(body.provider);
    const { apiKey, name, displayName, priority, globalPriority, defaultModel, testStatus } = body;
    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return NextResponse.json({ error: proxyConfig.error }, { status: 400 });
    }

    const proxyPoolResult = await normalizeProxyPoolId(body.proxyPoolId);
    if (proxyPoolResult.error) {
      return NextResponse.json({ error: proxyPoolResult.error }, { status: 400 });
    }
    const proxyPoolId = proxyPoolResult.proxyPoolId;

    // Validation
    const isWebCookieProvider = !!WEB_COOKIE_PROVIDERS[provider];
    // Dual-auth providers (e.g. codebuddy-cn, xai) live under category "oauth" but also
    // accept an API key via authModes — they aren't in APIKEY_PROVIDERS, so allow them here.
    const supportsApiKeyMode = !!AI_PROVIDERS[provider]?.authModes?.includes("apikey");
    const isValidProvider = APIKEY_PROVIDERS[provider] ||
      FREE_TIER_PROVIDERS[provider] ||
      supportsApiKeyMode ||
      isWebCookieProvider ||
      isOpenAICompatibleProvider(provider) ||
      isAnthropicCompatibleProvider(provider) ||
      isCustomEmbeddingProvider(provider);

    if (!provider || !isValidProvider) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    // A provider may declare a providerSpecificData field that stands in for an API key — e.g.
    // Bedrock's `profile`, where the credential lives in the local AWS config and there is no
    // key to paste. Without this, following such a provider's own setup notice returns 400.
    const apiKeySubstitute = AI_PROVIDERS[provider]?.apiKeyOptionalWith;
    const hasApiKeySubstitute = !!(apiKeySubstitute && body.providerSpecificData?.[apiKeySubstitute]);
    if (!apiKey && provider !== "ollama-local" && !hasApiKeySubstitute) {
      return NextResponse.json({ error: `${isWebCookieProvider ? "Cookie value" : "API Key"} is required` }, { status: 400 });
    }
    // Key pools: several keys for one provider is the normal case, so the router
    // can fail over when one is rate-limited. Identity must therefore come from the
    // key, not the provider label — two keys both named "Gemini" collide and the
    // second POST is refused with 409, leaving a one-key pool that cannot fall back.
    // An explicit name from the caller still wins.
    const explicitName = typeof name === "string" && name.trim() ? name.trim() : displayName;
    const connectionName = explicitName || `${AI_PROVIDERS[provider]?.name || provider} #${await nextKeyOrdinal(provider, apiKey)}`;

    let providerSpecificData = normalizeProviderSpecificData(provider, body, body.providerSpecificData);

    // Compatible LLM nodes support multiple API-key connections (key pool); runtime
    // rotates/fails over via getProviderCredentials. Embedding nodes stay single-connection.
    if (isOpenAICompatibleProvider(provider)) {
      const node = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "OpenAI Compatible node not found" }, { status: 404 });
      }
      providerSpecificData = {
        prefix: node.prefix,
        apiType: node.apiType,
        baseUrl: node.baseUrl,
        nodeName: node.name,
      };
    } else if (isAnthropicCompatibleProvider(provider)) {
      const node = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "Anthropic Compatible node not found" }, { status: 404 });
      }
      providerSpecificData = {
        prefix: node.prefix,
        baseUrl: node.baseUrl,
        nodeName: node.name,
      };
    } else if (isCustomEmbeddingProvider(provider)) {
      const node = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "Custom Embedding node not found" }, { status: 404 });
      }
      providerSpecificData = {
        prefix: node.prefix,
        baseUrl: node.baseUrl,
        nodeName: node.name,
      };
    }

    const mergedProviderSpecificData = {
      ...(providerSpecificData || {}),
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled,
      connectionProxyUrl: proxyConfig.connectionProxyUrl,
      connectionNoProxy: proxyConfig.connectionNoProxy,
    };

    if (proxyPoolId !== null) {
      mergedProviderSpecificData.proxyPoolId = proxyPoolId;
    }

    const newConnection = await createProviderConnection({
      provider,
      authType: isWebCookieProvider ? "cookie" : "apikey",
      name: connectionName,
      apiKey: apiKey || "",
      priority: priority || 1,
      globalPriority: globalPriority || null,
      defaultModel: defaultModel || null,
      providerSpecificData: mergedProviderSpecificData,
      isActive: true,
      testStatus: testStatus || "unknown",
      // POST with an id is an explicit edit of that connection; without one, a
      // name collision is refused rather than silently overwriting a key. #4311
      allowOverwrite: body.id ? true : (body.allowOverwrite === true || body.overwrite === true),
    });

    return NextResponse.json(
      { connection: toProviderConnectionResponse(newConnection) },
      { status: 201 },
    );
  } catch (error) {
    if (error?.code === "PROVIDER_NAME_CONFLICT") {
      return NextResponse.json(
        { error: error.message, code: error.code, existingId: error.existingId, existingName: error.existingName },
        { status: 409 }
      );
    }
    console.log("Error creating provider:", error);
    return NextResponse.json({ error: "Failed to create provider" }, { status: 500 });
  }
}
