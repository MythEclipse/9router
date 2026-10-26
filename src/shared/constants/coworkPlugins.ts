/** A remote (HTTPS) MCP plugin entry for Claude Cowork. */
export interface CoworkRemotePlugin {
  name: string;
  title?: string;
  description?: string;
  url: string;
  transport?: string;
  oauth?: boolean;
  toolNames?: string[];
}

/** A local stdio MCP plugin, bridged through an inline SSE endpoint. */
export interface CoworkStdioPlugin {
  name: string;
  title?: string;
  description?: string;
  extensionUrl?: string;
  command: string;
  args?: string[];
  toolNames?: string[];
}

/** A plugin as persisted/round-tripped through the cowork settings API. */
export interface CoworkPlugin extends Partial<CoworkRemotePlugin & CoworkStdioPlugin> {
  custom?: boolean;
}

/** One entry of the `managedMcpServers` array written to Cowork settings. */
export interface ManagedMcpServer {
  name: string;
  url: string;
  transport: string;
  oauth?: boolean;
  toolPolicy?: Record<string, string>;
}

// Default remote plugins for Claude Cowork (3p managedMcpServers, HTTPS only).
export const DEFAULT_PLUGINS: CoworkRemotePlugin[] = [
  {
    name: "exa",
    title: "Exa",
    description: "Real-time web search and code documentation",
    url: "https://mcp.exa.ai/mcp",
    transport: "http",
    oauth: false,
    toolNames: ["web_search_exa", "web_fetch_exa"],
  },
  {
    name: "tavily",
    title: "Tavily",
    description: "Real-time web search optimized for LLM agents",
    url: "https://mcp.tavily.com/mcp",
    transport: "http",
    oauth: true,
    toolNames: ["tavily_search", "tavily_extract", "tavily_crawl", "tavily_map"],
  },
];

// Local stdio plugins bridged via inline SSE endpoint on the app's port.
export const LOCAL_STDIO_PLUGINS: CoworkStdioPlugin[] = [
  {
    name: "browsermcp",
    title: "Browser MCP",
    description: "Control your running Chrome (requires Chrome extension)",
    extensionUrl: "https://chromewebstore.google.com/detail/browser-mcp-automate-your/bjfgambnhccakkhmkepdoekmckoijdlc",
    command: "npx",
    args: ["-y", "@browsermcp/mcp@latest"],
    toolNames: ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_screenshot", "browser_get_console_logs", "browser_wait", "browser_press_key", "browser_go_back", "browser_go_forward"],
  },
];

export function buildManagedMcpServers(plugins: unknown): ManagedMcpServer[] {
  const list: CoworkPlugin[] = Array.isArray(plugins) ? plugins : [];
  const out: ManagedMcpServer[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    if (!p?.name || !p?.url || seen.has(p.name)) continue;
    seen.add(p.name);
    const entry: ManagedMcpServer = {
      name: p.name,
      url: p.url,
      transport: p.transport || (/\/sse(\b|\/)/i.test(p.url) ? "sse" : "http"),
    };
    if (p.oauth) entry.oauth = true;
    if (Array.isArray(p.toolNames) && p.toolNames.length > 0) {
      // Strip any pre-existing "{name}-" prefixes (idempotent across re-applies),
      // then emit both bare + single-prefixed variants to match runtime tool naming.
      const prefix = `${p.name}-`;
      const bare = new Set<string>();
      for (const raw of p.toolNames) {
        if (typeof raw !== "string" || !raw) continue;
        let t = raw;
        while (t.startsWith(prefix)) t = t.slice(prefix.length);
        bare.add(t);
      }
      const policy: Record<string, string> = {};
      for (const t of bare) {
        policy[t] = "allow";
        policy[`${prefix}${t}`] = "allow";
      }
      entry.toolPolicy = policy;
    }
    out.push(entry);
  }
  return out;
}


