import Ajv2020Import, { type ValidateFunction } from "ajv/dist/2020.js";
import {
  ASSISTANT_TEMPLATE_SCHEMA, MCP_SERVER_SCHEMA, OPENHOUSE_APP_SCHEMA, SERVICE_MANAGER_SCHEMA,
  WEB_EXTENSION_SCHEMA,
} from "./child-manifest-schemas.js";
import { RequestError } from "./protocol.js";

const Ajv2020 = Ajv2020Import as unknown as new (options?: Record<string, unknown>) => {
  compile(schema: object): ValidateFunction;
};

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validators = {
  web: ajv.compile(WEB_EXTENSION_SCHEMA),
  assistant: ajv.compile(ASSISTANT_TEMPLATE_SCHEMA),
  openhouse: ajv.compile(OPENHOUSE_APP_SCHEMA),
  service: ajv.compile(SERVICE_MANAGER_SCHEMA),
  mcp: ajv.compile(MCP_SERVER_SCHEMA),
} as const;

export type CanonicalChildManifestType = keyof typeof validators;

export function validateCanonicalChildManifest(type: CanonicalChildManifestType, value: unknown, label: string): void {
  const validate = validators[type];
  if (validate(value)) return;
  const details = (validate.errors ?? []).map((item) => ({
    path: item.instancePath || "/",
    keyword: item.keyword,
    message: item.message ?? "is invalid",
  }));
  throw new RequestError(`invalid_${type}_manifest`, `${label} failed canonical Hub schema validation: ${formatErrors(validate)}`, { errors: details });
}

function formatErrors(validate: ValidateFunction): string {
  return (validate.errors ?? []).map((item) => `${item.instancePath || "/"} ${item.message ?? "is invalid"}`).join("; ");
}
