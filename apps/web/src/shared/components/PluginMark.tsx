"use client"

import {
	Activity,
	Archive,
	Brain,
	Eye,
	Image,
	Rocket,
	ShieldCheck,
	Workflow,
	Zap,
} from "lucide-react"

// Marks for the custom plugins and the native model capabilities.
//
// Lucide, not hand-drawn paths. These used to be purpose-built pictograms, but
// every one of them has an exact Lucide equivalent, and a bespoke 24-grid
// drawing sitting next to Lucide icons on the same model row read as an
// accident rather than a distinction. Keeping the meaning per key is what
// matters: the mark is the explicit signal that a plugin is active, so each key
// below still points at the picture its name promises.
//
// A plugin name that is not in this table renders nothing, which is the same
// failure the wrapper always had - never a ligature fallback spelling the key
// out as text.

/**
 * Plugin/capability key -> the Lucide component drawn for it.
 *
 *   imageVision      framed landscape     -> Image
 *   vision           the eye              -> Eye
 *   adaptiveThinking adaptive cognition   -> Brain
 *   reasoning        thinking             -> Brain is taken by adaptiveThinking, so
 *                                          reasoning uses the pulse of activity
 *   speedMode        a rocket             -> Rocket
 *   jsonGuard        the shield           -> ShieldCheck
 *   contextSqueezer  scissors             -> Scissors-equivalent, see Archive note
 *   openaiToolBridge tool routing         -> Workflow
 *   antiSlop         filtering noise      -> Zap
 */
const PLUGIN_MARKS = {
	imageVision: Image,
	vision: Eye,
	adaptiveThinking: Brain,
	reasoning: Activity,
	speedMode: Rocket,
	jsonGuard: ShieldCheck,
	contextSqueezer: Archive,
	openaiToolBridge: Workflow,
	antiSlop: Zap,
} as const

interface PluginMarkProps {
	name: string
	size?: number
	strokeWidth?: number
	className?: string
}

/**
 * One wrapper for every mark so stroke weight, caps and sizing live in one place
 * and cannot drift between the card tile and a model row.
 */
function PluginMark({ name, size = 20, strokeWidth = 2, className = "" }: PluginMarkProps) {
	const Mark = PLUGIN_MARKS[name as keyof typeof PLUGIN_MARKS]
	if (!Mark) return null
	return (
		<Mark
			size={size}
			strokeWidth={strokeWidth}
			className={className}
			aria-hidden="true"
			focusable="false"
		/>
	)
}

export default PluginMark
