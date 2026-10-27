/**
 * Limit presentation for the endpoint page's key editor.
 *
 * A key's budget can be expressed in tokens, money or request count, and each has
 * its own unit, label and help text. That mapping was inline in an 1,800-line
 * component, where the three cases were interleaved across five separate functions —
 * which is how a cost cap ended up phrased like a token cap.
 */
import type { LimitKind } from "@/lib/usage/keyBudget";

/**
 * A compact token count: `1.00B`, `2.50M`, `12.3K`, `1,234`.
 *
 * Two decimals at B/M so a budget of 1,500,000 reads as 1.50M rather than 1.5M —
 * these numbers are typed by hand into a limit field and must read back exactly.
 */
export function formatTokensNumber(num: number | null | undefined): string {
  const n = Number(num) || 0;
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}

/** A cap or usage value rendered in the unit of its kind. */
export function formatLimitValue(kind: LimitKind | string, value: number | string | null | undefined): string {
  const n = Number(value) || 0;
  if (kind === "cost") return `$${n.toFixed(2)}`;
  if (kind === "requests") return `${n.toLocaleString()} req`;
  return `${formatTokensNumber(n)} tokens`;
}

/** The label of the limit input for a kind. */
export function limitFieldLabel(kind: LimitKind | string): string {
  if (kind === "cost") return "Cost Limit (USD)";
  if (kind === "requests") return "Request Limit";
  return "Token Limit";
}

/** A representative value, so the empty field hints at the expected magnitude. */
export function limitPlaceholder(kind: LimitKind | string): string {
  if (kind === "cost") return "2.50";
  if (kind === "requests") return "1000";
  return "e.g. 88000000";
}

/**
 * The help text under the limit field.
 *
 * One number whose meaning changes with the kind, so the hint has to state the unit's
 * own rule instead of a generic "0 means unlimited": a token cap and a request cap are
 * counted per window, while a cost cap is counted per UTC day and priced per request.
 *
 * `creatorTokenLimit` caps what a key *creator* may grant, and is appended only when
 * it is a real ceiling — a zero means no ceiling and must not print "maximum is 0".
 */
export function limitHint(kind: LimitKind | string, creatorTokenLimit = 0): string {
  if (kind === "cost") {
    return "Charges every call at the model's price and adds it up in USD, so the same amount of text costs more on an expensive model. Once today's total (UTC) passes this amount the key answers 429 until 00:00 UTC. 0 = unlimited.";
  }
  if (kind === "requests") {
    return "Counts calls, not size: one call is one request however many tokens it spends, so a huge prompt counts the same as a tiny one. Once the count is reached the key answers 429 until the window resets. 0 = unlimited.";
  }
  const base =
    "Adds up prompt and completion tokens across the reset window, so a long conversation costs more than a short one. When the total is used up the key answers 429 until the window resets. 0 = unlimited.";
  return creatorTokenLimit > 0
    ? `${base} Your maximum is ${creatorTokenLimit.toLocaleString()} tokens.`
    : base;
}
