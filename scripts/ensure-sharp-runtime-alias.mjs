import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function ensureSharpRuntimeAliases({ projectRoot = process.cwd() } = {}) {
  const realSharpRoot = resolve(projectRoot, "node_modules", "sharp");
  if (!existsSync(realSharpRoot)) {
    return [];
  }

  const roots = [
    resolve(projectRoot, ".next"),
    resolve(projectRoot, ".next", "standalone"),
  ].filter((root) => existsSync(root));

  const aliasNames = new Set();
  for (const root of roots) {
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.pop();
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        try {
          const text = readFileSync(fullPath, "utf8");
          const matches = [...text.matchAll(/sharp-[A-Za-z0-9_]+/g)];
          for (const match of matches) {
            aliasNames.add(match[0]);
          }
        } catch {
          // ignore unreadable or binary assets
        }
      }
    }
  }

  const created = [];
  for (const aliasName of aliasNames) {
    const aliasDir = resolve(projectRoot, "node_modules", aliasName);
    mkdirSync(aliasDir, { recursive: true });
    writeFileSync(
      join(aliasDir, "package.json"),
      JSON.stringify({ name: aliasName, main: "index.js" }, null, 2) + "\n",
    );
    writeFileSync(join(aliasDir, "index.js"), "module.exports = require('sharp');\n");
    created.push(aliasName);
  }

  for (const aliasName of aliasNames) {
    const standaloneDir = resolve(projectRoot, ".next", "standalone", "node_modules", aliasName);
    if (existsSync(resolve(projectRoot, ".next", "standalone"))) {
      mkdirSync(standaloneDir, { recursive: true });
      writeFileSync(
        join(standaloneDir, "package.json"),
        JSON.stringify({ name: aliasName, main: "index.js" }, null, 2) + "\n",
      );
      writeFileSync(join(standaloneDir, "index.js"), "module.exports = require('sharp');\n");
    }
  }

  return created;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "ensure-sharp-runtime-alias.mjs")) {
  const created = ensureSharpRuntimeAliases();
  if (created.length > 0) {
    console.log(`[sharp-alias] Created runtime aliases: ${created.join(", ")}`);
  } else {
    console.log("[sharp-alias] No hashed sharp aliases detected");
  }
}
