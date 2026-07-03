# Spider — realtime dev loop + manual UI test plan

A live loop for iterating on the subagents UI (footer + Ctrl+Shift+G grid) against a real pi.

## How the loop works
- **Bundler:** Vite 8 (Rolldown + Oxc) builds `packages/host/src/extension.ts` → `dist/extension.js`
  straight from TS source. `npm run dev` = `vite build --watch` rebuilds on save (~40 ms).
- **Loader:** a global dev shim at `~/.pi/agent/extensions/spider-dev.ts` (auto-discovered by pi;
  global = no project-trust prompt) dynamically imports the built bundle **with a cache-buster**, so
  pi's `/reload` always runs the freshly-built code. It points at `/mnt/data/src/spider/dist/extension.js`.
- **Reload:** after a save (vite rebuilds), type `/reload` in pi — no restart needed.

> The shim is DEV-ONLY and global (spider loads in every pi session). Remove it when done:
> `rm ~/.pi/agent/extensions/spider-dev.ts`

## One-time setup
1. `npm run dev:link`  ← installs the global dev shim (`~/.pi/agent/extensions/spider-dev.ts`).
2. `npm run build`     ← produce an initial `dist/extension.js` (so the shim has something to import).
3. Terminal 1 (repo root): `npm run dev`  ← leave running (rebuild-on-save watch).
4. Terminal 2: `pi`  ← run in any project you want to test in (a real repo makes subagents useful).

## The loop
edit a UI file → vite rebuilds (Terminal 1 shows `built in NNms`) → in pi type `/reload` → re-test.

---

## Manual test checklist

### A. Extension loads
- [ ] In pi, ask: *"call the spider tool with action control, command doctor"* → returns health output.
      (Definitive: it means discovery + the shim loaded the bundle.)

### B. Grid overlay (no agents required)
- [ ] Type `/agents` → the agents **grid overlay** opens (empty "no agents" state is fine).
- [ ] Press `q` or `Esc` → it closes.
- [ ] Press **Ctrl+Shift+G** → grid toggles. (`ctrl+g` alone is pi's built-in external-editor
      binding; we use `ctrl+shift+g` to avoid the conflict. `/agents` is the always-available fallback.)

### C. Footer + grid with a LIVE agent
- [ ] Ask pi: *"use spider to run a subagent — action run, a single scout agent whose task is to list the
      files in this repo."* (Any real `spider run` works.)
- [ ] The **footer** appears above the editor: agent name + animated spinner + status glyph (◆ running).
- [ ] Open the grid (`/agents`): the agent shows as a **cell** (header + activity tail + progress).
- [ ] Arrow keys move focus; **Enter** drills into the full-screen **AgentDetail**; `Esc` returns to grid.
- [ ] When the child finishes: footer/cell show **✓** (done); after the retention window the footer clears.
- [ ] Trigger a failing run (e.g. task that errors) → status shows **✗** (failed) / **⚠** (cancelled).

### D. Handoff edges (chain / pipeline)
- [ ] Ask: *"use spider to run a chain: step 1 a scout lists files, step 2 a worker summarizes step 1."*
- [ ] In the grid, a **handoff edge** renders between the two agents as stage 1 hands to stage 2.

### E. renderResult (themed tool output)
- [ ] Run `spider remember` (stage a memory), `recall`, and `search` → each tool result renders as a
      themed **Panel** (title + body), not raw JSON.

### F. Interactive /todos
- [ ] Type `/todos` → overlay lists this session's todos.
- [ ] Press `a` → toggles the **all-sessions** view (todos from other sessions appear).
- [ ] `q` / `Esc` → closes.

### G. Realtime reload proof
- [ ] Edit a visible string, e.g. the spinner frames or a label in
      `packages/ui/src/agents/footer.ts` (or the glyph in `packages/ui/src/index.ts`).
- [ ] Terminal 1 shows `built in NNms`.
- [ ] In pi: `/reload`, then re-open the footer/grid → your change is visible.

## Teardown
- `npm run dev:unlink` (removes the global shim; stops loading spider in every pi session)
- Ctrl-C the `npm run dev` watcher.

## Notes / gotchas
- The footer is **session-scoped**: it only shows runs from the current pi session, so trigger runs
  from within the same pi you're watching.
- Widgets exist only in **interactive** pi (not `-p`/`--mode rpc`) — this loop must be an interactive `pi`.
- If `/reload` doesn't reflect a change, confirm Terminal 1 actually rebuilt (save again) and that the
  shim still points at `dist/extension.js`.
