/**
 * Qoder context-window tiers.
 *
 * Each Qoder model_config ships a `context_config` list (e.g. 200K / 400K / 1M for
 * qmodel_38max) while `max_input_tokens` only carries the tier the IDE currently has
 * selected (~180K by default). The Qoder IDE lets the user switch tiers from the model
 * picker; a qodercli-style client (which is what 9router impersonates) has no picker,
 * so a long Claude-Code / Codex session that grew past the default tier is rejected
 * upstream even though the model itself supports 1M.
 *
 * This module emulates the IDE: estimate the prompt size, pick the smallest advertised
 * tier that fits (never below the model's current default), and mirror the choice into
 * the same three places the IDE writes:
 *   parameters.context_length
 *   chat_context.extra.ideModelConfigOverride.max_input_tokens
 *   model_config.max_input_tokens
 *
 * Override with QODER_CONTEXT_TIER = auto (default) | max | default | <tier name, e.g. 1M>.
 * Pure functions, no I/O - the executor wires them into buildQoderRequestBody.
 */

import { QODER_CONTEXT_TIER_HEADROOM, QODER_CONTEXT_TIER_MODES } from "./constants";

const UNIT: Record<string, number> = { K: 1_000, M: 1_000_000 };

/** A raw `context_config` entry as it arrives from Qoder (snake_case or camelCase). */
export type QoderContextConfigEntry = {
  /** Tier label candidates, in precedence order. */
  name?: string;
  label?: string;
  display_name?: string;
  displayName?: string;
  key?: string;
  id?: string;
  /** Token-count candidates, in precedence order. */
  tokenCount?: number | string;
  token_count?: number | string;
  max_input_tokens?: number | string;
  maxInputTokens?: number | string;
  contextLength?: number | string;
  context_length?: number | string;
  /** Default-tier flags, in precedence order. */
  isDefault?: boolean;
  is_default?: boolean;
  default?: boolean;
  [key: string]: unknown;
};

/** A raw Qoder `model_config`: the tier list plus the currently-selected size. */
export type QoderModelConfig = {
  context_config?: QoderContextConfigEntry[] | null;
  contextConfig?: QoderContextConfigEntry[] | null;
  max_input_tokens?: number | string;
  maxInputTokens?: number | string;
  [key: string]: unknown;
};

/** A normalized tier, ascending by `tokenCount`. */
export type QoderContextTier = {
  name: string;
  tokenCount: number;
  isDefault: boolean;
};

/** "200K" | "1M" | "204800" | 204800 → integer token count (0 when unparseable). */
export function parseTierTokenCount(value: number | string | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (typeof value !== "string") return 0;
  const m = value.trim().toUpperCase().match(/^(\d+(?:\.\d+)?)\s*([KM])?$/);
  if (!m) return 0;
  const n = Number(m[1]) * (UNIT[m[2]] || 1);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function tierName(entry: QoderContextConfigEntry, tokenCount: number): string {
  const raw = entry.name ?? entry.label ?? entry.display_name ?? entry.displayName ?? entry.key ?? entry.id;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (tokenCount >= UNIT.M && tokenCount % UNIT.M === 0) return `${tokenCount / UNIT.M}M`;
  if (tokenCount >= UNIT.K && tokenCount % UNIT.K === 0) return `${tokenCount / UNIT.K}K`;
  return String(tokenCount);
}

/**
 * Normalize a model_config into sorted tiers: [{ name, tokenCount, isDefault }] ascending.
 * Accepts snake_case and camelCase shapes; returns [] when the model has no tiers.
 */
export function getQoderContextTiers(modelConfig: QoderModelConfig | null | undefined): QoderContextTier[] {
  const list = modelConfig?.context_config ?? modelConfig?.contextConfig;
  if (!Array.isArray(list)) return [];
  const byCount = new Map<number, QoderContextTier>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const tokenCount = parseTierTokenCount(
      entry.tokenCount ?? entry.token_count ?? entry.max_input_tokens ?? entry.maxInputTokens ?? entry.contextLength ?? entry.context_length,
    );
    if (!tokenCount) continue;
    const isDefault = entry.isDefault === true || entry.is_default === true || entry.default === true;
    const prev = byCount.get(tokenCount);
    byCount.set(tokenCount, {
      name: tierName(entry, tokenCount),
      tokenCount,
      isDefault: (prev?.isDefault || false) || isDefault,
    });
  }
  return [...byCount.values()].sort((a, b) => a.tokenCount - b.tokenCount);
}

const CJK_RE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

/**
 * Rough prompt-size estimate in tokens. CJK characters count ~1 token each, everything
 * else ~4 chars/token - the plain chars/4 rule underestimates Chinese/Japanese by up to
 * 4x, which is exactly when a tier decision matters.
 */
/** Anything JSON-serializable that makes up the outgoing prompt. */
export type QoderPromptShape = {
  system?: string | QoderPromptBlock[] | null;
  messages?: QoderPromptBlock[] | null;
  tools?: QoderPromptBlock[] | null;
  [key: string]: unknown;
};

