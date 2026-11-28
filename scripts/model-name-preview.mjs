import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// Usage: node scripts/model-name-preview.mjs <output-directory>
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? ".");
process.env.COLORTERM = "truecolor";
const vite = await createServer({ root, configFile: false, server: { middlewareMode: true }, appType: "custom" });
try {
  const { AgentFooter } = await vite.ssrLoadModule("/packages/ui/src/agents/footer.ts");
  const { AgentStore } = await vite.ssrLoadModule("/packages/ui/src/agents/store.ts");
  const { piTheme } = await vite.ssrLoadModule("/packages/host/src/agents/theme-adapter.ts");
  const { createUsageFooter } = await vite.ssrLoadModule("/packages/host/src/usage/footer.ts");
  const { modelName } = await vite.ssrLoadModule("/packages/host/src/model-name.ts");
  const glass = JSON.parse(await readFile(join(root, "packages/herdr/assets/themes/dracula-plus-glass.json"), "utf8"));
  const colors = Object.fromEntries(Object.entries(glass.colors).map(([key, value]) => [key, glass.vars[value] ?? value]));
  const theme = new Theme(colors, colors, "truecolor");
  const models = [
    { provider: "github-copilot", id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { provider: "github-copilot", id: "gpt-6.2-sol", name: "GPT 6.2 Sol" },
  ];
  const registry = { getAll: () => models, find: (provider, id) => models.find(model => model.provider === provider && model.id === id) };
  const modelLabel = ref => modelName(registry, ref);
  const rows = [
    { id: "r1", name: "review", agent: "reviewer", model: "github-copilot/claude-opus-5.5", thinking: "xhigh" },
    { id: "r2", name: "implement", agent: "worker", model: "github-copilot/gpt-6.2-sol", thinking: "high" },
    { id: "r3", name: "investigate", agent: "scout", model: "custom/claude-unknown-model", thinking: "medium" },
  ].map((row, i) => ({ ...row, session_id: "preview", status: "running", started_at: 3000 - i, step_count: 3 + i, token_count: 0 }));
  const source = { listActive: () => rows, getRun: id => rows.find(row => row.id === id), subscribe: () => () => {} };
  const store = new AgentStore(source, () => 63000);
  store.start();
  const agents = new AgentFooter(store, piTheme(theme, "nerd", false, modelLabel), { now: () => 63000 });
  const footerInput = { cwd: "~/src/project", branch: "main", sessionName: "Model display names", modelId: "claude-opus-5.5", modelName: "Claude Opus 5.5", thinking: "xhigh", context: { percent: 14.6, contextWindow: 1000000 }, subscription: true,
    totals: { input: 3700, output: 1500, cacheRead: 12000, cacheWrite: 1000, piCost: 0, aic: 3.2, unpricedEntries: 0, aggregateEntries: 1, estimated: false, latestCacheHitRate: 90 },
    counter: { availability: "disabled", snapshot: null }, statuses: new Map(), iconStyle: "nerd" };
  const footer = createUsageFooter(() => footerInput, theme, { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} }, () => {});
  const width = 90, agentRows = agents.render(width), footerRows = footer.render(width);
  assert.equal(agentRows.length, 3);
  const plain = agentRows.map(stripTerminalSequences).join("\n") + "\n" + footerRows.map(stripTerminalSequences).join("\n");
  assert.match(plain, /Claude Opus 5\.5 · xhigh/);
  assert.match(plain, /GPT 6\.2 Sol · high/);
  assert.match(plain, /unknown-model · medium/);
  for (const line of [...agentRows, ...footerRows]) assert(visibleWidth(line) <= width);
  footer.dispose(); store.stop();

  function spans(row) {
    const state = { fg: "#d8dee9", bg: "transparent", bold: false, dim: false, italic: false };
    const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const emit = text => text ? `<span style="color:${state.fg};background:${state.bg};${state.bold ? "font-weight:700;" : ""}${state.dim ? "opacity:.55;" : ""}${state.italic ? "font-style:italic;" : ""}">${escape(text)}</span>` : "";
    let html = "", last = 0;
    for (const match of row.matchAll(/\x1b\[([0-9;]*)m/g)) {
      html += emit(row.slice(last, match.index));
      const codes = match[1].split(";").map(value => Number(value || 0));
      for (let i = 0; i < codes.length; i++) {
        const n = codes[i];
        if (n === 0) Object.assign(state, { fg: "#d8dee9", bg: "transparent", bold: false, dim: false, italic: false });
        else if (n === 1) state.bold = true;
        else if (n === 2) state.dim = true;
        else if (n === 3) state.italic = true;
        else if (n === 22) state.bold = state.dim = false;
        else if (n === 23) state.italic = false;
        else if (n === 39) state.fg = "#d8dee9";
        else if (n === 49) state.bg = "transparent";
        else if ((n === 38 || n === 48) && codes[i + 1] === 2) { state[n === 38 ? "fg" : "bg"] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
      }
      last = match.index + match[0].length;
    }
    return html + emit(row.slice(last));
  }
  const font = name => pathToFileURL(join(homedir(), "Library/Fonts", name)).href;
  const group = lines => lines.map(line => `<div class="row">${spans(line)}</div>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: caskaydia; src: url("${font("CaskaydiaCoveNerdFont-Regular.ttf")}"); }
@font-face { font-family: caskaydia; src: url("${font("CaskaydiaCoveNerdFont-Bold.ttf")}"); font-weight: 700; }
@font-face { font-family: caskaydia; src: url("${font("CaskaydiaCoveNerdFont-Italic.ttf")}"); font-style: italic; }
html, body { margin: 0; background: #161618; color: #d8dee9; }
main { padding: 28px 32px; font: 16px/24px caskaydia, monospace; }
.label { font: 12px/20px sans-serif; color: #848391; margin-bottom: 8px; }
.group { margin-bottom: 25px; } .row { white-space: pre; height: 24px; }
</style><main><div class="group"><div class="label">AGENT ROWS</div>${group(agentRows)}</div><div class="group"><div class="label">PI FOOTER</div>${group(footerRows)}</div></main>`;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "mname-preview.html"), html);
  await writeFile(join(out, "mname-preview-rows.json"), JSON.stringify({ agentRows, footerRows }, null, 2));
  console.log(plain);
} finally { await vite.close(); }
