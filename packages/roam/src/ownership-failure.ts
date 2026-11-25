export const OWNERSHIP_FAILURE_CODES = [
  'ownership-unavailable', 'ownership-state-unavailable', 'ownership-boot-unavailable',
  'ownership-process-unavailable', 'ownership-unregistered-process', 'ownership-presence-live',
  'ownership-handoff-pending', 'ownership-lock-lost', 'ownership-file-live', 'ownership-lock-unavailable',
] as const;
export type OwnershipFailureCode = typeof OWNERSHIP_FAILURE_CODES[number];
export function ownershipFailureCode(value: unknown): OwnershipFailureCode | undefined {
  return typeof value === 'string' && (OWNERSHIP_FAILURE_CODES as readonly string[]).includes(value) ? value as OwnershipFailureCode : undefined;
}
export function ownershipControlFailure(error: unknown): OwnershipFailureCode | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'session-may-be-live') return 'ownership-file-live';
  if (code === 'session-id-owner' || code === 'lock-occupied' || code === 'lock-owner-uncertain') return 'ownership-lock-unavailable';
  return ownershipFailureCode(code);
}
export class OwnershipFailure extends Error {
  constructor(readonly code: OwnershipFailureCode) { super(code); this.name = 'OwnershipFailure'; }
}
export function ownershipRepair(code: OwnershipFailureCode): string {
  switch (code) {
    case 'ownership-unregistered-process':
      return 'A live Pi process has no identity-matched session registration. Quit unregistered Pi sessions normally, then retry cancellation. Do not delete ownership files.';
    case 'ownership-presence-live':
      return 'The session still has a live registered process without its ID lock. Quit that session normally, then retry cancellation. Do not delete ownership files.';
    case 'ownership-handoff-pending':
      return 'An unfinished session launch still owns the ID lock. Finish or quit that launch through its normal session shutdown path before retrying cancellation. Do not delete ownership files.';
    case 'ownership-file-live':
      return 'The session file may have a live owner. Quit its owning Pi session normally, then retry cancellation. Do not delete ownership files.';
    case 'ownership-lock-unavailable':
      return 'Another session action holds the ownership locks, or its owner cannot be verified. Finish that action or quit its Pi session normally before retrying cancellation.';
    case 'ownership-lock-lost':
      return 'The session ID claim changed during control. Finish the competing session action before retrying cancellation.';
    case 'ownership-state-unavailable':
      return 'Ownership records are unreadable or unsafe. Restore read access and private ownership modes on the existing records. Inspect malformed records before retrying cancellation. Do not delete ownership files.';
    default:
      return 'Restore local process and boot identity inspection before retrying cancellation. Do not delete ownership files.';
  }
}
