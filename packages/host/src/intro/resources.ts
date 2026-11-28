import { relative } from "node:path";
import type { ExtensionAPI, ExtensionContext, SourceInfo, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type ReaderDocument, type ReaderTab, type StartupResourceCounts } from "@spider/ui";

interface ResourceItem { name: string; path: string; scope: SourceInfo["scope"] }
interface Resources {
  prompt?: string;
  contexts?: string[];
  skills: ResourceItem[];
  extensions: ResourceItem[];
  prompts: ResourceItem[];
}

type ResourceTheme = Pick<Theme, "fg" | "bold" | "style" | "colors">;

function literal(text: string): string {
  return stripTerminalSequences(text).replace(/\r\n/gu, "\n").replace(/\t/gu, "    ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/gu, "");
}

function displayedPath(path: string, base?: string): string {
  const relativePath = base ? relative(base, path) : "";
  return literal(relativePath && !relativePath.startsWith("..") ? relativePath : path);
}

function item(name: string, source: SourceInfo): ResourceItem {
  return { name: literal(name), scope: source.scope, path: displayedPath(source.path, source.baseDir) };
}

export function observeResources(pi: ExtensionAPI, ctx: ExtensionContext): Resources {
  const commands = pi.getCommands?.() ?? [];
  const skills: ResourceItem[] = [], prompts: ResourceItem[] = [];
  const extensions = new Map<string, ResourceItem>();
  const extension = (source?: SourceInfo) => {
    if (!source?.path || source.path.startsWith("builtin:") || extensions.has(source.path)) return;
    extensions.set(source.path, item("", source));
  };
  for (const command of commands) {
    if (!command.sourceInfo?.path) continue;
    if (command.source === "extension") extension(command.sourceInfo);
    else if (command.source === "skill") skills.push(item(command.name.replace(/^skill:/u, ""), command.sourceInfo));
    else if (command.source === "prompt") prompts.push(item(command.name, command.sourceInfo));
  }
  for (const tool of pi.getAllTools?.() ?? []) extension(tool.sourceInfo);

  const text = ctx.getSystemPrompt?.();
  // The host exposes the effective prompt here, not the resource loader. Use
  // the stable project instructions section instead of reading AGENTS files again.
  const project = text?.match(/(?:^|\n)<project_context>\n([\s\S]*?)\n<\/project_context>(?:\n|$)/u)?.[1];
  const contexts = text === undefined ? undefined : [...new Set([...(project ?? "").matchAll(/^<project_instructions path="(.*)">$/gmu)]
    .map(match => displayedPath(match[1]!, ctx.cwd)))];
  return { prompt: text === undefined ? undefined : literal(text), contexts, skills, prompts, extensions: [...extensions.values()] };
}

export function resourceCounts(resources: Resources): StartupResourceCounts {
  return { context: resources.contexts?.length, skills: resources.skills.length, prompts: resources.prompts.length,
    extensions: resources.extensions.length, promptTokens: resources.prompt === undefined ? undefined : Math.ceil(resources.prompt.length / 4) };
}

function tabsList(items: ResourceItem[], theme: ResourceTheme): string[] {
  const lines: string[] = [];
  for (const scope of ["user", "project", "temporary"] as const) {
    const group = items.filter(item => item.scope === scope);
    if (!group.length) continue;
    if (lines.length) lines.push("");
    lines.push(theme.bold(scope[0]!.toUpperCase() + scope.slice(1)));
    for (const { name, path } of group) lines.push(name ? theme.fg("text", name) + theme.fg("dim", `  ${path}`) : theme.fg("text", path));
  }
  return lines;
}

export function resourcesDocument(resources: Resources, theme: ResourceTheme): ReaderDocument {
  const { prompt, contexts, skills, extensions, prompts } = resources;
  const counts = resourceCounts(resources);
  const estimate = counts.promptTokens === undefined ? undefined
    : `~${counts.promptTokens < 1000 ? counts.promptTokens : `${(counts.promptTokens / 1000).toFixed(1)}k`}`;
  const tab = (label: string, count: ReaderTab["count"], note: string, body: string[]): ReaderTab => ({
    label, count,
    content: {
      render: width => [theme.bold(label), theme.fg("dim", note), "", ...body].flatMap(line => wrapTextWithAnsi(line, width)),
      invalidate() {},
    },
  });
  const system: ReaderTab = {
    label: "System prompt", count: estimate,
    content: {
      render(width) {
        const source = prompt?.split("\n") ?? ["System prompt unavailable."];
        const digits = String(source.length).length;
        const prefix = width >= digits + 4 ? digits + 1 : 0;
        const heading = [theme.bold("System prompt") + (estimate ? theme.fg("dim", `  ${estimate} estimated tokens`) : ""),
          theme.fg("dim", "Effective Pi prompt · captured when this reader opened"), ""];
        const rows = source.flatMap((line, i) => wrapTextWithAnsi(line, width - prefix).map((part, row) => {
          const number = !prefix ? "" : row === 0 ? theme.fg("dim", String(i + 1).padStart(digits) + " ") : " ".repeat(prefix);
          return theme.style(truncateToWidth(number + part, width, "", true), { bg: theme.colors.customMessageBg });
        }));
        return [...heading.flatMap(line => wrapTextWithAnsi(line, width)), ...rows];
      },
      invalidate() {},
    },
  };
  return { title: "Loaded resources", tabs: [system,
    tab("Context files", counts.context, "Project instructions listed in the effective prompt", contexts?.length ? contexts : ["No project instruction paths exposed."]),
    tab("Skills", counts.skills, "Skills exposed by Pi", skills.length ? tabsList(skills, theme) : ["No skills loaded."]),
    tab("Extensions", `≥${counts.extensions}`, "Extensions that expose tools or commands. Pi does not list hook-only extensions here.",
      extensions.length ? tabsList(extensions, theme) : ["No extension paths exposed."]),
    tab("Prompt templates", counts.prompts, "Prompt templates exposed by Pi", prompts.length ? tabsList(prompts, theme) : ["No prompt templates loaded."]),
  ] };
}
