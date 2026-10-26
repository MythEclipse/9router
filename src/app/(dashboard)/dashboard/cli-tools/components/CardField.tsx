"use client";

import BaseUrlSelect from "./BaseUrlSelect";

/**
 * Layout primitives for the CLI tool cards.
 *
 * Every tool card repeats the same label → arrow → control row, so the row shape
 * lives here once. `details` picks the third-column track, the only part that
 * genuinely varies between cards:
 * - "fill" → control takes the remaining width (plain selects/inputs)
 * - "auto" → extra trailing action column (e.g. a "Select" button)
 * - "top"  → control is multi-line, so align it to the top of the row
 */
const GRID_TRACKS = {
  fill: "sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2",
  auto: "sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2",
  top: "sm:grid-cols-[8rem_auto_1fr] sm:items-start sm:gap-2",
};

export function CardFieldRow({ label, details = "fill", children }) {
  return (
    <div className={`grid grid-cols-1 gap-1.5 ${GRID_TRACKS[details]}`}>
      <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">{label}</span>
      <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
      {children}
    </div>
  );
}

/** The "Select Endpoint" row every CLI tool card renders before its own controls. */
export function EndpointField({
  value,
  onChange,
  requiresExternalUrl = false,
  tunnelEnabled = false,
  tunnelPublicUrl = "",
  tailscaleEnabled = false,
  tailscaleUrl = "",
  currentUrl = "",
  cloudEnabled = false,
  cloudUrl = "",
  withV1 = true,
}) {
  return (
    <CardFieldRow label="Select Endpoint">
      <BaseUrlSelect
        value={value}
        onChange={onChange}
        requiresExternalUrl={requiresExternalUrl}
        tunnelEnabled={tunnelEnabled}
        tunnelPublicUrl={tunnelPublicUrl}
        tailscaleEnabled={tailscaleEnabled}
        tailscaleUrl={tailscaleUrl}
        currentUrl={currentUrl}
        cloudEnabled={cloudEnabled}
        cloudUrl={cloudUrl}
        withV1={withV1}
      />
    </CardFieldRow>
  );
}
