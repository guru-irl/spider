import { readStoredCredential } from "@earendil-works/pi-coding-agent";

/** Never resolves API keys, executes key commands, refreshes storage, or switches accounts. */
export function readCopilotOAuthToken(authPath: string): string | undefined {
  const credential = readStoredCredential("github-copilot", authPath);
  if (credential?.type !== "oauth") return undefined;
  const refresh = credential.refresh;
  return typeof refresh === "string" && refresh.trim().length > 0 ? refresh : undefined;
}
