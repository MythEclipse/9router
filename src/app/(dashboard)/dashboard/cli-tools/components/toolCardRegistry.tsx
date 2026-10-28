"use client";

import {
  ClaudeToolCard, CodexToolCard, DroidToolCard, OpenClawToolCard,
  HermesToolCard, OpenCodeToolCard, CoworkToolCard,
  ClineToolCard, KiloToolCard, DeepSeekTuiToolCard,
  JcodeToolCard, GrokBuildToolCard, GenericCliToolCard,
} from "./index.ts";

/**
 * Which card renders for each CLI tool id.
 *
 * Replacing the old `switch` in ToolDetailClient with a lookup keeps the mapping
 * declarative: adding a tool is one entry here, not a new branch in a renderer.
 * Cards that need extra props receive them through `extraProps`.
 */
const TOOL_CARD_REGISTRY = {
  claude: ClaudeToolCard,
  codex: CodexToolCard,
  opencode: OpenCodeToolCard,
  cowork: CoworkToolCard,
  droid: DroidToolCard,
  openclaw: OpenClawToolCard,
  hermes: HermesToolCard,
  cline: ClineToolCard,
  kilo: KiloToolCard,
  "deepseek-tui": DeepSeekTuiToolCard,
  jcode: JcodeToolCard,
  "grok-build": GrokBuildToolCard,
  pi: GenericCliToolCard,
  omp: GenericCliToolCard,
  crush: GenericCliToolCard,
  forge: GenericCliToolCard,
  smelt: GenericCliToolCard,
  codewhale: GenericCliToolCard,
};

/** Cards that take a per-tool model-to-provider mapping (alias editor). */
const MAPPING_CARD_IDS = new Set(["claude"]);

/** Cards that render the endpoint selector and therefore need tunnel settings. */
const TUNNEL_CARD_IDS = new Set(["cowork"]);

/**
 * Resolve the card component for a tool id, plus the extra props it needs.
 * Returns null when the tool has no dedicated card — the caller falls back to
 * DefaultToolCard, which is generic by design.
 */
export function resolveToolCard(toolId, { modelMappings, onModelMappingChange, cloudUrl }) {
  const Card = TOOL_CARD_REGISTRY[toolId];
  if (!Card) return null;

  const extraProps: Record<string, unknown> = {};
  if (MAPPING_CARD_IDS.has(toolId)) {
    extraProps.modelMappings = modelMappings[toolId] || {};
    extraProps.onModelMappingChange = (alias, target) => onModelMappingChange(toolId, alias, target);
  }
  if (TUNNEL_CARD_IDS.has(toolId)) {
    extraProps.cloudUrl = cloudUrl;
  }
  return { Card, extraProps };
}

export default TOOL_CARD_REGISTRY;
