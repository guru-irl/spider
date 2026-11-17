import type { IntercomConnectorRecipe } from "./contracts";
import { parseConnectorRecipe } from "./config";

export type ConnectorStatus = "ready" | "intercom-peer-consent-required" | "intercom-connector-recipe-missing" |
  "intercom-connector-recipe-invalid" | "intercom-connector-missing" | "intercom-connector-sign-in-required" |
  "intercom-tunnel-unhosted" | "intercom-peer-port-unreachable" | "intercom-connector-check-invalid" | "connector-not-pair-scoped";
export interface ConnectorRunner {
  consent: boolean;
  run(argv: readonly string[], options: { timeoutMs: number; maxBytes: number }): Promise<{ code: number; stdout: string }>;
}
const options = { timeoutMs: 10_000, maxBytes: 16 * 1024 } as const;
function prepared(value: IntercomConnectorRecipe | undefined, ports: ConnectorRunner): IntercomConnectorRecipe | ConnectorStatus {
  if (!ports.consent) return "intercom-peer-consent-required";
  if (!value) return "intercom-connector-recipe-missing";
  try { return parseConnectorRecipe(value); } catch { return "intercom-connector-recipe-invalid"; }
}
function observation(value: unknown): ConnectorStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "intercom-connector-check-invalid";
  const item = value as Record<string, unknown>, fields = ["connector", "login", "tunnel", "peerPort"];
  if (Object.keys(item).length !== fields.length || !fields.every(field => Object.hasOwn(item, field)) ||
      !["ready", "missing", "unknown"].includes(String(item.connector)) || !["ready", "required", "unknown"].includes(String(item.login)) ||
      !["hosted", "unhosted", "unknown"].includes(String(item.tunnel)) || !["reachable", "unreachable", "unknown"].includes(String(item.peerPort))) {
    return "intercom-connector-check-invalid";
  }
  if (item.connector === "missing") return "intercom-connector-missing";
  if (item.login === "required") return "intercom-connector-sign-in-required";
  if (item.tunnel === "unhosted") return "intercom-tunnel-unhosted";
  if (item.peerPort === "unreachable") return "intercom-peer-port-unreachable";
  return item.connector === "ready" && item.login === "ready" && item.tunnel === "hosted" && item.peerPort === "reachable"
    ? "ready" : "intercom-connector-check-invalid";
}
/** The configured check command must be observational and return the four named status fields as JSON. */
export async function checkConnector(value: IntercomConnectorRecipe | undefined, ports: ConnectorRunner): Promise<{ status: ConnectorStatus }> {
  const recipe = prepared(value, ports); if (typeof recipe === "string") return { status: recipe };
  try {
    const result = await ports.run(recipe.check, options);
    if (result.code !== 0 || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > options.maxBytes) return { status: "intercom-connector-check-invalid" };
    return { status: observation(JSON.parse(result.stdout) as unknown) };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "intercom-connector-missing" : "intercom-connector-check-invalid" };
  }
}
/** A foreground recipe cannot prove pair-scoped connection closure, so never start it. */
export async function runConnectorStep(value: IntercomConnectorRecipe | undefined, _step: "host" | "connect", ports: ConnectorRunner): Promise<{ status: ConnectorStatus }> {
  const recipe = prepared(value, ports); if (typeof recipe === "string") return { status: recipe };
  return { status: "connector-not-pair-scoped" };
}
