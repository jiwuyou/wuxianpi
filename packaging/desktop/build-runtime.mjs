#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const webRoot = join(repoRoot, "apps", "web");
const runtimeSource = join(repoRoot, "runtime", "wuxianpi-node");
const outputIndex = process.argv.indexOf("--output");
const output = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : join(repoRoot, "release", "desktop-runtime"));
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// The production desktop is the Vite Web UI plus the independent Node runtime.
// The root Next app is a legacy development surface and is intentionally not
// included in the desktop distribution.
run(npm, ["ci", "--include=dev", "--prefer-offline"], webRoot);
run(npm, ["run", "build"], webRoot);
run(npm, ["ci", "--include=dev", "--prefer-offline"], runtimeSource);
run(npm, ["run", "build"], runtimeSource);
run(npm, ["prune", "--omit=dev"], runtimeSource);

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const runtimeFiles = ["dist", "builtin-packages", "package.json", "package-lock.json", "node_modules"];
for (const profile of ["normal", "repair"]) {
  const target = join(output, `wuxianpi-${profile}`);
  mkdirSync(target, { recursive: true });
  mkdirSync(join(target, "runtime"), { recursive: true });
  for (const file of runtimeFiles) {
    cpSync(join(runtimeSource, file), join(target, "runtime", file), { recursive: true });
  }
  cpSync(join(webRoot, "dist"), join(target, "web"), { recursive: true });
  writeFileSync(join(target, "openhouse-profile.json"), JSON.stringify({
    schema: 1,
    profile,
    version,
    port: profile === "normal" ? 20765 : 20766,
  }, null, 2) + "\n");
}

console.log(`Desktop WuxianPi runtimes written to ${output}`);
