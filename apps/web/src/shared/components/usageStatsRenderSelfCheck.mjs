// Render smoke-check for the Usage page's session-dependent layout.
//
// Why this exists: which panel a session gets is decided by one boolean read
// from /api/auth/status, and the two things it decides are easy to get
// backwards. Hiding the charts when the provider map was meant to be hidden
// looks fine in a diff and leaves a key holder with no usage view at all, so
// both branches are asserted here rather than eyeballed.
//
// State is fed through a queue because the component's real initial state never
// renders either branch: isApiKeyUser starts null, which is the spinner.
//
// Run: node src/shared/components/usageStatsRenderSelfCheck.mjs

import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
// here is <repo>/src/shared/components, so the alias root is three levels up.
const root = path.resolve(here, "../../..")
const require = createRequire(import.meta.url)
const outDir = mkdtempSync(path.join(tmpdir(), "usage-render-"))

globalThis.document = { body: {}, addEventListener() {}, removeEventListener() {} }
// EventSource is constructed on mount; the effect is stubbed, but the module
// body still needs the global to exist if anything reads it eagerly.
globalThis.EventSource = class {
	close() {}
}

const w = (name, body) => {
	const p = path.join(outDir, name)
	writeFileSync(p, body, "utf8")
	return p
}

const reactStub = w(
	"react-stub.js",
	`
const noop = () => {};
const initialOf = (initial) => (typeof initial === "function" ? initial() : initial);
module.exports = {
  useState: (initial) => {
    const queue = globalThis.__STATE_QUEUE;
    if (Array.isArray(queue) && queue.length) return [queue.shift(), noop];
    return [initialOf(initial), noop];
  },
  useEffect: noop,
  useLayoutEffect: noop,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  useContext: () => ({}),
  createContext: () => ({ Provider: () => null, Consumer: () => null }),
  forwardRef: (fn) => fn,
  memo: (fn) => fn,
  Fragment: Symbol("Fragment"),
  // lucide-react builds every glyph with React.createElement at module load, so
  // the icon registry cannot even be imported without it.
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length > 1 ? children : children[0] },
  }),
  default: {},
  __esModule: true,
};
`,
)

// Function components are invoked, not just recorded. Without this the text
// inside TopologyUnavailableNote and KeyQuotaCard never reaches the tree, and a
// check that could not see them would pass against a card that renders nothing.
const jsxStub = w(
	"jsx-runtime-stub.js",
	`
const jsx = (type, props) =>
  typeof type === "function" ? type(props || {}) : { type, props: props || {} };
module.exports = {
  jsx, jsxs: jsx, jsxDEV: jsx,
  Fragment: Symbol("Fragment"), __esModule: true,
};
`,
)

const propTypesStub = w(
	"prop-types-stub.js",
	`
const chain = { __esModule: true };
for (const n of ["string","number","bool","func","object","array","node","element","any","instanceOf","oneOf","oneOfType","arrayOf","objectOf","shape","exact"]) {
  // Returns the chain, not null: real propTypes compose, e.g.
  // PropTypes.oneOf([...]).isRequired, and a null here breaks module load.
  chain[n] = () => chain;
  chain[n].isRequired = chain[n];
}
chain.checkPropTypes = () => {}; chain.PropTypes = chain; chain.default = chain;
module.exports = chain;
`,
)

// next/dynamic is what keeps @xyflow/react and recharts out of this bundle.
// The stub returns a plain component, and the four lazy panels stay tellable
// apart by the props each one is called with.
// Each dynamic() call is numbered in module-load order, and the number is hung
// on the returned component itself. It cannot go in the props: the JSX stub here
// records elements without ever calling the component, so anything a component
// computes never reaches the tree. Matching on a prop name is not safe either,
// since `activeRequests` and `errorProvider` are also fields of the stats object
// OverviewCards receives and show up whether or not the map is rendered.
const nextDynamicStub = w(
	"next-dynamic-stub.js",
	`
let next = 0;
const dynamic = () => {
  const panel = next++;
  const Component = (props) => ({ type: "dynamic:" + panel, props });
  Component.__panel = panel;
  return Component;
};
// esbuild emits a CJS require for an aliased module and then reads the
// namespace's "default", so the export has to BE the function: exporting an
// object with a "default" key leaves it pointing at that object instead.
module.exports = dynamic;
module.exports.default = dynamic;
module.exports.__esModule = true;
`,
)

