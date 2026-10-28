"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { CardSkeleton } from "@/shared/components";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { DefaultToolCard } from "../components/index.ts";
import { resolveToolCard } from "../components/toolCardRegistry.tsx";

const CLOUD_URL = process.env.NEXT_PUBLIC_CLOUD_URL;

export default function ToolDetailClient({ toolId, machineId }) {
  const tool = CLI_TOOLS[toolId];
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modelMappings, setModelMappings] = useState({});
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelPublicUrl, setTunnelPublicUrl] = useState("");
  const [tailscaleEnabled, setTailscaleEnabled] = useState(false);
  const [tailscaleUrl, setTailscaleUrl] = useState("");
  const [apiKeys, setApiKeys] = useState([]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [provRes, settingsRes, tunnelRes, keysRes] = await Promise.all([
          fetch("/api/providers"),
          fetch("/api/settings"),
          fetch("/api/tunnel/status"),
          fetch("/api/keys"),
        ]);
        if (!mounted) return;
        if (provRes.ok) {
          const data = await provRes.json();
          setConnections(data.connections || []);
        }
        if (settingsRes.ok) {
          const data = await settingsRes.json();
          setCloudEnabled(data.cloudEnabled || false);
        }
        if (tunnelRes.ok) {
          const data = await tunnelRes.json();
          setTunnelEnabled(!!(data.tunnel?.enabled || data.tunnel?.settingsEnabled));
          setTunnelPublicUrl(data.tunnel?.publicUrl || "");
          setTailscaleEnabled(!!(data.tailscale?.enabled || data.tailscale?.settingsEnabled));
          setTailscaleUrl(data.tailscale?.tunnelUrl || "");
        }
        if (keysRes.ok) {
          const data = await keysRes.json();
          setApiKeys(data.keys || []);
        }
      } catch (error) {
        console.log("Error loading tool data:", error);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const getActiveProviders = () => connections.filter(c => c.isActive !== false);
  const activeProviders = getActiveProviders();

  const getAllAvailableModels = () => {
    const models = [];
    const seenModels = new Set();
    activeProviders.forEach(conn => {
      const alias = PROVIDER_ID_TO_ALIAS[conn.provider] || conn.provider;
      const providerModels = getModelsByProviderId(conn.provider);
      providerModels.forEach(m => {
        const modelValue = `${alias}/${m.id}`;
        if (!seenModels.has(modelValue)) {
          seenModels.add(modelValue);
          models.push({ value: modelValue, label: `${alias}/${m.id}`, provider: conn.provider, alias, connectionName: conn.name, modelId: m.id });
        }
      });

      // openai/anthropic-compatible providers are registered with a random UUID (e.g.
      // "openai-compatible-chat-<uuid>") that has no entry in the static PROVIDER_MODELS
      // catalog, so `getModelsByProviderId` returns []. Routing still works because the
      // request path uses the connection's own model config, but `hasActiveProviders`
      // below would flip to false and disable the Apply button. Fall back to the
      // connection's own models so these providers are usable from CLI tool pages.
      if (providerModels.length === 0) {
        const prefix = conn.providerSpecificData?.prefix || alias;
        const fallbackModels = [];
        if (conn.defaultModel) fallbackModels.push({ id: conn.defaultModel, name: conn.defaultModel });
        (conn.providerSpecificData?.customModels || []).forEach(m => {
          if (m?.id && !fallbackModels.some(f => f.id === m.id)) fallbackModels.push({ id: m.id, name: m.name || m.id });
        });
        if (fallbackModels.length === 0 && conn.testStatus === "active") {
          // Provider is confirmed reachable but exposes no model info anywhere;
          // still let the user apply so they aren't stuck on a permanently disabled button.
          fallbackModels.push({ id: "model-id", name: `${prefix}/model-id` });
        }
        fallbackModels.forEach(m => {
          const modelValue = `${prefix}/${m.id}`;
          if (!seenModels.has(modelValue)) {
            seenModels.add(modelValue);
            models.push({ value: modelValue, label: `${prefix}/${m.id}`, provider: conn.provider, alias: prefix, connectionName: conn.name, modelId: m.id });
          }
        });
      }
    });
    return models;
  };

  const handleModelMappingChange = useCallback((tId, alias, target) => {
    setModelMappings(prev => {
      if (prev[tId]?.[alias] === target) return prev;
      return { ...prev, [tId]: { ...prev[tId], [alias]: target } };
    });
  }, []);

  const getBaseUrl = () => {
    if (tunnelEnabled && tunnelPublicUrl) return tunnelPublicUrl;
    if (cloudEnabled && CLOUD_URL) return CLOUD_URL;
    if (typeof window !== "undefined") return window.location.origin;
    return "http://localhost:20128";
  };

  const renderToolCard = () => {
    const availableModels = getAllAvailableModels();
    const hasActiveProviders = availableModels.length > 0;
    const commonProps = {
      tool,
      isExpanded: true,
      onToggle: () => {},
      baseUrl: getBaseUrl(),
      apiKeys,
      activeProviders,
      cloudEnabled,
      initialStatus: null as unknown as Record<string, unknown> | null,
      tunnelEnabled,
      tunnelPublicUrl,
      tailscaleEnabled,
      tailscaleUrl,
      hasActiveProviders,
    };

    const resolved = resolveToolCard(toolId, {
      modelMappings,
      onModelMappingChange: handleModelMappingChange,
      cloudUrl: CLOUD_URL,
    });

    if (!resolved) {
      return <DefaultToolCard toolId={toolId} {...commonProps} activeProviders={getActiveProviders()} cloudEnabled={cloudEnabled} tunnelEnabled={tunnelEnabled} />;
    }

    const { Card, extraProps } = resolved;
    return <Card {...commonProps} {...extraProps} />;
  };

  // Guard removed/unknown tools (e.g. disabled Cowork) to avoid crash on direct URL.
  if (!tool) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:px-0">
        <Link href="/dashboard/cli-tools" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary w-fit">
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          Back to CLI Tools
        </Link>
        <p className="text-sm text-text-muted">Tool not found or disabled.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:px-0">
      <Link href="/dashboard/cli-tools" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary w-fit">
        <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        Back to CLI Tools
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text-main sm:text-2xl">{tool.name}</h1>
        <p className="text-sm text-text-muted">{tool.description}</p>
      </div>
      {loading ? <CardSkeleton /> : renderToolCard()}
    </div>
  );
}
