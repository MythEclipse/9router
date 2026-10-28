import fs from "node:fs"
import path from "node:path"

let cachedVersion: string | null = null

export function getAppVersion(): string {
	if (cachedVersion) return cachedVersion
	// Held in a local so the return is narrowed to `string`, not `string | null`.
	let version = "0.0.0"
	try {
		const pkgPath = path.join(process.cwd(), "package.json")
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
		version = pkg.version || "0.0.0"
	} catch {}
	cachedVersion = version
	return version
}

export function timestampSlug(date: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0")
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}
