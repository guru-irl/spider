import { afterEach, describe, expect, it } from "vitest";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Editor, TuiAltScreen, TuiMainScreen, type EditorTheme, type Terminal } from "@earendil-works/pi-tui";
import { makeTodosCommand } from "../command";
import { addTodo } from "../store";
import { makeTodoDb } from "./helpers/tmpdb";

const identity = (text: string) => text;
const editorTheme: EditorTheme = {
  borderColor: identity,
  selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};

let db: ReturnType<typeof makeTodoDb> | undefined;
afterEach(() => { db?.cleanup(); db = undefined; });

function piFixture(mode: "regular" | "fullscreen") {
  initTheme("dark", false);
  let input: ((data: string) => void) | undefined;
  let output = "";
  const terminal: Terminal = {
    columns: 80, rows: 24, kittyProtocolActive: true,
    start(onInput) { input = onInput; }, stop() { input = undefined; },
    async drainInput() {}, write(data) { output += data; }, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  const tui = mode === "regular" ? new TuiMainScreen(terminal, false) : new TuiAltScreen(terminal, false);
  const editor = new Editor(tui, editorTheme);
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  tui.addChild(editorContainer);
  tui.setFocus(editor);

  // Exercise pi's actual custom-view lifecycle, including its non-overlay editor restore.
  const pi = Object.create(InteractiveMode.prototype) as {
    showExtensionCustom: (...args: any[]) => Promise<unknown>;
  };
  Object.assign(pi, { editor, editorContainer, ui: tui, keybindings: {}, disposeActiveSelector() {} });
  const command = makeTodosCommand({ getDb: () => db!.db, getSessionId: () => "current" });
  tui.start();
  return {
    editor,
    press(data: string) { input!(data); },
    open() { return command.handler("", { ui: { custom: pi.showExtensionCustom.bind(pi) } }); },
    render() { output = ""; tui.renderNow(true); return output; },
    stop() { tui.stop(); },
  };
}

describe("Todos draft cursor", () => {
  it.each([
    { mode: "regular", close: "q", draft: "before 日本 after", left: 3, expected: "before 日本 af!ter" },
    { mode: "fullscreen", close: "\x1b[27u", draft: "before 日本 after", left: 3, expected: "before 日本 af!ter" },
    { mode: "regular", close: "\x1b", draft: "first line\n多字👩‍💻e\u0301Z", left: 2, expected: "first line\n多字👩‍💻!e\u0301Z" },
    { mode: "fullscreen", close: "\x03", draft: "first line\n多字👩‍💻e\u0301Z", left: 2, expected: "first line\n多字👩‍💻!e\u0301Z" },
  ] as const)("keeps the cursor after closing in $mode mode with $close", async ({ mode, close, draft, left, expected }) => {
    db = makeTodoDb();
    addTodo(db.db, "current", "current task");
    addTodo(db.db, "other", "other task");
    const pi = piFixture(mode);
    try {
      pi.editor.setText(draft);
      for (let i = 0; i < left; i++) pi.press("\x1b[D");
      const opened = pi.open();
      await Promise.resolve();
      expect(pi.render()).toContain("current task");
      pi.press("a");
      expect(pi.render()).toContain("other task");
      pi.press(close);
      await opened;
      pi.press("!");
      expect(pi.editor.getText()).toBe(expected);
    } finally {
      pi.stop();
    }
  });

  it.each(["regular", "fullscreen"] as const)("keeps long lists accessible and the cursor intact in %s mode", async (mode) => {
    db = makeTodoDb();
    for (let i = 1; i <= 30; i++) addTodo(db.db, "current", `task-${String(i).padStart(2, "0")}`);
    const pi = piFixture(mode);
    try {
      pi.editor.setText("before 日本 after");
      for (let i = 0; i < 3; i++) pi.press("\x1b[D");
      const opened = pi.open();
      await Promise.resolve();
      expect(pi.render()).toContain("task-01");
      expect(pi.render()).toContain("Esc to close");
      pi.press("\x1b[6~"); // Page Down
      expect(pi.render()).toContain("task-30");
      expect(pi.render()).toContain("Esc to close");
      pi.press("\x1b[A"); // Up
      expect(pi.render()).not.toContain("task-30");
      pi.press("\x1b[B"); // Down
      expect(pi.render()).toContain("task-30");
      pi.press("a");
      expect(pi.render()).toContain("task-01");
      pi.press("\x1b[6~"); // Page Down in all sessions
      expect(pi.render()).toContain("task-30");
      pi.press("\x1b[5~"); // Page Up
      expect(pi.render()).toContain("task-01");
      pi.press("\x1b[27u");
      await opened;
      pi.press("!");
      expect(pi.editor.getText()).toBe("before 日本 af!ter");
    } finally {
      pi.stop();
    }
  });
});
