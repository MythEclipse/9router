/**
 * Settings repository — barrel.
 */

export {
	exportSettings,
	getCloudUrl,
	getSettings,
	invalidateSettingsCache,
	isCloudEnabled,
	mergeWithDefaults,
	updateSettings,
} from "./settingsAccess.ts"
export type {
	AutoPingSettings,
	CapacityAdapterEntry,
	ComboStrategy,
	CustomPluginSetting,
	MemorySettings,
	ProviderStrategy,
	Settings,
	SettingsUpdate,
} from "./settingsTypes.ts"
