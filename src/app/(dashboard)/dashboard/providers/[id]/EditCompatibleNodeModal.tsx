"use client";

import { useState, useEffect } from "react";
import ProviderLogoField from "@/shared/components/ProviderLogoField";
import { Button, Badge, Input, Modal, Select, Toggle } from "@/shared/components";


// Identity of the node being edited: a different node means a different form.
export function editCompatibleNodeModalKey(node?: { id?: string } | null): string {
  return node?.id ? `edit-compatible-node:${node.id}` : "edit-compatible-node:new";
}

interface EditCompatibleNodeModalProps {
  isOpen: boolean
  node?: {
    id?: string
    name?: string
    prefix?: string
    apiType?: string
    baseUrl?: string
    logo?: string
    quotaEnabled?: boolean
    quotaPath?: string
  }
  onSave(...args: unknown[]): unknown
  onClose(...args: unknown[]): unknown
  isAnthropic?: boolean
}

interface EditCompatibleFormData {
  name: string;
  prefix: string;
  apiType: string;
  baseUrl: string;
  logo: string;
  quotaEnabled: boolean;
  quotaPath: string;
}

export default function EditCompatibleNodeModal({ isOpen, node, onSave, onClose, isAnthropic }: EditCompatibleNodeModalProps) {
  // The form is seeded from `node` as its initial value, and the caller mounts it
  // under a key naming that node, so switching nodes mounts a form already built
  // from the new one instead of an effect copying props into state after render.
  const [formData, setFormData] = useState<EditCompatibleFormData>(() => ({
    name: node?.name || "",
    prefix: node?.prefix || "",
    apiType: node?.apiType || "chat",
    baseUrl: node?.baseUrl || (isAnthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"),
    logo: node?.logo || "",
    quotaEnabled: node?.quotaEnabled === true,
    quotaPath: node?.quotaPath || "/credits",
  }));
  const [saving, setSaving] = useState(false);
  const [checkKey, setCheckKey] = useState("");
  const [checkModelId, setCheckModelId] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);

  const apiTypeOptions = [
    { value: "chat", label: "Chat Completions" },
    { value: "responses", label: "Responses API" },
  ];

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim()) return;
    setSaving(true);
    try {
      const payload: {
        name: string;
        prefix: string;
        baseUrl: string;
        logo: string;
        quotaEnabled: boolean;
        quotaPath: string;
        apiType?: string;
      } = {
        name: formData.name,
        prefix: formData.prefix,
        baseUrl: formData.baseUrl,
        logo: formData.logo,
        quotaEnabled: formData.quotaEnabled,
        quotaPath: formData.quotaPath,

      };
      if (!isAnthropic) {
        payload.apiType = formData.apiType;
      }
      await onSave(payload);
    } finally {
      setSaving(false);
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
          type: isAnthropic ? "anthropic-compatible" : "openai-compatible",
          modelId: checkModelId.trim() || undefined
        }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  if (!node) return null;

  return (
    <Modal isOpen={isOpen} title={`Edit ${isAnthropic ? "Anthropic" : "OpenAI"} Compatible`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <ProviderLogoField
          logo={formData.logo}
          onChange={(next) => setFormData((prev) => ({ ...prev, logo: next }))}
        />
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={`${isAnthropic ? "Anthropic" : "OpenAI"} Compatible (Prod)`}
          hint="A friendly label for this node"
        />
        <Input
          label="Prefix"
          value={formData.prefix}
          onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
          placeholder={isAnthropic ? "ac-prod" : "oc-prod"}
          hint="The provider prefix used in model IDs"
        />
        {!isAnthropic && (
          <Select
            label="API Type"
            options={apiTypeOptions}
            value={formData.apiType}
            onChange={(e) => setFormData({ ...formData, apiType: e.target.value })}
          />
        )}
        <Input
          label="Base URL"
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder={isAnthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"}
          hint={`Use the base URL (ending in /v1) for your ${isAnthropic ? "Anthropic" : "OpenAI"}-compatible API.`}
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
        <div className="flex gap-2">
          <Input
            label="API Key (for Check)"
            type="password"
            value={checkKey}
            onChange={(e) => setCheckKey(e.target.value)}
            className="flex-1"
          />
          <div className="pt-6">
            <Button onClick={handleValidate} disabled={!checkKey || validating || !formData.baseUrl.trim()} variant="secondary">
              {validating ? "Checking..." : "Check"}
            </Button>
          </div>
        </div>
        <Input
          label="Model ID (optional)"
          value={checkModelId}
          onChange={(e) => setCheckModelId(e.target.value)}
          placeholder="e.g. my-model-id"
          hint="If provider lacks /models endpoint, enter a model ID to validate via chat/completions instead."
        />
        {validationResult && (
          <Badge variant={validationResult === "success" ? "success" : "error"}>
            {validationResult === "success" ? "Valid" : "Invalid"}
          </Badge>
        )}
        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim() || saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

