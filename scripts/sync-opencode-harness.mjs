#!/usr/bin/env node
/**
 * Refresh the bundled OpenCode agent harness snapshot from zen-proxy.
 *
 * Runtime reads upstream on its own; this script exists so the fallback
 * snapshot can be regenerated deliberately and reviewed as a diff.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCES = {
  preamble: "https://raw.githubusercontent.com/12errh/zen-proxy/main/agent-preamble.txt",
  tools: "https://raw.githubusercontent.com/12errh/zen-proxy/main/agent-tools.json",
};
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "open-sse", "assets");

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.text();
}

function toChatShape(raw) {
  const list = Array.isArray(raw) ? raw : raw?.tools;
  if (!Array.isArray(list) || list.length === 0) throw new Error("tool manifest is empty");
  return list.map((tool) => (tool.function ? tool : { type: "function", function: tool }));
}

const header = (what) =>
  `/** Verbatim ${what} of the OpenCode v2 CLI, mirrored from zen-proxy.\n`
  + " * Regenerate with `npm run sync:opencode-harness`; do not hand-edit. */\n";

const preamble = await fetchText(SOURCES.preamble);
const tools = toChatShape(JSON.parse(await fetchText(SOURCES.tools)));

writeFileSync(
  join(ASSETS, "opencodeAgentPreamble.ts"),
  `${header("agent preamble")}export const OPENCODE_AGENT_PREAMBLE = ${JSON.stringify(preamble)};\n`,
);
writeFileSync(
  join(ASSETS, "opencodeAgentTools.ts"),
  `${header("tool manifest")}export const OPENCODE_AGENT_TOOLS = ${JSON.stringify(tools, null, 2)} as const;\n`,
);
console.log(`synced: preamble ${preamble.length}B, ${tools.length} tools`);
