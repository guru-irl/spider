// One definition of "this run was cancelled because the session is going away", shared by the
// code that writes the reason (coordinators, registry) and the code that reads it (the async
// completion notifier, which must not start a model turn through a dying pi). Both sides use
// these helpers, so a new kind cannot be written without the notifier recognising it.

export const SHUTDOWN_KINDS = ["quit", "reload"] as const;
export type ShutdownKind = (typeof SHUTDOWN_KINDS)[number];

const PREFIX = "Session shutdown";

/** The cancellation reason recorded on a run killed by a shutdown of the given kind.
 *  "quit" keeps the exact text it has always had (quit, new, resume and fork all use it). */
export function shutdownReason(kind: ShutdownKind): string {
  return kind === "reload" ? `${PREFIX} (reload) cancelled this run.` : `${PREFIX} cancelled this run.`;
}

/** True when `text` is a reason produced by shutdownReason (possibly with a suffix appended). */
export function isShutdownReason(text: string | null | undefined): boolean {
  return typeof text === "string" && text.startsWith(PREFIX);
}
