import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { paths } from "@spider/db-core";
import { join } from "node:path";
import { LOADED_BUILD } from "../build-id.js";
import { readLayer } from "../control.js";
import { readUsageConfig } from "./config.js";
import { resolveUsageRoots } from "./mount.js";
import { ensureUsageServer } from "./server-runtime.js";

/** Only an explicit parent TUI command opens a browser. Registration and reload are inert. */
export function registerUsageDashboardCommand(pi: ExtensionAPI, bundleUrl: string | URL): void {
  const widgetKey = "spider-usage-url";
  let clearWidget: (() => void) | undefined;
  const clearFallback = () => { clearWidget?.(); clearWidget = undefined; };
  pi.on("session_shutdown", clearFallback);
  function showFallback(ctx: ExtensionCommandContext, url: string, timedOut: boolean): void {
    if (ctx.hasUI) {
      ctx.ui.setWidget(widgetKey, [`Open the usage dashboard: ${url}`, "This link works once and expires in 60 s"]);
      const timer = setTimeout(clearFallback, 60_000);
      timer.unref?.();
      clearWidget = () => { clearTimeout(timer); ctx.ui.setWidget(widgetKey, undefined); };
      ctx.ui.notify("Open the usage dashboard using the link below", timedOut ? "info" : "error");
    }
  }
  pi.registerCommand("usage", {
    description: "Open the local usage dashboard",
    handler: async (args, ctx) => {
      if (process.env.PI_SUBAGENT_CHILD === "1" || ctx.mode !== "tui" || !ctx.hasUI) {
        if (!ctx.hasUI) process.stderr.write("/usage works only in an interactive session\n");
        else ctx.ui.notify("Run /usage in a parent interactive session", "warning");
        return;
      }
      if (args.trim()) { ctx.ui.notify("Run /usage without arguments", "warning"); return; }
      clearFallback();
      try {
        const calibrationConfigFile = join(paths.globalRoot, "config.json");
        const calibrationMode = readUsageConfig(readLayer(calibrationConfigFile).config, {}).value.calibration;
        // Do not cache this result: reuse must mint a new, single-use bootstrap nonce.
        const server = await ensureUsageServer({ bundleUrl, roots: resolveUsageRoots(),
          lockFile: join(paths.globalRoot, "usage-server", "lock.json"), calibrationMode, calibrationConfigFile,
          serverBuild: `${LOADED_BUILD.sha}@${LOADED_BUILD.builtAt}` });
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        try {
          const opened = await pi.exec(opener, [server.bootstrapUrl], { timeout: 5000, cwd: join(paths.globalRoot, "usage-server") });
          if (opened.killed) {
            showFallback(ctx, server.bootstrapUrl, true);
            return;
          }
          if (opened.code !== 0) throw new Error("usage-browser-failed");
        } catch {
          showFallback(ctx, server.bootstrapUrl, false);
          return;
        }
        // Never put nonce URLs or subprocess output in a notification or transcript.
        ctx.ui.notify(`Usage dashboard opened (${server.serverBuild}; rates: ${server.rateVersions.join(", ") || "unavailable"})`, "info");
      } catch {
        ctx.ui.notify("Usage dashboard could not open. Run /doctor for diagnostics", "error");
      }
    },
  });
}
