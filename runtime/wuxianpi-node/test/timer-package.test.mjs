import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeServer } from "../dist/server.js";

const TIMER_EXTENSION_ID = "com.wuxianpi.builtin.timer/web.timer";

test("Timer Package creates timers, records occurrences, and honors timezone-aware RRULE scheduling", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-timer-runtime-"));
  const agentDir = join(root, "agent");
  const server = createRuntimeServer({ host: "127.0.0.1", port: 0, agentDir, idleTimeoutMs: 0 });
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}/api/web/v1`;
  t.after(async () => {
    await server.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const nonce = await issueNonce(base, TIMER_EXTENSION_ID);
  const created = await bridge(base, nonce, "package.invoke", {
    namespace: "timer.v1",
    method: "create",
    params: {
      title: "Daily report",
      schedule: { kind: "rrule", value: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" },
      timezone: "Asia/Shanghai",
      consumerId: "missing.consumer",
      handlerId: "missing-handler",
      payload: {},
    },
  });
  assert.equal(created.timezone, "Asia/Shanghai");
  assert.match(created.nextRunAt, /^\d{4}-\d{2}-\d{2}T/);

  const run = await bridge(base, nonce, "package.invoke", {
    namespace: "timer.v1",
    method: "runNow",
    params: { timerId: created.id },
  });
  assert.equal(run.timerId, created.id);

  const occurrences = await bridge(base, nonce, "package.invoke", {
    namespace: "timer.v1",
    method: "occurrences",
    params: { timerId: created.id },
  });
  assert.equal(occurrences.occurrences.length >= 1, true);
  assert.equal(occurrences.occurrences[0].status, "failed");

  const paused = await bridge(base, nonce, "package.invoke", {
    namespace: "timer.v1",
    method: "pause",
    params: { timerId: created.id },
  });
  assert.equal(paused.status, "paused");

  const resumed = await bridge(base, nonce, "package.invoke", {
    namespace: "timer.v1",
    method: "resume",
    params: { timerId: created.id },
  });
  assert.equal(resumed.status, "active");
});

async function issueNonce(base, extensionId) {
  const response = await fetch(`${base}/extensions/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ extensionId, assistantId: "wuxianpi" }),
  });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body.data.nonce;
}

async function bridge(base, nonce, method, params = {}) {
  const response = await fetch(`${base}/extensions/bridge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "wuxianpi_bridge_request",
      requestId: crypto.randomUUID(),
      extensionId: TIMER_EXTENSION_ID,
      nonce,
      method,
      params,
    }),
  });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body.data.result;
}