/** One block of a prompt (system part, message, or tool definition). */
export type QoderPromptBlock = {
  role?: string;
  content?: string | QoderPromptBlock[] | null;
  text?: string;
  [key: string]: unknown;
};

export function estimateQoderPromptTokens({ system, messages, tools }: QoderPromptShape = {}): number {
  let text = "";
  try {
    text = JSON.stringify({ system: system || "", messages: messages || [], tools: tools || [] }) || "";
  } catch {
    return 0;
  }
  const cjk = (text.match(CJK_RE) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

function normalizeMode(preference: string | null | undefined): string {
  const p = String(preference ?? "").trim();
  return p ? p : QODER_CONTEXT_TIER_MODES.AUTO;
}

function findNamedTier(tiers: QoderContextTier[], name: string): QoderContextTier | null {
  const wanted = name.replace(/\s+/g, "").toUpperCase();
  const asCount = parseTierTokenCount(wanted);
  return tiers.find((t) => t.name.replace(/\s+/g, "").toUpperCase() === wanted || (asCount && t.tokenCount === asCount)) || null;
}

/** The outcome of a tier decision: which tier to use, and why. */
export type QoderTierDecision = {
  tier: QoderContextTier;
  estimatedTokens: number;
  reason: string;
};

/**
 * Decide which tier a request should run under.
 *
 * @param modelConfig raw Qoder model_config (has context_config + max_input_tokens)
 * @param prompt what will be sent
 * @param options preference mode + sizing headroom
 * @returns null → leave the payload exactly as before (no tiers, or the default already fits).
 */
export function resolveQoderContextTier(
  modelConfig: QoderModelConfig | null | undefined,
  prompt: QoderPromptShape,
  options: { preference?: string; headroom?: number } = {},
): QoderTierDecision | null {
  const tiers = getQoderContextTiers(modelConfig);
  if (!tiers.length) return null;

  const mode = normalizeMode(options.preference);
  const largest = tiers[tiers.length - 1];
  const defaultTier = tiers.find((t) => t.isDefault) || tiers[0];
  const estimatedTokens = estimateQoderPromptTokens(prompt);
  const headroom = typeof options.headroom === "number" ? options.headroom : QODER_CONTEXT_TIER_HEADROOM;
  const need = Math.ceil(estimatedTokens * (1 + headroom));

  if (mode.toLowerCase() === QODER_CONTEXT_TIER_MODES.MAX) {
    return { tier: largest, estimatedTokens, reason: "forced:max" };
  }
  if (mode.toLowerCase() === QODER_CONTEXT_TIER_MODES.DEFAULT) {
    return { tier: defaultTier, estimatedTokens, reason: "forced:default" };
  }
  if (mode.toLowerCase() !== QODER_CONTEXT_TIER_MODES.AUTO) {
    const named = findNamedTier(tiers, mode);
    if (named) return { tier: named, estimatedTokens, reason: `forced:${named.name}` };
    // Unknown tier name → fall through to auto rather than silently breaking requests.
  }

  // auto: keep the upstream default (current behaviour) while the prompt fits in it.
  const currentMax = parseTierTokenCount(modelConfig?.max_input_tokens ?? modelConfig?.maxInputTokens);
  const currentLimit = currentMax || defaultTier.tokenCount;
  if (need <= currentLimit) return null;

  const fits = tiers.find((t) => t.tokenCount >= need && t.tokenCount > currentLimit);
  const tier = fits || largest;
  if (tier.tokenCount <= currentLimit) return null; // nothing bigger to escalate to
  return { tier, estimatedTokens, reason: fits ? "auto:fits" : "auto:largest" };
}

/**
 * Write the chosen tier into a Qoder chat payload (mutates + returns it).
 * Mirrors the IDE: parameters.context_length, ideModelConfigOverride, model_config.
 */
/** The subset of a Qoder chat payload that `applyQoderContextTier` rewrites. */
export type QoderTierPayload = {
  parameters?: { context_length?: number | string; [key: string]: unknown } | null;
  chat_context?: {
    extra?: {
      ideModelConfigOverride?: { max_input_tokens?: number | string; [key: string]: unknown };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  } | null;
  model_config?: { max_input_tokens?: number | string; [key: string]: unknown } | null;
  [key: string]: unknown;
};

export function applyQoderContextTier<T extends QoderTierPayload>(payload: T | null | undefined, tier: QoderContextTier | null | undefined): T | null | undefined {
  if (!payload || !tier?.tokenCount) return payload;
  payload.parameters = { ...(payload.parameters || {}), context_length: tier.tokenCount };
  payload.chat_context = payload.chat_context || {};
  payload.chat_context.extra = {
    ...(payload.chat_context.extra || {}),
    ideModelConfigOverride: {
      ...(payload.chat_context.extra?.ideModelConfigOverride || {}),
      max_input_tokens: tier.tokenCount,
    },
  };
  if (payload.model_config && typeof payload.model_config === "object") {
    payload.model_config = { ...payload.model_config, max_input_tokens: tier.tokenCount };
  }
  return payload;
}
