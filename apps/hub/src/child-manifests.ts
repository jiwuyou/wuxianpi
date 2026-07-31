const safePath = {
  type: "string",
  minLength: 1,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$",
} as const;

const namedEntry = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "entry"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 120 },
    title: { type: "string", minLength: 1, maxLength: 160 },
    entry: safePath,
  },
} as const;

export const WEB_EXTENSION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "name", "version", "apiVersion"],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
    name: { type: "string", minLength: 1, maxLength: 160 },
    version: { type: "string", minLength: 1, maxLength: 64 },
    apiVersion: { const: "1" },
    description: { type: "string" },
    entry: safePath,
    permissions: {
      type: "array",
      uniqueItems: true,
      items: { enum: ["assistant.read", "storage.read", "storage.write", "tts.speak", "tools.call", "ui.notify", "ui.resize", "ui.close"] },
    },
    contributes: {
      type: "object",
      additionalProperties: false,
      properties: {
        fullPages: { type: "array", items: namedEntry },
        settingsPanels: { type: "array", items: namedEntry },
        assistantEditorTabs: { type: "array", items: namedEntry },
        chatActions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 120 },
              title: { type: "string", minLength: 1, maxLength: 160 },
              icon: { type: "string", minLength: 1, maxLength: 120 },
            },
          },
        },
        toolRenderers: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["toolPattern", "entry"],
            properties: {
              toolPattern: { type: "string", minLength: 1, maxLength: 240 },
              entry: safePath,
            },
          },
        },
      },
    },
  },
} as const;

const inheritOrStrings = {
  oneOf: [
    { const: "inherit" },
    { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
  ],
} as const;

export const ASSISTANT_TEMPLATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "name"],
  properties: {
    schemaVersion: { const: 1 },
    name: { type: "string", minLength: 1, maxLength: 160 },
    description: { type: "string" },
    avatar: { type: "string", minLength: 1 },
    greeting: { type: "string" },
    starterPrompts: { type: "array", items: { type: "string", minLength: 1 } },
    model: {
      oneOf: [
        { const: "inherit" },
        {
          type: "object",
          additionalProperties: false,
          required: ["provider", "modelId"],
          properties: {
            provider: { type: "string", minLength: 1 },
            modelId: { type: "string", minLength: 1 },
          },
        },
      ],
    },
    thinkingLevel: { type: "string", minLength: 1 },
    tools: inheritOrStrings,
    skills: inheritOrStrings,
    mcpServers: inheritOrStrings,
    webExtensions: inheritOrStrings,
    tts: {
      oneOf: [
        { const: "inherit" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            profileId: { type: "string", minLength: 1 },
            autoSpeak: { type: "boolean" },
            rate: { type: "number" },
            pitch: { type: "number" },
            readCode: { type: "boolean" },
          },
        },
      ],
    },
    archived: { type: "boolean" },
  },
} as const;

const openHouseEntry = {
  type: "object",
  additionalProperties: true,
  required: ["type"],
  properties: {
    type: { enum: ["webview", "service-control", "native"] },
    url: { type: "string", minLength: 1 },
    serviceNames: { type: "array", items: { type: "string", minLength: 1 } },
    serviceRefs: { type: "array", items: { type: "string", pattern: "^service-manager://" } },
  },
} as const;

const openHouseSurface = {
  type: "object",
  additionalProperties: true,
  required: ["visible", "entry"],
  properties: {
    visible: { type: "boolean" },
    section: { type: "string", minLength: 1 },
    order: { type: "number" },
    icon: { type: "string", minLength: 1 },
    entry: openHouseEntry,
    controlEntry: openHouseEntry,
  },
} as const;

export const OPENHOUSE_APP_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["schemaVersion", "id", "title", "kind"],
  anyOf: [{ required: ["shellMenu"] }, { required: ["smallphoneApp"] }],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", minLength: 1, maxLength: 160 },
    title: { type: "string", minLength: 1, maxLength: 160 },
    description: { type: "string" },
    kind: { const: "app" },
    shellMenu: openHouseSurface,
    smallphoneApp: openHouseSurface,
    serviceManager: {
      type: "object",
      additionalProperties: true,
      required: ["required", "services"],
      properties: {
        required: { type: "boolean" },
        services: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["name"],
            properties: { name: { type: "string", minLength: 1 } },
          },
        },
      },
    },
    ai: { type: "object" },
  },
} as const;

const duration = {
  oneOf: [
    { type: "string", minLength: 1 },
    { type: "integer", minimum: 0 },
    { type: "null" },
  ],
} as const;

const SERVICE_SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "provider", "command"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
    description: { type: "string" },
    provider: { type: "string", minLength: 1, pattern: ".*\\S.*" },
    command: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    working_dir: { type: "string" },
    env: { type: "object", additionalProperties: { type: "string" } },
    runtime: { type: "object", additionalProperties: true },
    restart: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { enum: ["no", "on-failure", "always"] },
        max_retries: { type: "integer", minimum: 0, maximum: 2147483647 },
      },
    },
    repair: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        mode: { enum: ["hook", "script"] },
        command: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        working_dir: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
        timeout: duration,
      },
    },
    health: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: { enum: ["http", "tcp"] },
          url: { type: "string", minLength: 1 },
          address: { type: "string", minLength: 1 },
          interval: duration,
          timeout: duration,
        },
        allOf: [
          { if: { properties: { type: { const: "http" } } }, then: { required: ["url"] } },
          { if: { properties: { type: { const: "tcp" } } }, then: { required: ["address"] } },
        ],
      },
    },
    ports: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "preferred", "dynamic", "envVar"],
        properties: {
          name: { type: "string", minLength: 1 },
          host: { type: "string", minLength: 1 },
          preferred: { type: "integer", minimum: 1, maximum: 65535 },
          dynamic: { type: "boolean" },
          pool: { type: "string", minLength: 1 },
          protocol: { enum: ["tcp", "udp"] },
          envVar: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
          endpoint: {
            type: "object",
            additionalProperties: false,
            properties: {
              scheme: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9+.-]*$" },
              path: { type: "string", pattern: "^/" },
            },
          },
        },
      },
    },
    enabled: { type: "boolean" },
    residentByDefault: { type: "boolean" },
    tags: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

export const SERVICE_MANAGER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "service"],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
    service: SERVICE_SPEC_SCHEMA,
  },
} as const;
