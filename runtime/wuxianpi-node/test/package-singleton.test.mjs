import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeServer } from "../dist/server.js";

const GROUP_ID = "com.wuxianpi.background/execution";

test("Package singleton startup competition and manual transfer keep one owner", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-singleton-"));
  const guardDirectory = join(root, "guards");
  const first = createRuntimeServer({
    host: "127.0.0.1", port: 0, agentDir: join(root, "first-agent"), idleTimeoutMs: 0,
    runtimeId: "first", runtimeUrl: "http://127.0.0.1:first", singletonGuardDirectory: guardDirectory,
  });
  const second = createRuntimeServer({
    host: "127.0.0.1", port: 0, agentDir: join(root, "second-agent"), idleTimeoutMs: 0,
    runtimeId: "second", runtimeUrl: "http://127.0.0.1:second", singletonGuardDirectory: guardDirectory,
  });
  const firstAddress = await first.start();
  const secondAddress = await second.start();
  const firstBase = `http://127.0.0.1:${firstAddress.port}/api/web/v1`;
  const secondBase = `http://127.0.0.1:${secondAddress.port}/api/web/v1`;
  t.after(async () => {
    await Promise.all([first.stop().catch(() => undefined), second.stop().catch(() => undefined)]);
    await rm(root, { recursive: true, force: true });
  });

  assert.equal((await singleton(firstBase)).owner, true);
  assert.equal((await singleton(secondBase)).owner, false);

  const runtimeSingletons = await fetch(`http://127.0.0.1:${firstAddress.port}/api/runtime/v1/singletons`).then((response) => response.json());
  assert.equal(runtimeSingletons.data.singletons[0].owner, true);
  const unauthorized = await fetch(`http://127.0.0.1:${firstAddress.port}/api/runtime/v1/package-services/invoke`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      reference: { packageId: "com.wuxianpi.builtin.timer", serviceId: "timer.v1", method: "list" }, input: null,
    }),
  });
  assert.equal(unauthorized.status, 401);
  const internalToken = (await readFile(join(guardDirectory, "runtime-internal.token"), "utf8")).trim();
  const invoked = await fetch(`http://127.0.0.1:${firstAddress.port}/api/runtime/v1/package-services/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${internalToken}`, "content-type": "application/json" },
    body: JSON.stringify({ reference: { packageId: "com.wuxianpi.builtin.timer", serviceId: "timer.v1", method: "list" }, input: null }),
  });
  assert.equal(invoked.status, 200, await invoked.text());

  const ownerFile = (await readdir(guardDirectory)).find((name) => name.endsWith(".owner.json"));
  assert.ok(ownerFile);
  const owner = JSON.parse(await readFile(join(guardDirectory, ownerFile), "utf8"));
  owner.runtimeUrl = `http://127.0.0.1:${firstAddress.port}`;
  await writeFile(join(guardDirectory, ownerFile), `${JSON.stringify(owner)}\n`);
  await assert.rejects(
    second.packageRuntimeHost.invokeService({
      packageId: "com.wuxianpi.builtin.tasks", serviceId: "task.scheduled-action.v1", method: "execute",
    }, { payload: { actionId: "missing" }, occurrence: { occurrenceId: "missing" } }),
    /task_action_not_found/,
  );

  const released = await post(`${firstBase}/singletons/${encodeURIComponent(GROUP_ID)}/release`);
  assert.equal(released.data.singleton.state, "standby");
  const acquired = await post(`${secondBase}/singletons/${encodeURIComponent(GROUP_ID)}/acquire`);
  assert.equal(acquired.data.singleton.owner, true);
  assert.equal((await singleton(firstBase)).owner, false);
  assert.equal((await singleton(secondBase)).owner, true);
});

async function singleton(base) {
  const response = await fetch(`${base}/singletons`);
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  const value = body.data.singletons.find((item) => item.groupId === GROUP_ID);
  assert.ok(value);
  return value;
}

async function post(url) {
  const response = await fetch(url, { method: "POST" });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}
