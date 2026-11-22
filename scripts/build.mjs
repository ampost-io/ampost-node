#!/usr/bin/env node
// Builds dist/esm (import) and dist/cjs (require), each with its own .d.ts and package.json "type".
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

rmSync(join(root, "dist"), { recursive: true, force: true });
for (const [config, type] of [["tsconfig.build.json", "module"], ["tsconfig.cjs.json", "commonjs"]]) {
  execFileSync(process.execPath, [tsc, "-p", join(root, config)], { stdio: "inherit" });
  const out = join(root, "dist", type === "module" ? "esm" : "cjs");
  writeFileSync(join(out, "package.json"), `${JSON.stringify({ type }, null, 2)}\n`);
}
console.log("Built dist/esm and dist/cjs");
