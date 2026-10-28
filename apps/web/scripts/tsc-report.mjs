#!/usr/bin/env node
/**
 * Summarise `tsc --noEmit` output by error code and by file.
 *
 * Usage: node scripts/tsc-report.mjs [--code TS2339] [--file src/x.ts] [--show]
 */
import { readFileSync } from "node:fs"

const REPORT = process.env.TSC_REPORT || "/tmp/tsc-report.txt"
const argv = process.argv.slice(2)
const opt = (name, dflt = null) => {
	const i = argv.indexOf(name)
	return i === -1 ? dflt : argv[i + 1]
}

const raw = readFileSync(REPORT, "utf8").split("\n")
const errs = []
for (const line of raw) {
	const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/)
	if (m) errs.push({ file: m[1], line: +m[2], col: +m[3], code: m[4], msg: m[5] })
}

const codeFilter = opt("--code")
const fileFilter = opt("--file")
const filtered = errs.filter(
	(e) => (!codeFilter || e.code === codeFilter) && (!fileFilter || e.file.includes(fileFilter)),
)

if (argv.includes("--codes")) {
	const byCode = {}
	for (const e of errs) byCode[e.code] = (byCode[e.code] || 0) + 1
	for (const [k, v] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) {
		console.log(String(v).padStart(5), k)
	}
	console.log("total", errs.length, "in", new Set(errs.map((e) => e.file)).size, "files")
} else if (argv.includes("--files")) {
	const byFile = {}
	for (const e of filtered) byFile[e.file] = (byFile[e.file] || 0) + 1
	for (const [k, v] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) {
		console.log(String(v).padStart(4), k)
	}
	console.log("total", filtered.length, "in", Object.keys(byFile).length, "files")
} else {
	for (const e of filtered) {
		console.log(`${e.file}(${e.line},${e.col}): ${e.code}: ${e.msg}`)
	}
	console.log("total", filtered.length)
}
