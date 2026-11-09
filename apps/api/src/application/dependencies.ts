/** Use-case dependency container. (Ports in `dependencies-ports.ts`, slices in
 * `dependencies-core.ts` / `dependencies-extra.ts`.) */
import type { DependenciesCore } from "./dependencies-core.ts"
import type { DependenciesExtra } from "./dependencies-extra.ts"

export type { DependenciesCore } from "./dependencies-core.ts"
export type { DependenciesExtra } from "./dependencies-extra.ts"
export type {
	ComboInput,
	ComboPort,
	ComboPresetItem,
	ComboPresetPort,
	ComboRotationPort,
	ComboStrategyPort,
	ComboView,
	ErrorLogEntry,
	ErrorLogPort,
	IActivityRepository,
	OverrideStore,
	PricingMap,
	PricingPort,
	StudioTarget,
	StudioTargetPort,
} from "./dependencies-ports.ts"
export type Dependencies = DependenciesCore & DependenciesExtra
