import type { Admission } from "./admission.js";

/** A gate belongs to one activation, even when a host runs several sessions. */
export function ordinaryWorkAllowed(admission: Admission): boolean {
  return admission.kind === "ordinary";
}
