import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { validatePackageManifest } from "../dist/package-validator.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = join(repositoryRoot, "packages", "browser-tools");
const extension = await import(pathToFileURL(join(packageRoot, "extension", "index.js")));

test("browser tools Package manifest is valid and assistant-selectable", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "wuxianpi-package.json"), "utf8"));
  await validatePackageManifest(packageRoot, manifest);
  assert.equal(manifest.id, "io.wuxianpi.browser-tools");
  assert.deepEqual(manifest.contributions.map((item) => ({ type: item.type, selectable: item.assistantSelectable })), [
    { type: "pi.extension", selectable: true },
  ]);
});

test("browser tools extension maps tool calls to the stable Runtime HTTP endpoint", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({ ok: true, data: { requestId: `request-${requests.length}`, hostId: "native-browser", result: { done: true } } });
  };
  const tools = extension.createBrowserTools({ baseUrl: "http://runtime.example/", fetchImpl });
  assert.deepEqual(tools.map((tool) => tool.name), ["browser_operation", "app_action"]);
  const registered = [];
  extension.default({ registerTool(tool) { registered.push(tool.name); } });
  assert.deepEqual(registered, ["browser_operation", "app_action"]);

  const browserResult = await tools[0].execute("call-1", {
    method: "page.click", hostId: "native-browser", tabId: "tab-1", params: { selector: "#save" }, timeoutMs: 5000,
  });
  assert.equal(requests[0].url, "http://runtime.example/api/web/v1/browser/invoke");
  assert.deepEqual(requests[0].body, {
    method: "page.click", hostId: "native-browser", target: { tabId: "tab-1" }, params: { selector: "#save" }, timeoutMs: 5000,
  });
  assert.equal(browserResult.details.hostId, "native-browser");

  await tools[1].execute("call-2", {
    action: "createNote", appId: "memo", tabId: "tab-1", args: { text: "hello" },
  });
  assert.deepEqual(requests[1].body, {
    method: "app.invoke", target: { tabId: "tab-1" },
    params: { action: "createNote", appId: "memo", args: { text: "hello" } },
  });
});

test("browser tools Runtime origin supports environment override and stable errors", async () => {
  assert.equal(extension.runtimeOriginFromEnvironment({}), "http://127.0.0.1:20765");
  assert.equal(extension.runtimeOriginFromEnvironment({ WUXIANPI_RUNTIME_URL: "http://127.0.0.1:29999" }), "http://127.0.0.1:29999");
  await assert.rejects(
    extension.invokeBrowserHost(async () => Response.json({
      ok: false, error: { code: "browser_host_offline", message: "No host" },
    }, { status: 503 }), "http://runtime.example", { method: "tabs.list" }),
    (error) => error.code === "browser_host_offline",
  );
});
