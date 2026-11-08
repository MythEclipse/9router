"use client"

import type { ComponentType, CSSProperties, SVGProps } from "react"
import { ICON_REGISTRY, type IconName } from "./iconRegistry"

/**
 * The one icon surface of the dashboard, drawn with Lucide.
 *
 * Icon names live in data here, not in markup: Sidebar nav entries, tool cards,
 * feature tiles and changelog categories all carry an `icon: "grid_view"`
 * literal, and several components render whichever name a prop or a row holds.
 * Importing a Lucide component at each call site would force every one of those
 * tables and prop contracts to change; a single name table keeps them intact and
 * leaves exactly one place to audit the mapping (iconRegistry.ts).
 *
 * An unknown name renders nothing on purpose. A blank slot is visible in
 * review; the icon font this replaced would paint the literal word
 * ("grid_view") into the layout whenever a name was missing from its subset.
 *
 * Sizing is px, not font-size - Lucide draws on a 24-unit grid:
 * `<Icon name="close" size={16} />`.
 */
type Glyph = ComponentType<
	SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number }
>

export type { IconName }

type CamelCase<S extends string> = S extends `${infer H}_${infer T}`
	? `${H}${Capitalize<CamelCase<T>>}`
	: S

/** camelCase alias of every name: `<Icon name={ICON_NAMES.checkCircle} />`. */
export const ICON_NAMES = Object.keys(ICON_REGISTRY).reduce(
	(acc, name) => {
		const camel = name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
		acc[camel] = name as IconName
		return acc
	},
	{} as Record<string, IconName>,
) as Record<CamelCase<IconName>, IconName>

interface IconProps {
	/**
	 * Material Symbols name. Typed permissively because several call sites pass
	 * a value straight from data (`{option.icon}`), and some of those fields are
	 * declared ReactNode; anything that is not a known string renders nothing.
	 */
	name: unknown
	/** Square size in px. */
	size?: number
	/** Solid variant - the "selected nav item" look the font got from fill-1. */
	filled?: boolean
	strokeWidth?: number
	className?: string
	style?: CSSProperties
	title?: string
}

/**
 * Keeps Lucide's 2-units-at-24px weight at normal sizes, but softens it on
 * small icons where a full 2 reads as a smear, and thins it on very large ones
 * where it reads as a heavy frame.
 */
function strokeFor(size?: number, override?: number) {
	if (override != null) return override
	if (!size) return 2
	return Math.min(2, Math.max(1.5, (size / 24) * 2))
}

export default function Icon({
	name,
	size,
	filled = false,
	strokeWidth,
	className = "",
	style,
	title,
}: IconProps) {
	const Glyph =
		typeof name === "string" && name in ICON_REGISTRY
			? (ICON_REGISTRY[name as IconName] as Glyph)
			: undefined
	if (!Glyph) return null
	const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true as const }
	return (
		<Glyph
			{...a11y}
			{...(title ? { title } : {})}
			size={size}
			strokeWidth={strokeFor(size, strokeWidth)}
			// Solid icons read as "active"; everything else stays an outline.
			fill={filled ? "currentColor" : "none"}
			// align-middle keeps the icon centred on a text baseline, which is what
			// the icon-font glyphs did; shrink-0 stops flex rows from squashing it
			// into an ellipse.
			className={`inline-block shrink-0 align-middle ${className}`.trim()}
			style={style}
		/>
	)
}
