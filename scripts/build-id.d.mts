export interface BuildMarker {
  sha: string;
  dirty: boolean;
  builtAt: string;
  version: string;
}
export interface BuildIdentity extends BuildMarker {}
export function captureBuildId(options: {
  version: string;
  cwd: string;
  now?: () => Date;
  git?: (args: string[]) => string;
}): BuildIdentity;
export function formatBuildId(identity: BuildMarker): string;
export function parseBuildId(text: string): BuildMarker | null;
