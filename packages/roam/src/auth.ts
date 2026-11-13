import { basename, dirname } from "node:path";
import type { Journal, Peer } from "./contracts";
import { installPiAuthBytes, readPrivateBytes } from "./selected-files";

export class AuthError extends Error {
  readonly code: string;
  constructor(code: string) { super(`Cannot provision authentication (${code})`); this.name = "AuthError"; this.code = code; }
}
export interface AuthStage { file: string }
export interface AuthPorts {
  stage(bytes: Buffer): Promise<AuthStage>;
  install(stage: AuthStage, providers: readonly string[]): Promise<void>;
  /** A null handle also removes a partial stage from a failed stage call. */
  remove(stage: AuthStage | null): Promise<void>;
}

function providerList(value: readonly string[]): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64 ||
      value.some(name => typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name)) ||
      new Set(value).size !== value.length) throw new AuthError("invalid-providers");
  return [...value];
}

/** Consent is bound to the operation, target identity, and every provider. */
export function hasProvisionConsent(journal: Journal, operationId: string, peer: Peer, providers: readonly string[]): boolean {
  return journal.read(operationId).some(({ action, result }) => action === "provision-consent" && result.approved === true &&
    result.target === peer.alias && result.machineId === peer.machineId && Array.isArray(result.providers) &&
    providers.every(name => (result.providers as unknown[]).includes(name)));
}
function parseAuth(bytes: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid auth");
    return value as Record<string, unknown>;
  } catch { throw new AuthError("invalid-auth"); }
}
function rejectCommands(value: unknown): void {
  if (typeof value === "string" && value.startsWith("!")) throw new AuthError("unsupported-credential-command");
  if (Array.isArray(value)) for (const item of value) rejectCommands(item);
  else if (value && typeof value === "object") for (const item of Object.values(value)) rejectCommands(item);
}
function approvedAuth(bytes: Buffer, providers: readonly string[]): Buffer {
  const source = parseAuth(bytes), output: Record<string, unknown> = Object.create(null);
  for (const provider of providers) {
    if (!Object.hasOwn(source, provider) || !source[provider] || typeof source[provider] !== "object" || Array.isArray(source[provider])) {
      throw new AuthError("provider-unavailable");
    }
    rejectCommands(source[provider]);
    output[provider] = source[provider];
  }
  return Buffer.from(`${JSON.stringify(output)}\n`);
}

/** Read and transfer authentication only after target-and-provider consent. */
export async function copyPiAuth(input: {
  sourceRoot: string; peer: Peer; operationId: string; providers: readonly string[]; journal: Journal; maxBytes: number;
}, ports: AuthPorts): Promise<void> {
  const providers = providerList(input.providers);
  if (!hasProvisionConsent(input.journal, input.operationId, input.peer, providers)) throw new AuthError("consent-required");
  let original: Buffer | null;
  try { original = readPrivateBytes(input.sourceRoot, "auth.json", input.maxBytes); }
  catch { throw new AuthError("unsafe-auth"); }
  if (original === null) throw new AuthError("unsafe-auth");
  let bytes: Buffer;
  try { bytes = approvedAuth(original, providers); } finally { original.fill(0); }
  let stage: AuthStage | null = null, failed: string | null = null, cleanupFailed = false;
  try {
    stage = await ports.stage(bytes);
    await ports.install(stage, providers);
  } catch (error) {
    failed = error && typeof error === "object" && "code" in error && error.code === "operation-arguments-changed"
      ? "operation-arguments-changed" : "auth-install-failed";
  } finally {
    bytes.fill(0);
    try { await ports.remove(stage); } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) throw new AuthError("auth-cleanup-pending");
  if (failed) throw new AuthError(failed);
}

/** Merge only the approved staged providers, preserving destination credentials. */
export function installPiAuth(input: { destinationRoot: string; stagingRoot: string; stagedFile: string; providers: readonly string[] }): void {
  const providers = providerList(input.providers);
  if (dirname(input.stagedFile) !== input.stagingRoot) throw new AuthError("unsafe-auth");
  try {
    const staged = readPrivateBytes(input.stagingRoot, basename(input.stagedFile), 256 * 1024 * 1024);
    if (!staged) throw new AuthError("unsafe-auth");
    const received = parseAuth(staged);
    if (Object.keys(received).length !== providers.length || providers.some(provider => !Object.hasOwn(received, provider))) {
      throw new AuthError("invalid-auth");
    }
    const checked = approvedAuth(staged, providers);
    const existing = readPrivateBytes(input.destinationRoot, "auth.json", 256 * 1024 * 1024);
    const prior = existing ? parseAuth(existing) : Object.create(null) as Record<string, unknown>;
    const merged = Object.assign(Object.create(null), prior, parseAuth(checked));
    const bytes = Buffer.from(`${JSON.stringify(merged)}\n`);
    try { installPiAuthBytes(input.destinationRoot, bytes); }
    finally { staged.fill(0); checked.fill(0); existing?.fill(0); bytes.fill(0); }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("unsafe-auth");
  }
}
