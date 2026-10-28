/**
 * Shared usage helpers (cross-provider)
 */

import { PROVIDERS } from "../../providers/index.ts";
import { proxyAwareFetch } from "../../utils/proxyFetch.ts";
import type { ProxyOptions } from "../../types.ts";
import type { UsageConfig } from "../../providers/schema.ts";

/**
 * One quota row rendered by the dashboard's QuotaTable.
 *
 * `remainingPercentage` is a 0–100 percentage, NOT an absolute remainder —
 * several providers (Qoder credits, Grok) were burned by setting `remaining`
 * to a credit count and having the UI read it as a percentage.
 * `unlimited` marks rows with no upstream cap; providers that report a
 * remaining balance instead of a percentage also set `remaining`.
 */
export interface UsageQuotaRow {
  /** Row label, when the provider supplies one separately from the key. */
  name?: string;
  used: number;
  total: number;
  /** 0–100. See the note above: a percentage, never an absolute amount. */
  remainingPercentage?: number;
  /** Absolute remainder, for providers that report balances directly. */
  remaining?: number | null;
  resetAt?: string | null;
  unlimited?: boolean;
  /** Units for rows that are not request counts (e.g. "credits"). */
  unit?: string;
  /** True when the row is a usage percentage the UI should invert. */
  percentageIsUsed?: boolean;
  /** Extra provider-specific fields the UI passes through. */
  [key: string]: unknown;
}

/** A `key → quota row` map, as handed to the dashboard. */
export type UsageQuotaMap = Record<string, UsageQuotaRow>;

/** Free-form per-provider credential extras threaded into usage handlers. */
export type UsageProviderData = Record<string, unknown>;

// usage endpoints: single source from registry transport.usage
export const U = (id: string): UsageConfig => PROVIDERS[id]?.usage || {};

/**
 * Parse reset date/time to ISO string
 * Handles multiple formats: Unix timestamp (ms), ISO date string, etc.
 */
export function parseResetTime(resetValue) {
  if (!resetValue) return null;

  try {
    // If it's already a Date object
    if (resetValue instanceof Date) {
      return resetValue.toISOString();
    }

    // Unix timestamps from provider APIs may be seconds or milliseconds.
    if (typeof resetValue === 'number') {
      return new Date(resetValue < 1e12 ? resetValue * 1000 : resetValue).toISOString();
    }

    // If it's a numeric string, treat it like a Unix timestamp too.
    if (typeof resetValue === 'string') {
      if (/^\d+$/.test(resetValue)) {
        const timestamp = Number(resetValue);
        return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString();
      }
      return new Date(resetValue).toISOString();
    }

    return null;
  } catch (error) {
    console.warn(`Failed to parse reset time: ${resetValue}`, error);
    return null;
  }
}

export function toFiniteNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function normalizeCloudCodeProjectId(project) {
  if (typeof project === "string") return project.trim() || null;
  if (project && typeof project === "object" && typeof project.id === "string") {
    return project.id.trim() || null;
  }
  return null;
}

export async function fetchWithTimeout(
  url: string,
  opts: RequestInit,
  ms = 10000,
  proxyOptions: ProxyOptions | null = null,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    return await proxyAwareFetch(url, { ...opts, signal: controller.signal }, proxyOptions);
  } finally {
    clearTimeout(timeoutId);
  }
}
