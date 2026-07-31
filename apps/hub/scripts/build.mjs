import { cp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit", shell: false });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
});

await rm("dist", { recursive: true, force: true });
await run(process.platform === "win32" ? "npx.cmd" : "npx", ["tsc", "-p", "tsconfig.json"]);
await mkdir("dist/public", { recursive: true });
await cp("public", "dist/public", { recursive: true });
