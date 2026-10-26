"use client";

import { useState, useEffect } from "react";
import ProviderLogoField from "@/shared/components/ProviderLogoField";
import { Badge, Button, Input, Modal, Select, Toggle } from "@/shared/components";


interface AddCompatibleFormData {
  name: string;
  prefix: string;
  apiType?: string;
  baseUrl: string;
  logo: string;
  quotaEnabled: boolean;
  quotaPath: string;
}

interface VariantConfig {
  title: string;
  type: string;
  defaultBaseUrl: string;
  namePlaceholder: string;
  prefixPlaceholder: string;
  baseUrlHint: string;
  modelIdPlaceholder: string;
  errorLabel: string;
  hasApiType: boolean;
}

const VARIANT_CONFIG: Record<"openai" | "anthropic" | "moonshot", VariantConfig> = {
  openai: {
    title: "Add OpenAI Compatible",
    type: "openai-compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    namePlaceholder: "OpenAI Compatible (Prod)",
    prefixPlaceholder: "oc-prod",
    baseUrlHint: "Use the base URL (ending in /v1) for your OpenAI-compatible API.",
    modelIdPlaceholder: "e.g. gpt-4, claude-3-opus",
    errorLabel: "OpenAI Compatible",
    hasApiType: true,
  },
  anthropic: {
    title: "Add Anthropic Compatible",
    type: "anthropic-compatible",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    namePlaceholder: "Anthropic Compatible (Prod)",
    prefixPlaceholder: "ac-prod",
    baseUrlHint: "Use the base URL (ending in /v1) for your Anthropic-compatible API. The system will append /messages.",
    modelIdPlaceholder: "e.g. claude-3-opus",
    errorLabel: "Anthropic Compatible",
    hasApiType: false,
  },
  moonshot: {
    title: "Add MoonshotAI Compatible",
    type: "openai-compatible",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    namePlaceholder: "MoonshotAI Compatible (Prod)",
    prefixPlaceholder: "mk-prod",
    baseUrlHint: "Use the base URL (ending in /v1) for your MoonshotAI (Kimi) OpenAI-compatible API. Docs: platform.kimi.ai",
    modelIdPlaceholder: "e.g. kimi-k2.6, moonshot-v1-8k",
    errorLabel: "MoonshotAI Compatible",
    hasApiType: true,
  },
};

const API_TYPE_OPTIONS = [
  { value: "chat", label: "Chat Completions" },
  { value: "responses", label: "Responses API" },
];

interface AddCompatibleModalProps {
  variant: "openai" | "anthropic" | "moonshot"
  isOpen: boolean
  onClose(...args: unknown[]): unknown
  onCreated(...args: unknown[]): unknown
}

function AddCompatibleModal({ variant, isOpen, onClose, onCreated }: AddCompatibleModalProps) {
  const config = VARIANT_CONFIG[variant];
  const initialFormData = () => ({
    name: "",
    prefix: "",
    ...(config.hasApiType ? { apiType: "chat" } : {}),
    baseUrl: config.defaultBaseUrl,
    logo: "",
    quotaEnabled: false,
    quotaPath: "/credits",

  });

  const [formData, setFormData] = useState<AddCompatibleFormData>(initialFormData());
  const [submitting, setSubmitting] = useState(false);
  const [checkKey, setCheckKey] = useState("");
  const [checkModelId, setCheckModelId] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);

  // Switching the API type swaps in that type's default base URL, but only while
  // the field still holds the previous type's default - a URL the operator typed
  // by hand survives a toggle back and forth.
  const handleApiTypeChange = (nextType: string) => {
    setFormData((prev) => {
      const wasPristine = prev.baseUrl === config.defaultBaseUrl;
      return { ...prev, apiType: nextType, ...(wasPristine ? { baseUrl: config.defaultBaseUrl } : {}) };
    });
  };

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/provider-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          prefix: formData.prefix,
          ...(config.hasApiType ? { apiType: formData.apiType } : {}),
          baseUrl: formData.baseUrl,
          type: config.type,
          brand: variant || undefined,
          logo: formData.logo,
          quotaEnabled: formData.quotaEnabled,
          quotaPath: formData.quotaPath,

        }),
      });
      const data = await res.json();
      if (res.ok) {
        onCreated(data.node);
        setFormData(initialFormData());
        setCheckKey("");
        setValidationResult(null);
      }
    } catch (error) {
      console.log(`Error creating ${config.errorLabel} node:`, error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await fetch("/api/provider-nodes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: formData.baseUrl,
          apiKey: checkKey,
          type: config.type,
          modelId: checkModelId.trim() || undefined,
        }),
      });
      const data = await res.json();
      setValidationResult(data);
    } catch {
      setValidationResult({ valid: false, error: "Network error" });
    } finally {
      setValidating(false);
    }
  };

  const renderValidationResult = () => {
    if (!validationResult) return null;
    const { valid, error, method } = validationResult;
    if (valid) {
      return (
        <>
          <Badge variant="success">Valid</Badge>
          {method === "chat" && (
            <span className="text-sm text-text-muted">(via inference test)</span>
          )}
        </>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <Badge variant="error">Invalid</Badge>
        {error && <span className="text-sm text-red-500">{error}</span>}
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} title={config.title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <ProviderLogoField
          logo={formData.logo}
          onChange={(next) => setFormData({ ...formData, logo: next })}
        />
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={config.namePlaceholder}
          hint="A friendly label for this node"
        />
        <Input
          label="Prefix"
          value={formData.prefix}
          onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
          placeholder={config.prefixPlaceholder}
          hint="The provider prefix used in model IDs"
        />
        {config.hasApiType && (
          <Select
            label="API Type"
            options={API_TYPE_OPTIONS}
            value={formData.apiType}
            onChange={(e) => handleApiTypeChange(e.target.value)}
          />
        )}
        <Input
          label="Base URL"
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder={config.defaultBaseUrl}
          hint={config.baseUrlHint}
        />
        <Toggle
          checked={formData.quotaEnabled}
          onChange={(value) => setFormData({ ...formData, quotaEnabled: value })}
          label="Quota check"
          description="Read remaining credits from the standard /credits endpoint."
        />
        {formData.quotaEnabled && (
          <Input
            label="Quota path"
            value={formData.quotaPath}
            onChange={(e) => setFormData({ ...formData, quotaPath: e.target.value })}
            placeholder="/credits"
            hint='GET {Base URL}{Quota path} with Authorization: Bearer <API key>; response {"credits": 123.45}. Optional total/used drive the usage bar.'
          />
        )}
        <Input
          label="API Key (for Check)"
          type="password"
          value={checkKey}
          onChange={(e) => setCheckKey(e.target.value)}
        />
        <Input
          label="Model ID (optional)"
          value={checkModelId}
          onChange={(e) => setCheckModelId(e.target.value)}
          placeholder={config.modelIdPlaceholder}
          hint="If provider lacks /models endpoint, enter a model ID to validate via chat/completions instead."
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            onClick={handleValidate}
            disabled={!checkKey || validating || !formData.baseUrl.trim()}
            variant="secondary"
            className="w-full sm:w-auto"
          >
            {validating ? "Checking..." : "Check"}
          </Button>
          {renderValidationResult()}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            onClick={handleSubmit}
            fullWidth
            disabled={
              !formData.name.trim() ||
              !formData.prefix.trim() ||
              !formData.baseUrl.trim() ||
              submitting
            }
          >
            {submitting ? "Creating..." : "Create"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default AddCompatibleModal;
