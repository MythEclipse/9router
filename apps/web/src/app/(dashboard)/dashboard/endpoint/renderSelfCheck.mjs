// Render smoke-check for the endpoint page.
//
// Why this exists: esbuild only proves a file parses. It happily accepts JSX that
// names a variable nobody declared, because that is syntactically fine — the
// ReferenceError fires only when the component renders, and /dashboard/endpoint has
// no error boundary, so the page just goes blank. This component is the largest in
// the dashboard and the most refactored, so it is exactly where a dangling reference
// would otherwise ship.
//
// The React stub returns hooks without a scheduler, so this proves the body runs
// against real-shaped props, not that the DOM output is right.
//
// Run: node "src/app/(dashboard)/dashboard/endpoint/renderSelfCheck.mjs"

import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const outDir = mkdtempSync(path.join(tmpdir(), "endpoint-render-"))
const repoRoot = path.resolve(here, "../../../../..")

// Hooks only need to return something the body can read. State is a single pair so a
// component that reads `[value, setValue]` desugars; effects never run.
const reactStub = `
const noop = () => {};
const store = new Map();
const stateFor = (initial) => {
  const value = typeof initial === "function" ? initial() : initial;
  return [value, noop];
};
module.exports = {
  useState: stateFor,
  useReducer: (reducer, initial) => [typeof initial === "function" ? initial() : initial, noop],
  useEffect: noop,
  useLayoutEffect: noop,
  useInsertionEffect: noop,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  useContext: () => ({}),
  useId: () => "id",
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useTransition: () => [false, noop],
  useDeferredValue: (v) => v,
  forwardRef: (fn) => fn,
  memo: (fn) => fn,
  createContext: (v) => ({ Provider: ({ children }) => children, _currentValue: v }),
  createElement: (type) => ({ type }),
  cloneElement: (el) => el,
  isValidElement: () => true,
  Fragment: Symbol("Fragment"),
  __esModule: true,
};
`

const jsxRuntimeStub = `
const make = (type) => (t, p) => ({ type, props: p });
module.exports = {
  jsx: make("jsx"),
  jsxs: make("jsxs"),
  jsxDEV: make("jsx"),
  Fragment: Symbol("Fragment"),
  __esModule: true,
};
`

// propTypes declarations run at import time and the real package is not resolvable
// outside Next's bundler; nothing here depends on their output.
const propTypesStub = `
const chain = { __esModule: true };
for (const name of ["string","number","bool","func","object","array","node","element","any","instanceOf","oneOf","oneOfType","arrayOf","objectOf","shape","exact","symbol","bigint"]) {
  chain[name] = () => null;
}
chain.checkPropTypes = () => {};
chain.PropTypes = chain;
chain.default = chain;
module.exports = chain;
`

// Next's client entry points touch React contexts at import time, which the hook
// stub cannot satisfy. None of that matters to a body-render check, so `next/*` is
// replaced wholesale rather than trying to emulate it.
const nextStub = `
const React = require("react");
const passes = (props) => props.children ?? null;
const factory = () => function Stub(props) { return passes(props); };
module.exports = {
  default: factory(),
  Head: factory(),
  Image: factory(),
  Link: factory(),
  Script: factory(),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, back() {}, refresh() {} }),
  usePathname: () => "/dashboard/endpoint",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: "test" }),
  dynamic: (fn) => factory(),
  __esModule: true,
};
`

const stubPath = path.join(outDir, "react-stub.js")
const jsxPath = path.join(outDir, "jsx-runtime-stub.js")
const propTypesPath = path.join(outDir, "prop-types-stub.js")
const nextStubPath = path.join(outDir, "next-stub.js")
writeFileSync(nextStubPath, nextStub, "utf8")
writeFileSync(stubPath, reactStub, "utf8")
writeFileSync(jsxPath, jsxRuntimeStub, "utf8")
writeFileSync(propTypesPath, propTypesStub, "utf8")

function loadModule(file, name) {
	const outfile = path.join(outDir, `${name}.cjs`)
	execFileSync(
		"npx",
		[
			"esbuild",
			file,
			"--bundle",
			"--format=cjs",
			"--platform=node",
			"--loader:.tsx=tsx",
			"--loader:.ts=ts",
			"--jsx=automatic",
			`--alias:@=${path.join(repoRoot, "src")}`,
			`--alias:open-sse=${path.join(repoRoot, "open-sse")}`,
			`--alias:react=${stubPath}`,
			`--alias:react/jsx-runtime=${jsxPath}`,
			`--alias:prop-types=${propTypesPath}`,
			`--alias:next=${nextStubPath}`,
			`--alias:next/head=${nextStubPath}`,
			`--alias:next/image=${nextStubPath}`,
			`--alias:next/link=${nextStubPath}`,
			`--alias:next/navigation=${nextStubPath}`,
			`--alias:next/script=${nextStubPath}`,
			`--alias:next/dynamic=${nextStubPath}`,
			`--outfile=${outfile}`,
			"--log-level=error",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	)
	return require(outfile)
}

const results = []
function run(name, fn) {
	try {
		fn()
		results.push({ name, ok: true })
	} catch (err) {
		results.push({ name, ok: false, err: err.message })
	}
}

// Calling the component IS the check. A load-only check is worthless here: esbuild
// leaves an undeclared name as a free variable and the bundle imports cleanly, so
// only invoking the body turns a dangling reference into an error. Effects never run
// under the stub, so this exercises the render path and nothing else.
run("the page body renders for a provisioned machine", () => {
	const mod = loadModule(path.join(here, "EndpointPageClient.tsx"), "endpoint-page")
	if (typeof mod.default !== "function") {
		throw new Error("EndpointPageClient has no default export function")
	}
	mod.default({ machineId: "machine-under-test" })
})

run("the page body renders without a machine id", () => {
	const mod = loadModule(path.join(here, "EndpointPageClient.tsx"), "endpoint-page-2")
	mod.default({ machineId: undefined })
})

for (const r of results) {
	console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.ok ? "" : `\n        ${r.err}`}`)
}

const failed = results.filter((r) => !r.ok)
if (failed.length > 0) {
	console.error(`\n${failed.length} of ${results.length} checks failed`)
	process.exit(1)
}
console.log(`\n${results.length} checks passed`)
