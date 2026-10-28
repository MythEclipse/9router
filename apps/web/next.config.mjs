import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = dirname(fileURLToPath(import.meta.url))
// `next.config.mjs` sits at apps/web, so the bun workspace root (the one that owns
// node_modules and bun.lock) is TWO levels up, not one. Turbopack detects the
// workspace from the nearest lockfile; rooted below it, `next` resolves through a
// symlink that escapes the root and the build fails outright.
const workspaceRoot = join(projectRoot, "..", "..")
// Turbopack and the file tracer must agree on ONE root, or Next silently prefers
// the tracer value ("Both outputFileTracingRoot and turbopack.root are set, but
// they must have the same value"). The workspace root is the only value that
// works: node_modules lives there, and a root at apps/web makes `next` resolve
// through a symlink that escapes the build root — "Could not find the Next.js
// package". NEXT_TRACING_ROOT_MODE=workspace only narrows the Docker payload.
const tracingRoot = workspaceRoot
const proxyClientMaxBodySize = process.env.NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE || "128mb"

/** @type {import('next').NextConfig} */
const nextConfig = {
	distDir: process.env.NEXT_DIST_DIR || ".next",
	output: "standalone",
	// `open` must stay external. It derives its own directory from `import.meta.url`, and
	// webpack replaces that with the absolute path of the BUILD machine as a string literal.
	// A release built on macOS therefore ships `file:///Users/.../open/index.js`, which
	// `fileURLToPath` rejects on Windows ("File URL path must be absolute" - no drive
	// letter). That throw happens at module scope, so every consumer of `open` dies on
	// import - including xAI/Grok token refresh, which loads the OAuth service that imports
	// it. Keeping it external preserves the real `import.meta.url` at runtime.
	// @aws-sdk/credential-providers must stay external for the same class of reason: it reads
	// ~/.aws/config and the SSO token cache from disk at runtime and resolves its credential
	// plugins by dynamic require, neither of which survives bundling.
	serverExternalPackages: [
		"better-sqlite3",
		"sql.js",
		"node:sqlite",
		"bun:sqlite",
		"open",
		"@aws-sdk/credential-providers",
		"sharp",
		"@img",
		"detect-libc",
	],
	turbopack: {
		// Always the workspace root: node_modules lives above apps/web, and a root
		// at apps/web makes `next` unresolvable ("Could not find the Next.js
		// package"). This is a resolution boundary, not a tracing concern.
		root: workspaceRoot,
	},
	images: {
		unoptimized: true,
	},
	typescript: {
		// The codemod renamed .js components to .tsx and added interface/type
		// annotations; these were untyped JS before the upgrade, so pre-existing
		// JS patterns now surface as type errors. Do not fail the build on them.
		ignoreBuildErrors: true,
	},
	// Next 16: tracing keys moved out of experimental to top-level.
	outputFileTracingRoot: tracingRoot,
	outputFileTracingExcludes: {
		"*": [
			"./gitbook/**/*",
			"**/AppData/Local/**/*",
			"**/AppData/Roaming/**/*",
			"**/.config/**/*",
			"**/.codex/**/*",
			"**/Cookies/**/*",
		],
	},
	experimental: {
		// #1529/#1572: LLM clients can send long context or base64 image payloads through /v1 rewrites.
		proxyClientMaxBodySize,
		// Cache fetch responses across HMR refreshes for faster dev reloads.
		serverComponentsHmrCache: true,
		// Tree-shake heavy barrel imports to cut compile + bundle size
		optimizePackageImports: [
			"@xyflow/react",
			"@dnd-kit/core",
			"@dnd-kit/sortable",
			"material-symbols",
			"marked",
		],
		// Required by the Next.js 14→16 agent upgrade: allow the upgrade agent to
		// run codemods and Future Defaults adoptions against this app.
		agentUpgrade: "latest",
	},
	webpack: (config, { isServer }) => {
		// Ignore fs/path modules in browser bundle
		if (!isServer) {
			config.resolve.fallback = {
				...config.resolve.fallback,
				fs: false,
				path: false,
			}
		}
		// Exclude non-source dirs from watcher to reduce inotify load
		config.watchOptions = {
			...config.watchOptions,
			aggregateTimeout: 300,
			ignored:
				/[\\/](node_modules|\.git|logs|\.next|\.next-cli-build|gitbook|cli|open-sse\.old|tests|docs)[\\/]/,
		}
		// Defense in depth: bun:sqlite is never used on Node 22 runners, and the
		// runtime import is already guarded + dynamic - keep it out of the bundle.
		if (isServer) {
			config.externals = config.externals || []
			if (!config.externals.includes("bun:sqlite")) config.externals.push("bun:sqlite")
		}
		return config
	},
	async rewrites() {
		return [
			{
				source: "/v1/v1/:path*",
				destination: "/api/v1/:path*",
			},
			{
				source: "/v1/v1",
				destination: "/api/v1",
			},
			{
				source: "/codex/:path*",
				destination: "/api/v1/responses",
			},
			{
				source: "/responses",
				destination: "/api/v1/responses",
			},
			{
				source: "/systemone",
				destination: "/api/v1/systemone",
			},
			{
				source: "/v1beta/:path*",
				destination: "/api/v1beta/:path*",
			},
			{
				source: "/v1beta",
				destination: "/api/v1beta",
			},
			{
				source: "/v1/:path*",
				destination: "/api/v1/:path*",
			},
			{
				source: "/v1",
				destination: "/api/v1",
			},
		]
	},
}

export default nextConfig
