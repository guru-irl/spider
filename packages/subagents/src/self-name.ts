export function deriveRunName(input: { agent: string; role?: string; task?: string }): string {
  const parts = [input.role ?? input.agent];
  const taskSlug = (input.task ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 4).join("-");
  if (taskSlug) parts.push(taskSlug);
  return parts.join(":").slice(0, 48);
}
