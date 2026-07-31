import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { validateCanonicalChildManifest } from "../dist/child-manifest-validator.js";
import { validatePackageManifest } from "../dist/package-validator.js";

const PACKAGE_ID = "io.test.child-fixtures";

const hubWebExtension = {
  schemaVersion: 1,
  id: "fixture-web",
  name: "Fixture Web",
  version: "1.0.0",
  apiVersion: "1",
  description: "Canonical Web Extension",
  entry: "index.html",
  permissions: ["assistant.read", "storage.read", "storage.write", "tts.speak", "tools.call", "ui.notify", "ui.resize", "ui.close"],
  contributes: {
    fullPages: [{ id: "page", title: "Page", entry: "page.html" }],
    settingsPanels: [{ id: "settings", title: "Settings", entry: "settings.html" }],
    assistantEditorTabs: [{ id: "assistant", title: "Assistant", entry: "assistant.html" }],
    chatActions: [{ id: "action", title: "Action", icon: "sparkles" }],
    toolRenderers: [{ toolPattern: "fixture.*", entry: "renderer.html" }],
  },
};

const hubRendererOnly = {
  schemaVersion: 1,
  id: "fixture-renderer",
  name: "Fixture Renderer",
  version: "1.0.0",
  apiVersion: "1",
  contributes: { toolRenderers: [{ toolPattern: "fixture.*", entry: "renderer.html" }] },
};

const hubAssistant = {
  schemaVersion: 1,
  name: "Fixture Assistant",
  description: "Canonical assistant template",
  avatar: "avatar.png",
  greeting: "Hello",
  starterPrompts: ["Start here"],
  model: { provider: "openai", modelId: "gpt-5" },
  thinkingLevel: "high",
  tools: ["read", "write"],
  skills: "inherit",
  mcpServers: ["cloudflare"],
  webExtensions: ["fixture-web"],
  tts: { profileId: "default", autoSpeak: true, rate: 1, pitch: 0, readCode: false },
  archived: false,
};

const hubOpenHouseSmallphone = {
  schemaVersion: 1,
  id: "fixture-openhouse",
  title: "Fixture OpenHouse App",
  description: "Canonical OpenHouse app",
  kind: "app",
  smallphoneApp: {
    visible: true,
    section: "apps",
    order: 10,
    icon: "home",
    entry: { type: "webview", url: "http://127.0.0.1:23110/" },
  },
  serviceManager: { required: true, services: [{ name: "fixture-service" }] },
  ai: { enabled: true },
};

const hubOpenHouseShell = {
  schemaVersion: 1,
  id: "fixture-shell",
  title: "Fixture Shell App",
  kind: "app",
  shellMenu: {
    visible: true,
    entry: { type: "service-control", serviceNames: ["fixture-service"], serviceRefs: ["service-manager://fixture-service"] },
    controlEntry: { type: "native" },
  },
};

const hubService = {
  schemaVersion: 1,
  id: "fixture-service",
  service: {
    name: "fixture-service",
    description: "Canonical service",
    provider: "termux-process",
    command: ["node", "server.js"],
    working_dir: "",
    env: { NODE_ENV: "production" },
    runtime: { implementation: "node" },
    restart: { mode: "on-failure", max_retries: 3 },
    repair: { mode: "script", command: ["sh", "repair.sh"], working_dir: "", env: { REPAIR: "1" }, timeout: "30s" },
    health: [
      { type: "http", url: "http://127.0.0.1:23110/health", interval: 10, timeout: null },
      { type: "tcp", address: "127.0.0.1:23110", interval: "10s", timeout: 2 },
    ],
    ports: [{
      name: "http", host: "127.0.0.1", preferred: 23110, dynamic: true, pool: "local",
      protocol: "tcp", envVar: "WUXIANPI_PORT", endpoint: { scheme: "http", path: "/" },
    }],
    enabled: true,
    residentByDefault: false,
    tags: ["fixture"],
  },
};

const hubMcpStdio = {
  id: "fixture-stdio",
  name: "Fixture stdio MCP",
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  cwd: "/data/data/com.termux/files/home",
  env: { NODE_ENV: "production" },
  envSecretRefs: { TOKEN: "secret/token" },
  headers: { "X-Mode": "test" },
  headerSecretRefs: { Authorization: "secret/auth" },
  timeoutMs: 30000,
  lifecycle: "lazy-keep-alive",
  auth: false,
  enabled: true,
};

const hubMcpHttp = {
  id: "fixture-http",
  name: "Fixture HTTP MCP",
  transport: "streamable-http",
  url: "https://example.com/mcp",
  headers: { "X-Mode": "test" },
  headerSecretRefs: { Authorization: "secret/auth" },
  timeoutMs: 30000,
  lifecycle: "eager",
  auth: "oauth",
  enabled: true,
};

