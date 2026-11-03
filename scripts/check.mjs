import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), errors = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", ".ploop", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await visit(path); continue; }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".mjs")) {
      const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" }); if (result.status !== 0) errors.push(result.stderr);
    }
    if (entry.name.endsWith(".json")) { try { JSON.parse(await readFile(path, "utf8")); } catch { errors.push(`Invalid JSON: ${path}`); } }
    if (entry.name.endsWith(".md")) {
      const text = await readFile(path, "utf8"); if (text.split("```").length % 2 === 0) errors.push(`Unclosed fence: ${path}`);
      for (const [, target] of text.matchAll(/(?<!!)\[[^\]]+\]\(([^\)]+)\)/g)) {
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const selected = target.split("#")[0];
        if (!await stat(resolve(dirname(path), decodeURIComponent(selected))).then(() => true, () => false)) errors.push(`Broken link: ${path} -> ${target}`);
      }
    }
  }
}
await visit(root);
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; } else console.log("Source syntax, JSON and local documentation links passed.");
