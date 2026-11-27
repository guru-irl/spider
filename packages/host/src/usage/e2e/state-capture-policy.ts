export function shouldCaptureState(width: number, name: string): boolean {
  return width !== 1440 || name !== 'session-default';
}
