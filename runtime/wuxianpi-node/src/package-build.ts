import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RequestError } from "./protocol.js";
import type { PackageCommandDeclaration, WuxianPiPackageManifest } from "./package-types.js";
import { safePackagePath } from "./package-validator.js";

export class PackageBuildRunner {
  async run(manifest: WuxianPiPackageManifest, candidateRoot: string, logDirectory: string): Promise<string[]> {
    const commands: Array<[string, PackageCommandDeclaration | undefined]> = [];
    if (manifest.build.mode === "local") {
      commands.push(["install", manifest.build.commands.install], ["build", manifest.build.commands.build]);
    }
    commands.push(["test", manifest.build.commands?.test]);
    const logs: string[] = [];
    for (const [name, declaration] of commands) {
      if (!declaration) continue;
      const logPath = resolve(logDirectory, `${name}.log`);
      await runBoundedCommand(candidateRoot, declaration, logPath);
      logs.push(logPath);
    }
    return logs;
  }
}

export async function runBoundedCommand(root: string, declaration: PackageCommandDeclaration, logPath: string): Promise<void> {
  const cwd = declaration.workingDirectory ? safePackagePath(root, declaration.workingDirectory) : root;
  const timeoutMs = Math.max(1, declaration.timeoutSeconds ?? 600) * 1000;
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  const output = await open(logPath, "w", 0o600);
  const shell = process.env.SHELL || (process.env.PREFIX ? `${process.env.PREFIX}/bin/sh` : "/bin/sh");
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(declaration.command, {
        cwd,
        shell,
        detached: true,
        env: { ...process.env, WUXIANPI_PACKAGE_ROOT: root },
        stdio: ["ignore", output.fd, output.fd],
      });
      let timedOut = false;
      let forceKill: NodeJS.Timeout | undefined;
      const terminateGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, signal); }
        catch (error) { if (!isMissingProcess(error)) throw error; }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminateGroup("SIGTERM");
        forceKill = setTimeout(() => terminateGroup("SIGKILL"), 3000);
        forceKill.unref();
      }, timeoutMs);
      timer.unref();
      child.once("error", (error) => {
        clearTimeout(timer);
        if (forceKill) clearTimeout(forceKill);
        reject(new RequestError("package_command_failed", `Unable to start Package command: ${error.message}`, { logPath }));
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (forceKill) clearTimeout(forceKill);
        terminateGroup(timedOut ? "SIGKILL" : "SIGTERM");
        if (code === 0 && !timedOut) resolvePromise();
        else reject(new RequestError(
          timedOut ? "package_command_timeout" : "package_command_failed",
          timedOut ? `Package command timed out after ${timeoutMs}ms` : `Package command exited with ${code ?? signal ?? "unknown"}`,
          { logPath, code, signal },
        ));
      });
    });
  } finally {
    await output.close();
  }
}

function isMissingProcess(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ESRCH";
}
