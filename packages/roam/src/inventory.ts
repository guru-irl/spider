import type { BootstrapPeer, Diagnostic, Transport } from "./contracts";
import { normalizeConfiguredClis, normalizeCoreUnit, sanitizeBootstrapError } from "./bootstrap-reply";
import type { BootstrapOptions, Inventory } from "./provision-contracts";

/** Prerequisites for installing a release, not evidence that hosting is ready. */
export function prerequisiteDiagnostics(value: Inventory, coreUnit?: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const block = (reason: string) => diagnostics.push({ reason, severity: "block", repairCommand: null });
  if (value.platform !== "linux") block("Linux is required for box hosting.");
  if (value.gitVersion === null) block("Git is required on the box.");
  if (!value.systemdUser) block("A systemd user service manager is required.");
  if (!value.core.unitOwned && !value.core.socketOwned) block("An existing Herdr core owned by this user is required.");
  if (!value.roaming.rootSafe) block("The roaming root or existing identity is unsafe or cannot be verified.");
  else if (value.roaming.identityExists && value.roaming.machineId === null) block("The existing roaming machine identity is invalid or unreadable.");
  if (coreUnit && (value.core.unit !== coreUnit || !value.core.unitExists || !value.core.unitOwned)) block("The configured core unit is missing or not owned by this user.");
  if (value.nodeVersion !== "22.23.4" && value.nodeVersion !== "26.4.0") {
    block("Node must be at least 22.19.0 and match a tested version, 22.23.4 or 26.4.0.");
  }
  return diagnostics;
}

export class InventoryError extends Error {
  readonly code = "missing-prerequisite";
  constructor(readonly observation: Inventory, readonly diagnostics: readonly Diagnostic[]) {
    super("Box prerequisites are not ready");
    this.name = "InventoryError";
  }
}

/** Resolve one enrolled peer and collect its read-only inventory. */
export async function inventory(peer: BootstrapPeer, transport: Transport, options?: BootstrapOptions): Promise<Inventory> {
  const coreUnit = normalizeCoreUnit(options?.coreUnit);
  const call = options && { ...options, configuredClis: normalizeConfiguredClis(options.configuredClis), ...(coreUnit ? { coreUnit } : {}) };
  let value: Inventory;
  try { value = await transport.bootstrapProbe(peer, "inventory", call); }
  catch (error) { throw sanitizeBootstrapError(error); }
  const diagnostics = prerequisiteDiagnostics(value, coreUnit ?? undefined);
  if (diagnostics.length) throw new InventoryError(value, diagnostics);
  return value;
}
