import type { Diagnostic } from "./contracts";
import type { CorePinStatus } from "./enrollment";

export function corePinDiagnostics(status: CorePinStatus, target: string): Diagnostic[] {
  const provision = `spider roam provision ${target}`;
  switch (status) {
    case "ready": return [];
    case "core-pin-required": return [{ severity: "block", reason: "core-pin-required: Reprovision this box on the hub to enroll its core.", repairCommand: provision }];
    case "core-pin-invalid": return [{ severity: "block", reason: "core-pin-invalid: The core pin is unsafe or unreadable. Inspect its ownership, mode and contents before reprovisioning.", repairCommand: null }];
    case "core-pin-changed": return [{ severity: "block", reason: "core-pin-changed: The pinned core identity changed. Stop hosting, move sessions off the box and replace the pin explicitly.", repairCommand: `${provision} --replace-core-pin` }];
    case "core-pin-unreachable": return [{ severity: "warning", reason: "core-pin-unreachable: The pinned core is not answering. The supervisor starts a stopped pinned core.", repairCommand: null }];
  }
}
