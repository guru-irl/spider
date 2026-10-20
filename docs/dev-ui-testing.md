# Spider / realtime dev loop + manual UI test plan

This page describes a live loop for working on the subagents UI (the footer and the alt+shift+up selector) against a real pi.

## How the loop works
- Vite 8 (Rolldown + Oxc) bundles `packages/host/src/extension.ts` into `dist/extension.js`
  directly from the TS source. `npm run dev` runs `vite build --watch`, which rebuilds on save (about 40 ms).
- A global dev shim at `~/.pi/agent/extensions/spider-dev.ts` loads the bundle. Pi discovers it on its own,
  and because it is global, pi shows no project-trust prompt. The shim imports the built bundle dynamically
  **with a cache-buster**, so pi's `/reload` always runs the latest build. It points at `/mnt/data/src/spider/dist/extension.js`.
- After you save and vite rebuilds, type `/reload` in pi. You do not need to restart.

> The shim is for development only, and it is global, so spider loads in every pi session. Remove it when you finish:
> `rm ~/.pi/agent/extensions/spider-dev.ts`

## One-time setup
1. `npm run dev:link` installs the global dev shim (`~/.pi/agent/extensions/spider-dev.ts`).
2. `npm run build` produces a first `dist/extension.js`, so the shim has something to import.
3. In terminal 1, at the repo root, run `npm run dev` and leave it running. It rebuilds on every save.
4. In terminal 2, run `pi` in any project you want to test in. A real repo gives subagents something useful to do.

## The loop
Edit a UI file. Vite rebuilds, and terminal 1 shows `built in NNms`. Type `/reload` in pi, then test again.

---

## Manual test checklist

### A. Extension loads
- [ ] In pi, ask: *"call the spider tool with action control, command doctor"*. It returns health output.
      This result proves that pi discovered the shim and that the shim loaded the bundle.

### B. Agents selector
- [ ] With no active agents, type `/agents`. A notification appears, and input is not captured.
- [ ] With an active agent, type `/agents`. The footer selection becomes active, and `Esc` closes it.
- [ ] Press **alt+shift+up**. The same selector opens. `/agents` is the fallback.
- [ ] Set `ui.footer=false`, start a new session and run `/agents`. A notice says the selector is disabled.

### C. Footer + selector with a LIVE agent
- [ ] Ask pi: *"use spider to run a subagent: action run, a single scout agent whose task is to list the
      files in this repo."* (Any real `spider run` works.)
- [ ] The **footer** appears above the editor. It shows the agent name, an animated spinner and a status glyph (◆ while running).
- [ ] Open the selector with `/agents`. The footer highlights a run.
- [ ] The arrow keys move the selection. **Enter** opens **AgentDetail**, and `Esc` returns to the footer.
- [ ] When the child finishes, the footer shows **✓** (done). It clears after the retention window.
- [ ] Start a run that fails (for example, a task that errors). The status shows **✗** (failed) or **⚠** (cancelled).

### D. Handoff edges (chain / pipeline)
- [ ] Ask: *"use spider to run a chain: step 1 a scout lists files, step 2 a worker summarizes step 1."*
- [ ] Inspect the runs in the footer, and their details, as stage 1 hands off to stage 2.

### E. renderResult (themed tool output)
- [ ] Run `spider remember` (to stage a memory), `recall`, and `search`. Each tool result renders as a
      themed **Panel** (a title and a body), not as raw JSON.

### F. Interactive /todos
- [ ] Type `/todos`. The overlay lists this session's todos.
- [ ] Press `a`. It toggles the **all-sessions** view, which adds todos from other sessions.
- [ ] Press `q` or `Esc` to close it.

### G. Realtime reload proof
- [ ] Edit a visible string, for example the spinner frames or a label in
      `packages/ui/src/agents/footer.ts` (or the glyph in `packages/ui/src/index.ts`).
- [ ] Terminal 1 shows `built in NNms`.
- [ ] In pi, run `/reload`, then open the footer or selector again. Your change is visible.

## Teardown
- Run `npm run dev:unlink`. It removes the global shim, so spider stops loading in every pi session.
- Press Ctrl-C to stop the `npm run dev` watcher.

## Notes / gotchas
- The footer is **session-scoped**. It shows only runs from the current pi session, so start runs
  from the same pi you are watching.
- Widgets exist only in **interactive** pi (not `-p` or `--mode rpc`), so run this loop in an interactive `pi`.
- If `/reload` does not show a change, check that terminal 1 rebuilt (save again), and that the
  shim still points at `dist/extension.js`.
