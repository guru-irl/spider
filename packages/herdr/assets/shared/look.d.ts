export function identityPill(name: string, theme: Record<string, string>): { background: string; text: string } | null;
export function assignSpaceIdentities(spaces: readonly { id: string; name: string }[]): Map<string, { shape: string }>;