const nextNavStub = w(
	"next-nav-stub.js",
	`
module.exports = {
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  __esModule: true,
};
`,
)

const providersStub = w(
	"providers-stub.js",
	`
module.exports = {
  AI_PROVIDERS: { opencode: { id: "opencode", name: "OpenCode" } },
  FREE_PROVIDERS: {},
  __esModule: true,
};
`,
)

// esbuild follows a static import() even inside dynamic(), so the four heavy
// panels are aliased to a placeholder purely to satisfy resolution. The
// next/dynamic stub never calls the loader, so the placeholder is never
// rendered and the real panels are identified by the props they were called
// with instead.
const lazyStub = w(
	"lazy-stub.js",
	`
module.exports = { __esModule: true, default: () => null };
`,
)

const LAZY_PANELS = ["ProviderTopology", "UsageChart", "ProviderBarChart", "TopModelsChart"].map(
	(name) => `@/app/(dashboard)/dashboard/usage/components/${name}`,
)

function loadComponent() {
	const outfile = path.join(outDir, "UsageStats.cjs")
	execFileSync(
		"npx",
		[
			"esbuild",
			path.join(here, "UsageStats.tsx"),
			"--bundle",
			"--format=cjs",
			"--platform=node",
			"--loader:.js=jsx",
			"--jsx=automatic",
			`--alias:@=${path.join(root, "src")}`,
			`--alias:react=${reactStub}`,
			`--alias:react/jsx-runtime=${jsxStub}`,
			`--alias:prop-types=${propTypesStub}`,
			`--alias:next/dynamic=${nextDynamicStub}`,
			`--alias:next/navigation=${nextNavStub}`,
			`--alias:@/shared/constants/providers=${providersStub}`,
			...LAZY_PANELS.map((spec) => `--alias:${spec}=${lazyStub}`),
			`--outfile=${outfile}`,
			"--log-level=error",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	)
	return require(outfile).default
}

const UsageStats = loadComponent()

const results = []
function run(name, fn) {
	try {
		fn()
		results.push({ name, ok: true })
	} catch (err) {
		results.push({ name, ok: false, err: err.message })
	}
}
const assert = {
	ok(v, msg) {
		if (!v) throw new Error(msg || "expected truthy")
	},
	no(v, msg) {
		if (v) throw new Error(msg || "expected falsy")
	},
}

const STATS = {
	totalRequests: 12,
	totalPromptTokens: 3400,
	totalCachedTokens: 900,
	totalCompletionTokens: 500,
	totalCost: 0.42,
	activeRequests: [],
	// One row per lane: the stream draws a box for each lane that has traffic, so
	// the fixture has to carry more than a chat row for that to be visible here.
	recentRequests: [
		{ id: "r1", provider: "opencode", model: "m", timestamp: Date.now(), status: "ok", kind: "llm" },
		{
			id: "r2",
			provider: "openai",
			model: "text-embedding-3-small",
			timestamp: Date.now(),
			status: "success",
			kind: "embedding",
		},
		{
			id: "r3",
			provider: "opencode",
			model: "jev-1.13-free",
			timestamp: Date.now(),
			status: "success",
			kind: "systemone",
		},
	],
	errorProvider: "",
	byProvider: [{ provider: "opencode", requests: 12 }],
	byModel: [{ model: "m", requests: 12 }],
}

// useState order in the component, in source order: stats, sparks, loading,
// fetching, isApiKeyUser, keyQuota, tableView, viewMode, providers, periodLocal,
// chartUpdateKey. The queue is positional, so a state added to the component
// without a line here silently shifts every value after it - which is how this
// check spent a while asserting against a page whose session flag was `false`.
function render({ isApiKeyUser, keyQuota = null }) {
	globalThis.__STATE_QUEUE = [
		STATS,
		null,
		false,
		false,
		isApiKeyUser,
		keyQuota,
		"model",
		"costs",
		[],
		"today",
		0,
	]
	try {
		return JSON.stringify(UsageStats({}), (_k, v) =>
			typeof v === "function" ? `fn:${v.__panel ?? ""}` : v,
		)
	} finally {
		delete globalThis.__STATE_QUEUE
	}
}

// Panel order follows the dynamic() declarations at the top of UsageStats.js.
const hasMap = (t) => t.includes('"type":"dynamic:0"')
const hasUsageChart = (t) => t.includes('"type":"dynamic:1"')
const hasProviderBar = (t) => t.includes('"type":"dynamic:2"')
const hasTopModels = (t) => t.includes('"type":"dynamic:3"')

run("the live stream splits into one box per lane", () => {
	// The regression this guards: the stream used to be one chat-shaped table, so
	// an embedding or a System One request had nowhere to appear.
	const tree = render({ isApiKeyUser: false })
	assert.ok(tree.includes("Live Requests Stream"), "stream heading present")
	assert.ok(tree.includes('"LLM"'), "LLM box present")
	assert.ok(tree.includes('"Embedding"'), "embedding box present")
	assert.ok(tree.includes('"System One"'), "system one box present")
})

run("a password session gets the provider map and every chart", () => {
	const tree = render({ isApiKeyUser: false })
	assert.ok(hasMap(tree), "provider map present")
	assert.ok(hasUsageChart(tree), "usage chart present")
	assert.ok(hasProviderBar(tree), "by-provider chart present")
	assert.ok(hasTopModels(tree), "by-model chart present")
	assert.no(tree.includes("not available for this key"), "no unavailable note")
})

run("an API-key session keeps its own usage chart", () => {
	// The regression this check exists to undo: the charts used to be the thing
	// hidden, which left a key holder with no usage view. What stays hidden for a
	// key session is the catalog-wide pair (by provider, by model) - those describe
	// providers the key never touched and read as "no usage" to its owner, so the
	// component hides them deliberately.
	const tree = render({ isApiKeyUser: true })
	assert.ok(hasUsageChart(tree), "usage chart present")
	assert.no(hasProviderBar(tree), "catalog-wide provider chart hidden")
	assert.no(hasTopModels(tree), "catalog-wide model chart hidden")
})

run("an API-key session loses the provider map and gets the note", () => {
	const tree = render({ isApiKeyUser: true })
	assert.no(hasMap(tree), "map hidden")
	assert.ok(tree.includes("The provider map is not available for this key"), "note shown")
})

run("an API-key session sees its own quota", () => {
	const tree = render({
		isApiKeyUser: true,
		keyQuota: {
			name: "Test Keys",
			tokenLimit: 88000000,
			usedTokens: 6600000,
			nextResetAt: new Date(Date.now() + 3600000).toISOString(),
		},
	})
	assert.ok(tree.includes("Test Keys"), "key name shown")
	assert.ok(tree.includes("6.6M of 88.0M tokens used"), "used and limit shown")
	assert.ok(tree.includes("81.4M left"), "remaining shown")
	assert.ok(tree.includes("Resets in"), "countdown shown")
})

run("a password session is never shown a key quota", () => {
	const tree = render({
		isApiKeyUser: false,
		keyQuota: { name: "Someone else's key", tokenLimit: 100, usedTokens: 5 },
	})
	assert.no(tree.includes("Someone else"), "no foreign quota")
})

run("an unlimited key shows usage without a bar or a countdown", () => {
	const tree = render({
		isApiKeyUser: true,
		keyQuota: { name: "Open key", tokenLimit: 0, usedTokens: 12345, nextResetAt: null },
	})
	assert.ok(tree.includes("No token limit"), "unlimited stated")
	assert.ok(tree.includes("12.3k tokens used"), "usage still shown")
	assert.no(tree.includes("Resets in"), "no countdown for an open window")
})

run("while the session lookup is pending neither panel is shown", () => {
	const tree = render({ isApiKeyUser: null })
	assert.no(hasMap(tree), "map not shown yet")
	assert.no(tree.includes("not available for this key"), "note not shown yet")
	assert.no(tree.includes("Resets in"), "no quota yet")
})

const failed = results.filter((r) => !r.ok)
for (const r of results) {
	console.log(`${r.ok ? "  ok  " : "  FAIL"} ${r.name}${r.err ? ` - ${r.err}` : ""}`)
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
