/**
 * The budget contract for an API key.
 *
 * A key has one budget, and its owner picks which quantity it counts:
 *
 *   - `tokens`   — prompt + completion tokens summed over the reset window.
 *   - `cost`     — USD charged per call, summed over the current UTC day.
 *   - `requests` — call count over the reset window, ignoring size.
 *
 * All three caps stay stored at once so switching between them does not lose the
 * numbers. Every reader (the keys table, the usage report, the limit editor) has
 * to answer the same two questions: *which quantity is this key counting*, and
 * *how much of it is spent*. Answering them ad hoc is what let the dashboard and
 * the usage API disagree about a key's remaining room — they each re-derived the
 * `costDay` staleness rule and the kind fallback by hand, so a key whose cost
 * stamp was a day old showed yesterday's total in one view and zero in another.
 *
 * This module exists so there is exactly one place that answers both questions.
 */

/** The quantity a key's budget counts. */
export type LimitKind = "tokens" | "cost" | "requests";

/** The fields of an API key this module reads. Unknown keys are tolerated. */
export interface BudgetSubject {
  limitKind?: unknown;
  tokenLimit?: unknown;
  dailyCostLimit?: unknown;
  requestLimit?: unknown;
  usedTokens?: unknown;
  usedRequests?: unknown;
  costSpent?: unknown;
  costDay?: unknown;
}

/**
 * The selected budget kind, defaulting to `tokens`.
 *
 * The column is free text, so a row written by an older client can carry a value
 * this build no longer knows. Unknown kinds fall back to `tokens` rather than
 * showing a key as unlimited just because its kind was misspelled.
 */
export function limitKindOf(key: BudgetSubject | null | undefined): LimitKind {
  const kind = key?.limitKind;
  return kind === "cost" || kind === "requests" ? kind : "tokens";
}

/**
 * The USD spent today.
 *
 * `costSpent` is stamped with the UTC day it belongs to, so a stale stamp means
 * nothing has been spent today — showing the raw counter would keep yesterday's
 * total on screen until the next charge.
 */
export function spentTodayOf(key: BudgetSubject | null | undefined, today = todayKey()): number {
  return key?.costDay === today ? Number(key?.costSpent) || 0 : 0;
}

/** The current UTC day as `YYYY-MM-DD`, the format `costDay` is stamped with. */
export function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The cap for a kind.
 *
 * `tokens` reads the cap the caller passes in rather than `key.tokenLimit` so a
 * reader can substitute the value it already resolved — the usage report takes
 * `Math.max(usedTokensColumn, usageHistoryWindowSum)` as its token cap input and
 * must not have that pre-resolved value silently replaced.
 */
export function limitCapOf(key: BudgetSubject | null | undefined, kind = limitKindOf(key), tokenCap?: number): number {
  if (kind === "cost") return Number(key?.dailyCostLimit) || 0;
  if (kind === "requests") return Number(key?.requestLimit) || 0;
  return Number(tokenCap ?? key?.tokenLimit) || 0;
}

/** How much of the cap the key has already spent, in the same unit as the cap. */
export function limitUsedOf(
  key: BudgetSubject | null | undefined,
  kind = limitKindOf(key),
  tokenUsed?: number,
  today = todayKey()
): number {
  if (kind === "cost") return spentTodayOf(key, today);
  if (kind === "requests") return Number(key?.usedRequests) || 0;
  return Number(tokenUsed ?? key?.usedTokens) || 0;
}

/** A cap of zero means the owner set no limit. */
export function isUnlimited(cap: number): boolean {
  return cap <= 0;
}

/** Progress through the budget in `[0, 1]`, or `0` when nothing is capped. */
export function budgetFraction(cap: number, used: number): number {
  if (isUnlimited(cap)) return 0;
  return Math.min(1, used / cap);
}

/**
 * Whether the key has run out of room.
 *
 * A cap of zero means unlimited, so it is never exhausted however much is spent.
 */
export function isExhausted(cap: number, used: number): boolean {
  return cap > 0 && used >= cap;
}

/** The three numbers a reader needs to render a key's budget. */
export interface BudgetSnapshot {
  kind: LimitKind;
  cap: number;
  used: number;
  exhausted: boolean;
  fraction: number;
}

/**
 * Resolve a key's budget in one pass.
 *
 * `tokenCap`/`tokenUsed` override the token columns for readers that resolved
 * them from a second source (see {@link limitCapOf}).
 */
export function budgetOf(
  key: BudgetSubject | null | undefined,
  options: { tokenCap?: number; tokenUsed?: number; today?: string } = {}
): BudgetSnapshot {
  const kind = limitKindOf(key);
  const cap = limitCapOf(key, kind, options.tokenCap);
  const used = limitUsedOf(key, kind, options.tokenUsed, options.today);
  return { kind, cap, used, exhausted: isExhausted(cap, used), fraction: budgetFraction(cap, used) };
}
