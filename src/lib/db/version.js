import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

let cachedVersion = null;

function getGitCommitCount() {
  try {
    return execSync("git rev-list --count HEAD", {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
  } catch {
    return "0";
  }
}

function getGitShortSha() {
  try {
    return execSync("git rev-parse --short=7 HEAD", {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
  } catch {
    return "unknown";
  }
}

export function getAppVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const base = pkg.version || "0.0.0";
    const count = getGitCommitCount();
    const sha = getGitShortSha();
    cachedVersion = `${base}.${count}+${sha}`;
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

export function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
