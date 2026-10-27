// Render smoke-check for the profile page.
// Uses the same React/Next stub approach as the endpoint self-check: esbuild only
// proves the file parses, so an undeclared identifier survives bundling and only
// fails when the body actually runs — which on this page means a blank profile.
//
// Run: node "src/app/(dashboard)/dashboard/profile/renderSelfCheck.mjs"
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const outDir = mkdtempSync(path.join(tmpdir(), "profile-render-"));
const repoRoot = path.resolve(here, "../../../../..");

const noop = () => {};
const reactStub = `
const noop = () => {};
const stateFor = (initial) => [typeof initial === "function" ? initial() : initial, noop];
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
`;

const jsxRuntimeStub = `
const make = (type) => (t, p) => ({ type, props: p });
module.exports = { jsx: make("jsx"), jsxs: make("jsxs"), jsxDEV: make("jsx"), Fragment: Symbol("Fragment"), __esModule: true };
`;

const propTypesStub = `
const chain = { __esModule: true };
for (const name of ["string","number","bool","func","object","array","node","element","any","instanceOf","oneOf","oneOfType","arrayOf","objectOf","shape","exact","symbol","bigint"]) chain[name] = () => null;
chain.checkPropTypes = () => {};
chain.PropTypes = chain;
chain.default = chain;
module.exports = chain;
`;

const nextStub = `
const passes = (props) => props.children ?? null;
const factory = () => function Stub(props) { return passes(props); };
module.exports = {
  default: factory(), Head: factory(), Image: factory(), Link: factory(), Script: factory(),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, back() {}, refresh() {} }),
  usePathname: () => "/dashboard/profile",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  dynamic: () => factory(),
  __esModule: true,
};
`;

// These ship their own contexts and hooks; the stub returns a plain object or a
// working selector, which is all the component body reads at render time.
const zustandStub = `
module.exports = {
  create: (init) => {
    const state = typeof init === "function" ? init(() => {}, () => ({})) : init;
    const hook = (selector) => (typeof selector === "function" ? selector(state) : state);
    hook.getState = () => state;
    hook.setState = () => {};
    hook.subscribe = () => () => {};
    return hook;
  },
  __esModule: true,
};
`;

// zustand resolves subpaths (`zustand/shallow`, `zustand/traditional`) that the
// transitive UI imports use, and esbuild's alias rewrites the whole specifier — so a
// single file stub cannot cover them. A directory with these files lets the alias be
// the directory and each subpath resolve inside it.
const zustandDir = path.join(outDir, "zustand");
mkdirSync(zustandDir, { recursive: true });
writeFileSync(
  path.join(zustandDir, "package.json"),
  JSON.stringify({ name: "zustand", main: "index.js", exports: { ".": "./index.js", "./*": "./*.js" } }),
  "utf8"
);
writeFileSync(path.join(zustandDir, "index.js"), zustandStub, "utf8");
writeFileSync(path.join(zustandDir, "shallow.js"), `module.exports = { shallow: (a, b) => a === b, __esModule: true };`, "utf8");
writeFileSync(path.join(zustandDir, "traditional.js"), `module.exports = { createWithEqualityFn: (fn) => fn, __esModule: true };`, "utf8");

const stubPath = path.join(outDir, "react-stub.js");
const jsxPath = path.join(outDir, "jsx-runtime-stub.js");
const propTypesPath = path.join(outDir, "prop-types-stub.js");
const nextStubPath = path.join(outDir, "next-stub.js");
writeFileSync(stubPath, reactStub, "utf8");
writeFileSync(jsxPath, jsxRuntimeStub, "utf8");
writeFileSync(propTypesPath, propTypesStub, "utf8");
writeFileSync(nextStubPath, nextStub, "utf8");

function loadModule(file, name) {
  const outfile = path.join(outDir, `${name}.cjs`);
  execFileSync(
    "npx",
    [
      "esbuild", file, "--bundle", "--format=cjs", "--platform=node",
      "--loader:.tsx=tsx", "--loader:.ts=ts", "--jsx=automatic",
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
      `--alias:zustand=${zustandDir}`,
      `--outfile=${outfile}`,
      "--log-level=error",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  return require(outfile);
}

const results = [];
function run(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}

// Calling the component is the check — see the endpoint harness for why a load-only
// check proves nothing here.
run("the profile page body renders", () => {
  const mod = loadModule(path.join(here, "page.tsx"), "profile-page");
  if (typeof mod.default !== "function") throw new Error("ProfilePage has no default export function");
  mod.default({});
});

for (const r of results) {
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.ok ? "" : `\n        ${r.err}`}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`\n${results.length} checks passed`);