test("canonical Hub child manifest fixtures are accepted", async (context) => {
  const schemaCases = [
    ["Web Extension", "web", hubWebExtension],
    ["renderer-only Web Extension", "web", hubRendererOnly],
    ["assistant template", "assistant", hubAssistant],
    ["inherited assistant template", "assistant", { schemaVersion: 1, name: "Inherited", model: "inherit", tools: "inherit", tts: "inherit" }],
    ["OpenHouse smallphoneApp", "openhouse", hubOpenHouseSmallphone],
    ["OpenHouse shellMenu", "openhouse", hubOpenHouseShell],
    ["service-manager wrapper", "service", hubService],
    ["stdio MCP", "mcp", hubMcpStdio],
    ["streamable HTTP MCP", "mcp", hubMcpHttp],
  ];
  for (const [name, type, value] of schemaCases) {
    await context.test(name, () => assert.doesNotThrow(() => validateCanonicalChildManifest(type, value, name)));
  }

  await context.test("Hub legal combined package fixture", async () => {
    const contributions = [
      { id: `${PACKAGE_ID}/web.fixture`, type: "wuxianpi.webExtension", name: "Web", manifest: "web/web.json", assistantSelectable: true },
      { id: `${PACKAGE_ID}/renderer.fixture`, type: "wuxianpi.renderer", name: "Renderer", manifest: "web/renderer.json", contentTypes: ["fixture.result"] },
      { id: `${PACKAGE_ID}/assistant.fixture`, type: "wuxianpi.assistantTemplate", name: "Assistant", manifest: "assistants/fixture.json", kind: "functional", defaultBindings: [] },
      { id: `${PACKAGE_ID}/app.fixture`, type: "openhouse.app", name: "App", manifest: "openhouse/app.json" },
      { id: `${PACKAGE_ID}/service.fixture`, type: "service-manager.service", name: "Service", manifest: "service/service.json" },
      { id: `${PACKAGE_ID}/mcp.fixture`, type: "mcp.server", name: "MCP", config: "mcp/fixture.json", assistantSelectable: true },
      { id: `${PACKAGE_ID}/skill.fixture`, type: "pi.skill", name: "Skill", path: "skills/fixture", assistantSelectable: true },
      { id: `${PACKAGE_ID}/context.fixture`, type: "wuxianpi.context", name: "Context", path: "context/fixture.json", format: "json", assistantSelectable: true },
    ];
    const root = await packageFixture(contributions, {
      "web/web.json": hubWebExtension,
      "web/renderer.json": hubRendererOnly,
      "web/index.html": "index",
      "web/page.html": "page",
      "web/settings.html": "settings",
      "web/assistant.html": "assistant",
      "web/renderer.html": "renderer",
      "assistants/fixture.json": hubAssistant,
      "openhouse/app.json": hubOpenHouseSmallphone,
      "service/service.json": hubService,
      "mcp/fixture.json": hubMcpHttp,
      "skills/fixture/SKILL.md": "---\nname: fixture-skill\ndescription: Canonical fixture skill\n---\n",
      "context/fixture.json": "not required to be JSON by the Hub validator",
    });
    await assert.doesNotReject(() => validatePackageManifest(root, baseManifest(contributions)));
  });
});

test("canonical Hub child manifest schemas reject non-canonical shapes", async (context) => {
  const cases = [
    ["Web unknown root field", "web", { ...hubWebExtension, unknown: true }],
    ["Web invalid permission", "web", { ...hubWebExtension, permissions: ["shell.execute"] }],
    ["Web unknown contribution group", "web", { ...hubWebExtension, contributes: { unknown: [] } }],
    ["Web malformed named entry", "web", { ...hubWebExtension, contributes: { fullPages: [{ id: "page", title: "Page", entry: "page.html", unknown: true }] } }],
    ["Web unsafe entry", "web", { ...hubWebExtension, entry: "../index.html" }],
    ["Assistant unknown field", "assistant", { ...hubAssistant, unknown: true }],
    ["Assistant malformed model", "assistant", { ...hubAssistant, model: { provider: "openai", modelId: "gpt-5", unknown: true } }],
    ["Assistant duplicate tool", "assistant", { ...hubAssistant, tools: ["read", "read"] }],
    ["Assistant malformed TTS", "assistant", { ...hubAssistant, tts: { autoSpeak: "yes" } }],
    ["OpenHouse missing title", "openhouse", omit(hubOpenHouseSmallphone, "title")],
    ["OpenHouse invalid kind", "openhouse", { ...hubOpenHouseSmallphone, kind: "page" }],
    ["OpenHouse missing display surface", "openhouse", omit(omit(hubOpenHouseSmallphone, "smallphoneApp"), "shellMenu")],
    ["OpenHouse malformed display surface", "openhouse", { ...hubOpenHouseSmallphone, smallphoneApp: { visible: true } }],
    ["OpenHouse invalid entry type", "openhouse", { ...hubOpenHouseSmallphone, smallphoneApp: { visible: true, entry: { type: "browser" } } }],
    ["Service flat hybrid", "service", { schemaVersion: 1, id: "fixture-service", name: "fixture-service", provider: "process", command: ["node"] }],
    ["Service unknown wrapper field", "service", { ...hubService, unknown: true }],
    ["Service unknown spec field", "service", { ...hubService, service: { ...hubService.service, unknown: true } }],
    ["Service whitespace provider", "service", { ...hubService, service: { ...hubService.service, provider: "   " } }],
    ["Service string command", "service", { ...hubService, service: { ...hubService.service, command: "node" } }],
    ["Service invalid restart", "service", { ...hubService, service: { ...hubService.service, restart: { mode: "sometimes", max_retries: -1 } } }],
    ["Service malformed repair", "service", { ...hubService, service: { ...hubService.service, repair: { mode: "script", env: { RETRIES: 2 } } } }],
    ["Service HTTP health without URL", "service", { ...hubService, service: { ...hubService.service, health: [{ type: "http", address: "127.0.0.1:1" }] } }],
    ["Service TCP health without address", "service", { ...hubService, service: { ...hubService.service, health: [{ type: "tcp", url: "http://127.0.0.1" }] } }],
    ["Service invalid port", "service", { ...hubService, service: { ...hubService.service, ports: [{ name: "http", preferred: 70000, dynamic: true, envVar: "bad-name" }] } }],
    ["MCP unknown field", "mcp", { ...hubMcpHttp, unknown: true }],
    ["stdio MCP with URL", "mcp", { ...hubMcpStdio, url: "https://example.com/mcp" }],
    ["HTTP MCP with command", "mcp", { ...hubMcpHttp, command: "node" }],
    ["MCP invalid auth", "mcp", { ...hubMcpHttp, auth: true }],
    ["MCP invalid secret map", "mcp", { ...hubMcpHttp, headerSecretRefs: { Authorization: 3 } }],
  ];
  for (const [name, type, value] of cases) {
    await context.test(name, () => assert.throws(() => validateCanonicalChildManifest(type, value, name)));
  }
});

