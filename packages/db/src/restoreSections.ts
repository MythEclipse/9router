/**
 * Restoring a database backup, one section at a time — barrel.
 *
 * Entries live in restoreSectionsA/B/C.ts; types in restoreTypes.ts.
 * This file keeps the public `SECTION_RESTORES` list and the payload helpers.
 */

import { providersSection, settingsSection } from "./restoreSectionsA.ts"
import { apiKeysSection, combosSection, usageSection } from "./restoreSectionsB.ts"
import { autoBackupSection, customModelsSection, pricingSection } from "./restoreSectionsC.ts"

import type { RestoreContext, RestoreDb, SectionRestore } from "./restoreTypes.ts"

export type { RestoreContext, RestoreDb, SectionRestore } from "./restoreTypes.ts"

export const SECTION_RESTORES: readonly import("./restoreTypes.ts").SectionRestore[] = [
	settingsSection,
	providersSection,
	apiKeysSection,
	combosSection,
	usageSection,
	customModelsSection,
	pricingSection,
	autoBackupSection,
]

export function payloadHasSection(
	payload: Record<string, unknown>,
	section: SectionRestore,
): boolean {
	return section.sectionKeys.some((key) => payload[key] !== undefined)
}

/** The sections a payload actually carries, in restore order. */
export function sectionsPresent(payload: Record<string, unknown>): SectionRestore[] {
	return SECTION_RESTORES.filter((section) => payloadHasSection(payload, section))
}

/** Reject anything that is not a backup object before it reaches the writers. */
export function assertValidPayload(payload: unknown): asserts payload is Record<string, unknown> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Invalid database payload")
	}
}
