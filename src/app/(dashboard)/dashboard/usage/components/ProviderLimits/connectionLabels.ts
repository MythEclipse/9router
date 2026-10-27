/**
 * Presentation helpers for the quota tracker.
 *
 * These are pure functions of a connection or quota object, and they were sitting
 * in the middle of a 1,700-line component with no test at all — which is how the
 * region fallback and the grant-status ordering drifted without anyone noticing.
 * Keeping them here makes each rule assertable without a DOM.
 */

/** Kiro auth method → the label the card shows. */
export const KIRO_METHOD_LABELS: Record<string, string> = {
  "builder-id": "AWS Builder ID",
  idc: "IAM Identity Center",
  google: "Google",
  github: "GitHub",
  imported: "Imported Token",
  api_key: "API Key",
};

/** Kiro's auth method label, falling back to the auth type. */
export function kiroMethodLabel(conn: any): string {
  const method = conn?.providerSpecificData?.authMethod;
  if (method && KIRO_METHOD_LABELS[method]) return KIRO_METHOD_LABELS[method];
  return conn?.authType === "api_key" ? "API Key" : "OAuth";
}

/**
 * The second line under a connection's name.
 *
 * Only shown when it adds something: a connection whose name already equals its
 * email (or display name) would otherwise print the same string twice.
 */
export function getConnectionSecondaryLabel(connection: any): string | null {
  const name = connection?.name?.trim();
  if (name) {
    const email = connection?.email?.trim();
    if (email && name !== email) return email;
    const displayName = connection?.displayName?.trim();
    if (displayName && name !== displayName) return displayName;
  }
  return null;
}

/**
 * The Kiro region.
 *
 * Stored explicitly for the builder-id/idc/api_key flows; the social and imported
 * flows omit it, so fall back to the region segment of the profile ARN
 * (`arn:aws:codewhisperer:<region>:...`).
 */
export function kiroRegion(conn: any): string {
  const region = conn?.providerSpecificData?.region;
  if (region) return region;
  const arn = conn?.providerSpecificData?.profileArn;
  const segment = typeof arn === "string" ? arn.split(":")[3] : "";
  return segment || "";
}

/** Codex reset credits, clamped to a non-negative integer. */
export function getCodexResetCreditCount(quota: any): number {
  const value = quota?.raw?.resetCredits?.availableCount;
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

/** Claude reset-limit id → the name shown in "Clears ..." copy. */
export const CLAUDE_RESET_LIMIT_NAMES: Record<string, string> = {
  five_hour: "session",
  seven_day: "weekly",
  seven_day_overage_included: "weekly",
  seven_day_opus: "Opus weekly",
  seven_day_sonnet: "Sonnet weekly",
};

/**
 * Describe which limits a Claude reset clears, e.g. "session + weekly limits".
 * Duplicate names (the three `seven_day_*` variants all read "weekly") collapse.
 */
export function formatClaudeResetClears(clears: string[] | null | undefined): string {
  const names = [
    ...new Set((clears || []).map((c) => CLAUDE_RESET_LIMIT_NAMES[c]).filter(Boolean)),
  ];
  return names.length ? `${names.join(" + ")} limits` : "limits";
}

/**
 * Claude grant status, in priority order.
 *
 * The order is the contract: a grant with no resets left reads "used" even if it
 * is also paused, and an expired end date outranks "usable now".
 */
export function claudeGrantStatus(grant: any): string {
  if (grant?.resetsLeft <= 0) return "used";
  if (grant?.paused) return "paused";
  if (grant?.endsAt && new Date(grant.endsAt).getTime() <= Date.now()) return "expired";
  if (grant?.usableNow) return "usable now";
  if (grant?.startsAt && new Date(grant.startsAt).getTime() > Date.now()) return "not started";
  return grant?.useRequiresLimit ? "at limit only" : "unavailable";
}

/** The provider's display name: a per-connection node name wins over the catalog. */
export function providerLabel(
  providerId: string,
  connection?: { providerSpecificData?: { nodeName?: string } },
  catalog?: Record<string, { name?: string }>
): string {
  return connection?.providerSpecificData?.nodeName || catalog?.[providerId]?.name || providerId;
}

/** A credit's expiry date, or "N/A" when absent or unparseable. */
export function formatCreditDate(value: unknown): string {
  if (!value) return "N/A";
  const date = new Date(value as string);
  if (!Number.isFinite(date.getTime())) return "N/A";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Time until a timestamp, rounded up to whole hours, e.g. "2d 3h".
 *
 * Rounds up rather than down so a credit with 30 minutes left reads "1h" instead
 * of "0h", which looked like it had already expired.
 */
export function formatTimeRemaining(value: unknown, now = Date.now()): string {
  if (!value) return "N/A";
  const diffMs = new Date(value as string).getTime() - now;
  if (!Number.isFinite(diffMs)) return "N/A";
  if (diffMs <= 0) return "Expired";
  const totalHours = Math.ceil(diffMs / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}