test("Runtime preserves Hub semantic child validation around canonical schemas", async (context) => {
  const cases = [
    {
      name: "renderer without toolRenderers",
      contribution: { id: `${PACKAGE_ID}/renderer.fixture`, type: "wuxianpi.renderer", name: "Renderer", manifest: "web/renderer.json", contentTypes: ["fixture.result"] },
      files: { "web/renderer.json": { ...hubRendererOnly, entry: "index.html", contributes: {} }, "web/index.html": "index" },
      code: "invalid_renderer_manifest",
    },
    {
      name: "Web Extension exposing no entry",
      contribution: { id: `${PACKAGE_ID}/web.fixture`, type: "wuxianpi.webExtension", name: "Web", manifest: "web/web.json" },
      files: { "web/web.json": omit(omit(hubRendererOnly, "entry"), "contributes") },
      code: "invalid_web_manifest",
    },
    {
      name: "missing Web Extension entry file",
      contribution: { id: `${PACKAGE_ID}/web.fixture`, type: "wuxianpi.webExtension", name: "Web", manifest: "web/web.json" },
      files: { "web/web.json": hubWebExtension },
      code: "invalid_web_extension_manifest",
    },
    {
      name: "service wrapper id mismatch",
      contribution: { id: `${PACKAGE_ID}/service.fixture`, type: "service-manager.service", name: "Service", manifest: "service/service.json" },
      files: { "service/service.json": { ...hubService, id: "different-service" } },
      code: "invalid_service_manifest",
    },
    {
      name: "invalid Skill name",
      contribution: { id: `${PACKAGE_ID}/skill.fixture`, type: "pi.skill", name: "Skill", path: "skills/fixture" },
      files: { "skills/fixture/SKILL.md": "---\nname: Invalid Name\ndescription: A skill\n---\n" },
      code: "invalid_skill",
    },
    {
      name: "oversized Skill description",
      contribution: { id: `${PACKAGE_ID}/skill.fixture`, type: "pi.skill", name: "Skill", path: "skills/fixture" },
      files: { "skills/fixture/SKILL.md": `---\nname: fixture\ndescription: ${"x".repeat(1025)}\n---\n` },
      code: "invalid_skill",
    },
  ];
  for (const item of cases) {
    await context.test(item.name, async () => {
      const root = await packageFixture([item.contribution], item.files);
      await assert.rejects(() => validatePackageManifest(root, baseManifest([item.contribution])), (error) => error.code === item.code);
    });
  }

  await context.test("Context JSON content is opaque just as it is in Hub", async () => {
    const contribution = { id: `${PACKAGE_ID}/context.fixture`, type: "wuxianpi.context", name: "Context", path: "context.json", format: "json" };
    const root = await packageFixture([contribution], { "context.json": "not json" });
    await assert.doesNotReject(() => validatePackageManifest(root, baseManifest([contribution])));
  });
});

function baseManifest(contributions) {
  return {
    schemaVersion: 1,
    id: PACKAGE_ID,
    name: "Child Fixture",
    version: "1.0.0",
    summary: "Canonical child fixture",
    categories: ["capability"],
    requires: { hostCapabilities: [], packages: [] },
    build: { mode: "none" },
    artifacts: [],
    contributions,
  };
}

async function packageFixture(contributions, files) {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-child-manifests-"));
  for (const [path, value] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
  await writeFile(join(root, "wuxianpi-package.json"), `${JSON.stringify(baseManifest(contributions), null, 2)}\n`);
  return root;
}

function omit(value, key) {
  const copy = structuredClone(value);
  delete copy[key];
  return copy;
}
