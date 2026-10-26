// Node loader hooks so custom-server.js can import the Next.js source tree
// (src/* uses "@/..." aliases, plus a few CJS packages with named exports).
// Only used by the auth guard - Next.js itself bundles normally via webpack.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") + path.sep;
const SRC = ROOT + "src/";

function tryResolve(p) {
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  const extensionless = p.replace(/\.(?:js|mjs|cjs|ts|tsx)$/, "");
  for (const ext of [".js", ".mjs", ".ts", ".tsx"]) {
    const candidate = extensionless + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    for (const idx of ["index.js", "index.mjs", "index.ts", "index.tsx"]) {
      const q = path.join(p, idx);
      if (fs.existsSync(q)) return q;
    }
  }
  return null;
}

// node-machine-id is CJS whose named exports the ESM lexer cannot see.
const NMID_SHIM = `
import { createRequire } from "node:module";
const mod = createRequire(${JSON.stringify(ROOT)})("node-machine-id");
export const machineIdSync = mod.machineIdSync;
export const machineId = mod.machineId;
export default mod;
`;

// next/server is also CJS, but trickier than node-machine-id: it reassigns
// `module.exports` and then writes onto the ORIGINAL `exports` object
// (next/server.js does both). Node's CJS named-export lexer finds the names
// from the `exports.X = ...` lines, yet the namespace it produces through
// this loader evaluates each binding to undefined and `default` is empty
// (observed on Node 22 with a resolve hook short-circuiting the URL).
// createRequire goes through the plain CommonJS machinery, which always
// yields the real NextResponse / NextRequest classes.
const NEXT_SERVER_SHIM = `
import { createRequire } from "node:module";
const mod = createRequire(${JSON.stringify(ROOT)})("next/server");
export const NextRequest = mod.NextRequest;
export const NextResponse = mod.NextResponse;
export const ImageResponse = mod.ImageResponse;
export const userAgentFromString = mod.userAgentFromString;
export const userAgent = mod.userAgent;
export const URLPattern = mod.URLPattern;
export default mod;
`;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const url = new URL(specifier, context.parentURL);
    url.search = "";
    url.hash = "";
    const resolved = tryResolve(fileURLToPath(url));
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const r = tryResolve(SRC + specifier.slice(2));
    if (r) return { url: pathToFileURL(r).href, shortCircuit: true };
  }
  if (specifier === "open-sse" || specifier.startsWith("open-sse/")) {
    const suffix = specifier === "open-sse" ? "" : specifier.slice("open-sse/".length);
    const r = tryResolve(path.join(ROOT, "open-sse", suffix));
    if (r) return { url: pathToFileURL(r).href, shortCircuit: true };
  }
  if (specifier === "next/server") {
    return { url: "data:text/javascript," + encodeURIComponent(NEXT_SERVER_SHIM), shortCircuit: true };
  }
  if (specifier === "node-machine-id") {
    return { url: "data:text/javascript," + encodeURIComponent(NMID_SHIM), shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith("file:") && /\.tsx?$/.test(new URL(url).pathname)) {
    const source = fs.readFileSync(fileURLToPath(url), "utf8");
    const result = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
      reportDiagnostics: true,
    });
    const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) || [];
    if (errors.length) {
      const message = errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
        .join("\n");
      throw new Error(`Could not transpile ${fileURLToPath(url)}:\n${message}`);
    }
    return { format: "module", source: result.outputText, shortCircuit: true };
  }
  return next(url, context);
}
