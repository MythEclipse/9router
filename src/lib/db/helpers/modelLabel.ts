/**
 * The model-name contract for a stored usage row.
 *
 * A row carries two names, and they live in different columns:
 *
 *   - `model`  — the name the caller asked for. A combo survives here, so this
 *                value is an alias, not necessarily a model that exists.
 *   - `meta`   — a JSON blob whose `resolvedModel` is the upstream that actually
 *                served the call.
 *
 * Every reader has to answer the same two questions: *what should this row be
 * labelled with*, and *was that label an alias*. Answering them ad hoc is what
 * let the dashboard flip between the real model and the combo name: four readers
 * each resolved the alias themselves and one of them forgot to select `meta` at
 * all, so it silently labelled rows with the combo. This module exists so there
 * is exactly one place that answers both questions.
 */

import { parseJson } from "../helpers/jsonCol.ts";

/** The columns a reader must select for {@link resolvedModelOf} to see the alias. */
export const MODEL_NAME_COLUMNS = "model, meta";

/**
 * The upstream that served a row, or `null` when the row was not routed through
 * an alias (a direct model call, or a lifecycle row written before the alias was
 * recorded).
 */
export function resolvedModelOf(metaColumn: unknown): string | null {
  const meta = parseJson<Record<string, unknown>>(metaColumn as string | null, {});
  const resolved = meta?.resolvedModel;
  return typeof resolved === "string" && resolved ? resolved : null;
}

/** How a row should be labelled, and what the label hides. */
export interface ModelLabel {
  /** The model to display: the real one when known, else the requested name. */
  display: string;
  /** The requested name, only when it differs from {@link display}. */
  alias: string | undefined;
}

/**
 * Label a row whose real model has already been resolved (the in-memory ring
 * stores the pair as fields rather than a `meta` blob).
 */
export function labelForResolved(requestedModel: unknown, resolvedModel: unknown): ModelLabel {
  const requested = String(requestedModel ?? "");
  const resolved = typeof resolvedModel === "string" && resolvedModel ? resolvedModel : null;
  if (!resolved) return { display: requested, alias: undefined };
  // An alias identical to the display name is noise: the UI would print
  // "same ← same". Treat it as no alias at all.
  const alias = requested && requested !== resolved ? requested : undefined;
  return { display: resolved, alias };
}

/**
 * Label a usage row read straight from the table. The real model leads; the
 * requested name is kept beside it so a reader can still tell a combo was
 * involved.
 */
export function labelForRow(requestedModel: unknown, metaColumn: unknown): ModelLabel {
  return labelForResolved(requestedModel, resolvedModelOf(metaColumn));
}
